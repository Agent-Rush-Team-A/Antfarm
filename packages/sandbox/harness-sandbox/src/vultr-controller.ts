/** Restart-safe cloud ownership, generation revocation, and snapshot-gated VM removal. */
import { randomBytes, randomUUID, createHash } from 'node:crypto'
import { rm } from 'node:fs/promises'
import { relative, isAbsolute } from 'node:path'
import { brandString } from '@deepseek-ai/dsh-brand'
import { WorkspaceId } from '@deepseek-ai/dsh-workspace'
import type { WorkspaceFileScope, WorkspaceFileListing, WorkspaceFileUpload,
  WorkspaceFileDownload } from '@deepseek-ai/dsh-fs/workspace-access'
import { listArtifacts, openArtifact, streamArtifact, artifactComponents, ArtifactFailure } from '@deepseek-ai/dsh-fs-local/workspace-artifacts'
import { SshWorkspaceFiles } from '@deepseek-ai/dsh-ssh/workspace-files'
import type { SandboxProgress, SandboxActivity } from './types.ts'
import type { WorkspaceSshRuntime } from './ssh-controller.ts'
import type { WorkspaceRuntimeFiles } from './backend.ts'
import type { WorkspaceSshServices } from './ssh-runtime.ts'
import { RunnerResponseError, type RunnerRunningSandbox, type RunnerSandboxStatus, type RunnerClosedSandbox,
  type SandboxContainerId } from './runner-client.ts'
import type { RunnerExecutionRequest, RunnerExecutionIdentity, RunnerExecutionResult, RunnerCancellationResult } from './execution.ts'
import { VultrApiError, type VultrApi, type VultrInstance } from './vultr-api.ts'
import { CloudWorkspaceStore, type CloudRecord } from './vultr-storage.ts'
import type { ResolvedConfig } from './vultr-config.ts'
import { delay, type VultrProvisioning } from './vultr-provision.ts'

interface Slot {
  record: CloudRecord
  revocation: AbortController
  operation?: { kind: 'open'; result: Promise<RunnerRunningSandbox> } | { kind: 'close'; result: Promise<RunnerClosedSandbox> }
}

/** Only the current deployment can operate its recorded instance and save identities. */
export class VultrWorkspaceController {
  private readonly slots = new Map<WorkspaceId, Slot>()
  private readonly lifetime = new AbortController()
  private readonly fileOperations = new Map<WorkspaceId, Set<Promise<unknown>>>()
  private readonly pending = new Set<Promise<unknown>>()
  private orphans = 0
  private readonly orphanWorkspaces = new Set<WorkspaceId>()
  private unassignedOrphan = false
  private stopping: Promise<void> | undefined

  /**
   * @param settings - Deployment budgets.
   * @param api - Authenticated cloud wire client.
   * @param store - Atomic durable owner.
   * @param runtime - Shared SSH execution controller.
   * @param provisioning - Verified SSH/helper preparation.
   * @param report - Visible sanitized failure reporting.
   */
  constructor(private readonly settings: ResolvedConfig, private readonly api: VultrApi, private readonly store: CloudWorkspaceStore,
    private readonly runtime: Pick<WorkspaceSshRuntime,
      'bind' | 'open' | 'status' | 'close' | 'pause' | 'files' | 'execute' | 'cancel' | 'binary' | 'releaseStopped' | 'dispose'>,
    private readonly provisioning: VultrProvisioning, private readonly report: (id: WorkspaceId,
      failure: CloudRecord['failure']) => void) {}

  /** Reconcile recorded resources after restart without creating or deleting anything. */
  async initialize(): Promise<void> {
    this.lifetime.signal.throwIfAborted()
    return this.track(this.reconcile())
  }

  private async reconcile(): Promise<void> {
    const records = await this.store.load()
    const instances = await this.api.instances(this.lifetime.signal)
    for (const record of records) {
      if (record.deploymentId !== this.settings.deploymentId
        || record.remoteRoot !== this.settings.remoteRoot) throw new Error('Cloud deployment configuration differs from persisted ownership')
      this.store.outside(record.project)
      const slot: Slot = { record, revocation: new AbortController() }
      this.slots.set(record.workspaceId, slot)
      const matches = instances.filter(instance => instance.label === record.label)
      if (matches.length > 1 || matches.some(instance => !this.owned(record, instance))) {
        await this.failed(slot, 'ownership'); continue
      }
      const matched = matches[0]
      if (record.instanceId === undefined
        && matched !== undefined) await this.commit(slot, { ...record, instanceId: matched.id, mutation: undefined })
      const current = slot.record
      if (current.instanceId !== undefined) {
        const instance = instances.find(candidate => candidate.id === current.instanceId)
        if (instance !== undefined && !this.owned(current, instance)) await this.failed(slot, 'ownership')
        else if (instance === undefined) {
          if ((current.phase === 'deleting' || current.resumePhase === 'deleting')
            && current.snapshotId !== undefined && current.cache !== undefined) {
            if ((await this.api.snapshot(current.snapshotId,
              this.lifetime.signal))?.status !== 'complete') { await this.failed(slot, 'resource_missing'); continue }
            await this.completeClosure(slot)
          } else await this.failed(slot, 'resource_missing')
        } else if (current.state === 'starting' || current.state === 'running') {
          // No execution receipt survives a new SSH connection.
          await this.commit(slot, { ...current, state: 'starting', phase: 'connecting' })
        }
      } else if (current.state !== 'closed') await this.failed(slot, 'interrupted')
    }
    const known = new Set([...this.slots.values()].flatMap(slot => slot.record.instanceId === undefined ? [] : [slot.record.instanceId]))
    const orphans = instances.filter(instance => instance.tags.includes(this.deploymentTag()) && !known.has(instance.id))
    this.orphans = orphans.length
    for (const instance of orphans) {
      const tags = instance.tags.filter(tag => tag.startsWith('workspace-'))
      const id = tags[0]?.slice('workspace-'.length)
      if (tags.length !== 1 || id === undefined || !/^[a-zA-Z0-9_-]{1,128}$/u.test(id)) this.unassignedOrphan = true
      else this.orphanWorkspaces.add(WorkspaceId(id))
    }
  }

  /**
   * Share one allocation or restoration operation; unknown creations retain capacity until reclaimed.
   * @param id - Authorized workspace.
   * @param project - Original registered directory.
   * @returns Shared creation/connection result.
   */
  open(id: WorkspaceId, project: string): Promise<RunnerRunningSandbox> {
    this.lifetime.signal.throwIfAborted()
    const slot = this.slot(id, project)
    if (slot.operation?.kind === 'open') return slot.operation.result
    if (slot.operation?.kind === 'close' || slot.record.state === 'closing') return Promise.reject(new RunnerResponseError('sandbox_closing', 409, false))
    if (slot.revocation.signal.aborted || slot.record.state === 'cleanup_required') return Promise.reject(new RunnerResponseError('sandbox_cleanup_required', 409, false))
    if (slot.record.state === 'running') return this.track(this.runtime.open(id, project))
    if (slot.record.instanceId === undefined) {
      const occupied = [...this.slots.values()].filter(candidate => candidate !== slot
        && (candidate.record.instanceId !== undefined || candidate.record.state === 'starting'
          || candidate.record.mutation === 'create')).length
      if (occupied + this.orphans >= this.settings.maxInstances) return Promise.reject(new RunnerResponseError('sandbox_capacity', 429, false))
      slot.record = { ...slot.record, state: 'starting', phase: slot.record.snapshotId === undefined ? 'creating' : 'restoring' }
    }
    const result = this.openOnce(slot).finally(() => { if (slot.operation?.result === result) delete slot.operation })
    slot.operation = { kind: 'open', result }
    return this.track(result)
  }

  private async openOnce(slot: Slot): Promise<RunnerRunningSandbox> {
    const signal = this.operationSignal()
    try {
      await this.commit(slot, slot.record)
      let instance = slot.record.instanceId === undefined ? undefined : await this.originalInstance(slot.record, signal)
      if (instance === undefined) {
        const bootstrap = await this.provisioning.bootstrap(slot.record, signal)
        if (slot.record.snapshotId !== undefined) {
          const snapshot = await this.api.snapshot(slot.record.snapshotId, signal)
          if (snapshot?.status !== 'complete') throw new Error('Saved snapshot is unavailable or incomplete')
        }
        const body = {
          region: this.settings.region, plan: this.settings.plan, label: slot.record.label,
          tags: [this.deploymentTag(), 'workspace-' + slot.record.workspaceId], backups: 'disabled', enable_ipv6: false,
          user_data: Buffer.from(bootstrap).toString('base64'),
          ...slot.record.snapshotId === undefined ? { os_id: this.settings.osId } : { snapshot_id: slot.record.snapshotId },
        }
        await this.commit(slot, { ...slot.record, mutation: 'create' })
        try { instance = await this.api.create(body, signal) }
        catch (error) {
          if (error instanceof VultrApiError && !error.outcomeUnknown) await this.commit(slot, { ...slot.record, mutation: undefined })
          throw error
        }
        if (!this.owned(slot.record, instance)) throw new Error('Created VM ownership does not match the request')
        await this.commit(slot, { ...slot.record, instanceId: instance.id, mutation: undefined })
      }
      if (instance.power_status === 'stopped') await this.api.power(instance.id, 'start', signal)
      instance = await this.waitInstance(slot.record, signal, candidate => candidate.status === 'active'
        && candidate.power_status === 'running' && candidate.server_status === 'ok' && candidate.main_ip !== '0.0.0.0')
      await this.commit(slot, { ...slot.record, state: 'starting', phase: 'connecting' })
      const connection = await this.provisioning.connect(slot.record, instance, signal)
      slot.revocation.signal.throwIfAborted()
      this.runtime.bind(slot.record.workspaceId, { ...connection, instanceId: instance.id })
      const running = await this.runtime.open(slot.record.workspaceId, slot.record.project)
      slot.revocation.signal.throwIfAborted()
      const binary = await this.runtime.binary(slot.record.workspaceId, running.containerId)
      await binary.list('', 1, signal)
      if (!slot.record.seeded) {
        await this.store.seed(slot.record, binary,
          this.settings.maxSavedBytes, this.settings.maxSavedFiles, signal)
      }
      await this.commit(slot, { ...slot.record, seeded: true, generation: running.containerId, state: 'running',
        phase: 'running', failure: undefined })
      return running
    } catch (error) {
      let cause: unknown = error
      try { await this.failed(slot, slot.record.snapshotId === undefined ? slot.record.instanceId === undefined
        ? 'create' : 'connect' : 'restore') }
      catch (metadata) { cause = new AggregateError([error, metadata], 'Cloud operation and failure persistence failed') }
      throw new RunnerResponseError('cloud_open_failed', 503, cause !== error || error instanceof VultrApiError
        && error.outcomeUnknown, { cause })
    }
  }

  /**
   * Return durable cloud state and verify live helper generations.
   * @param id - Authorized workspace.
   * @returns A fresh connection observation and persistent cloud phase.
   */
  async status(id: WorkspaceId): Promise<RunnerSandboxStatus> {
    this.lifetime.signal.throwIfAborted()
    return this.track(this.observeStatus(id))
  }

  private async observeStatus(id: WorkspaceId): Promise<RunnerSandboxStatus> {
    const slot = this.slots.get(id)
    if (this.unassignedOrphan || this.orphanWorkspaces.has(id)) return { state: 'cleanup_required' }
    if (slot === undefined || slot.record.state === 'closed') return { state: 'closed', reconciled: true }
    if (slot.revocation.signal.aborted && slot.operation?.kind !== 'close') return { state: 'cleanup_required' }
    if (slot.record.state === 'running') {
      const status = await this.runtime.status(id)
      if (status.state !== 'running' || status.containerId !== slot.record.generation) {
        await this.failed(slot, 'connect')
        return { state: 'cleanup_required' }
      }
      return status
    }
    return { state: slot.record.state }
  }

  /**
   * Keep caller-detached preparation and cleanup barriers visible to idle policy.
   * @param id - Authorized workspace.
   * @returns Work owned by cloud preparation and persistent cleanup barriers.
   */
  activity(id: WorkspaceId): Pick<SandboxActivity, 'openings' | 'executions' | 'closing'> {
    const slot = this.slots.get(id)
    return { openings: slot?.operation?.kind === 'open' ? 1 : 0, executions: 0,
      closing: this.unassignedOrphan || this.orphanWorkspaces.has(id) || slot?.revocation.signal.aborted === true
        || slot?.record.state === 'closing' || slot?.record.state === 'cleanup_required' }
  }

  /**
   * Describe the current cloud phase without exposing resource coordinates.
   * @param id - Authorized workspace.
   * @returns Current cloud progress without paths or cloud identities.
   */
  progress(id: WorkspaceId): SandboxProgress {
    const record = this.slots.get(id)?.record
    if (this.unassignedOrphan || this.orphanWorkspaces.has(id)) return { phase: 'failed', failure: 'ownership' }
    const slot = this.slots.get(id)
    if (slot?.revocation.signal.aborted && slot.operation?.kind !== 'close'
      && record?.state !== 'closed') return { phase: 'failed', failure: record?.failure ?? 'interrupted' }
    return record === undefined ? { phase: 'closed' } : { phase: record.phase,
      ...record.failure === undefined ? {} : { failure: record.failure } }
  }

  /**
   * Stop managed effects and preserve usable disk data before VM removal.
   * @param id - Authorized workspace.
   * @returns Closed only after a completed snapshot and confirmed VM absence.
   */
  close(id: WorkspaceId): Promise<RunnerClosedSandbox> {
    if (this.lifetime.signal.aborted) return Promise.reject(new Error('Cloud provider stopped'))
    const slot = this.slots.get(id)
    if (this.unassignedOrphan || this.orphanWorkspaces.has(id)) return Promise.reject(new RunnerResponseError('sandbox_cleanup_required', 503, true))
    if (slot === undefined || slot.record.state === 'closed') return Promise.resolve({ state: 'closed', reconciled: true })
    if (slot.operation?.kind === 'close') return slot.operation.result
    slot.revocation.abort(new Error('Workspace cloud generation closed'))
    const opening = slot.operation?.result
    const result = Promise.resolve().then(async () => {
      if (opening !== undefined) await Promise.allSettled([opening])
      return this.closeOnce(slot)
    }).finally(() => { if (slot.operation?.result === result) delete slot.operation })
    slot.operation = { kind: 'close', result }
    return this.track(result)
  }

  private async closeOnce(slot: Slot): Promise<RunnerClosedSandbox> {
    const signal = this.operationSignal()
    try {
      await this.commit(slot, { ...slot.record, state: 'closing', failure: undefined })
      if (slot.record.instanceId === undefined) {
        const matches = (await this.api.instances(signal)).filter(instance => instance.label === slot.record.label)
        if (matches.length > 1 || matches.some(instance => !this.owned(slot.record,
          instance))) throw new Error('Cloud instance ownership cannot be reconciled')
        const matched = matches[0]
        if (matched === undefined) {
          if (slot.record.mutation === 'create') throw new Error('Unacknowledged VM creation cannot be declared absent')
          await this.completeClosure(slot); return { state: 'closed', reconciled: true }
        }
        await this.commit(slot, { ...slot.record, instanceId: matched.id, mutation: undefined })
      }
      let instance = await this.originalInstance(slot.record, signal)
      if ((slot.record.phase === 'deleting' || slot.record.resumePhase === 'deleting')
        && slot.record.snapshotId !== undefined && slot.record.cache !== undefined) {
        if ((await this.api.snapshot(slot.record.snapshotId,
          signal))?.status !== 'complete') throw new Error('Completed workspace snapshot is unavailable')
        if (instance !== undefined) await this.api.deleteInstance(instance.id, signal)
        await this.confirmAbsent(slot.record, signal)
        await this.completeClosure(slot)
        return { state: 'closed', reconciled: true }
      }
      if (instance === undefined) throw new Error('Original VM is missing before its save completed')
      if (slot.record.candidateCache === undefined) {
        await this.commit(slot, { ...slot.record, phase: 'saving_files' })
        let services: WorkspaceSshServices | undefined
        try { services = await this.runtime.pause(slot.record.workspaceId) }
        catch (_error) {
          if (instance.power_status !== 'stopped') {
            await this.provisioning.flush(slot.record, signal)
            await this.api.power(instance.id, 'halt', signal)
            instance = await this.waitInstance(slot.record, signal, candidate => candidate.power_status === 'stopped')
          }
          await this.runtime.releaseStopped(slot.record.workspaceId)
          services = undefined
        }
        const fileOperations = this.fileOperations.get(slot.record.workspaceId)
        if (fileOperations !== undefined) await Promise.allSettled(fileOperations)
        if (services === undefined) {
          if (instance.power_status === 'stopped') { await this.api.power(instance.id, 'start',
            signal); instance = await this.waitInstance(slot.record, signal, candidate => candidate.power_status === 'running' && candidate.server_status === 'ok') }
          const connection = await this.provisioning.connect(slot.record, instance, signal)
          this.runtime.bind(slot.record.workspaceId, { ...connection, instanceId: instance.id })
          await this.runtime.open(slot.record.workspaceId, slot.record.project)
          services = await this.runtime.pause(slot.record.workspaceId)
        }
        if (services === undefined) throw new Error('No verified connection for workspace save')
        const copy = await this.store.copy(slot.record, new SshWorkspaceFiles(services.ssh),
          this.settings.maxSavedBytes, this.settings.maxSavedFiles, signal)
        await this.commit(slot, { ...slot.record, candidateCache: copy })
      }
      try { await this.runtime.close(slot.record.workspaceId) }
      catch (_error) {
        if (instance.power_status !== 'stopped') {
          await this.provisioning.flush(slot.record, signal)
          await this.api.power(instance.id, 'halt', signal)
          instance = await this.waitInstance(slot.record, signal, candidate => candidate.power_status === 'stopped')
        }
        await this.runtime.releaseStopped(slot.record.workspaceId)
      }
      await this.commit(slot, { ...slot.record, phase: 'stopping' })
      if (instance.power_status !== 'stopped') {
        await this.provisioning.flush(slot.record, signal)
        await this.api.power(instance.id, 'halt', signal)
      }
      await this.waitInstance(slot.record, signal, candidate => candidate.power_status === 'stopped')
      await this.commit(slot, { ...slot.record, phase: 'saving_snapshot' })
      if (slot.record.snapshotDescription === undefined) {
        await this.commit(slot, { ...slot.record, phase: 'saving_snapshot',
          snapshotDescription: 'antfarm-' + this.settings.deploymentId + '-' + randomUUID() })
      }
      if (slot.record.pendingSnapshotId === undefined) {
        const description = slot.record.snapshotDescription
        if (description === undefined) throw new Error('Snapshot operation was not recorded')
        const matches = (await this.api.snapshots(signal)).filter(snapshot => snapshot.description === description)
        if (matches.length > 1) throw new Error('Snapshot identity is ambiguous')
        let snapshot = matches[0]
        if (snapshot === undefined) {
          if (slot.record.mutation === 'snapshot') throw new Error('Unacknowledged snapshot creation must be reconciled before retry')
          await this.commit(slot, { ...slot.record, mutation: 'snapshot' })
          try { snapshot = await this.api.createSnapshot(instance.id, description, signal) }
          catch (error) {
            if (error instanceof VultrApiError && !error.outcomeUnknown) await this.commit(slot, { ...slot.record, mutation: undefined })
            throw error
          }
        }
        await this.commit(slot, { ...slot.record, pendingSnapshotId: snapshot.id, mutation: undefined, phase: 'saving_snapshot' })
      }
      while (true) {
        const id = slot.record.pendingSnapshotId
        if (id === undefined) throw new Error('Snapshot identity is missing')
        const snapshot = await this.api.snapshot(id, signal)
        if (snapshot === undefined || snapshot.status === 'error'
          || snapshot.status === 'failed') throw new Error('Workspace snapshot failed')
        if (snapshot.status === 'complete') break
        await delay(this.settings.pollIntervalMs, signal)
      }
      const oldCache = slot.record.cache
      await this.commit(slot, { ...slot.record, oldSnapshotId: slot.record.snapshotId, snapshotId: slot.record.pendingSnapshotId,
        pendingSnapshotId: undefined, snapshotDescription: undefined, cache: slot.record.candidateCache,
        candidateCache: undefined, phase: 'deleting' })
      await this.api.deleteInstance(instance.id, signal)
      await this.confirmAbsent(slot.record, signal)
      await this.completeClosure(slot)
      if (oldCache !== undefined && oldCache !== slot.record.cache) {
        await rm(this.store.copyPath(slot.record.workspaceId, oldCache), { recursive: true, force: true })
      }
      return { state: 'closed', reconciled: true }
    } catch (error) {
      const failure = slot.record.phase === 'deleting' ? 'delete' : 'save'
      let cause: unknown = error
      try { await this.failed(slot, failure) }
      catch (metadata) { cause = new AggregateError([error, metadata], 'Cloud save and failure persistence failed') }
      throw new RunnerResponseError('cloud_save_failed', 503, cause !== error, { cause })
    }
  }

  private async completeClosure(slot: Slot): Promise<void> {
    if (slot.record.oldSnapshotId !== undefined && slot.record.oldSnapshotId !== slot.record.snapshotId) {
      await this.api.deleteSnapshot(slot.record.oldSnapshotId, this.operationSignal())
    }
    const generation = brandString<SandboxContainerId>(randomBytes(32).toString('hex'))
    const label = this.label(slot.record.workspaceId, generation)
    await this.commit(slot, { ...slot.record, instanceId: undefined, state: 'closed', phase: 'closed', failure: undefined,
      oldSnapshotId: undefined, resumePhase: undefined, mutation: undefined, generation, label })
    slot.revocation = new AbortController()
  }

  /**
   * Dispatch only on the exact live VM generation.
   * @param id - Original workspace.
   * @param request - Original command and generation.
   * @param signal - Wait lifetime.
   * @returns Original execution result.
   */
  execute(id: WorkspaceId, request: RunnerExecutionRequest, signal?: AbortSignal): Promise<RunnerExecutionResult> {
    this.current(id, request.expectedContainerId)
    return this.track(this.runtime.execute(id, request, signal))
  }
  /**
   * Reject stale VM generations before forwarding cancellation.
   * @param id - Original workspace.
   * @param request - Original cancellation identity.
   * @returns Original cancellation receipt.
   */
  async cancel(id: WorkspaceId, request: RunnerExecutionIdentity): Promise<RunnerCancellationResult> { this.current(id,
    request.expectedContainerId); return this.track(this.runtime.cancel(id, request)) }
  /**
   * Capture remote files without switching generation or selecting host execution.
   * @param id - Original workspace.
   * @param target - Captured generation.
   * @param signal - Tool lifetime.
   * @returns Generation-bound remote text files.
   */
  files(id: WorkspaceId, target: SandboxContainerId, signal?: AbortSignal): Promise<WorkspaceRuntimeFiles> { this.current(id,
    target); return this.track(this.runtime.files(id, target, signal)) }

  /**
   * Read bounded metadata from a live VM, its completed copy, or an unpersisted empty unopened view.
   * @param scope - Original authority.
   * @param path - Directory.
   * @param maxEntries - Inspection bound.
   * @returns Live files or completed read-only copy.
   */
  list(scope: WorkspaceFileScope, path: string, maxEntries: number): Promise<WorkspaceFileListing> {
    return this.trackFile(scope.workspaceId, (async () => {
      const parts = artifactComponents(path)
      const view = await this.fileView(scope, false)
      if (view.files === undefined && parts.length > 0) throw new ArtifactFailure('not-found')
      const result = view.files === undefined ? { entries: [], truncated: false }
        : typeof view.files === 'string' ? await listArtifacts(view.files, path, maxEntries,
          view.signal) : await view.files.list(path, maxEntries, view.signal)
      view.admit(); return result
    })())
  }
  /**
   * Retain the original file and authority through download cleanup.
   * @param scope - Original authority.
   * @param path - Regular file.
   * @param maxBytes - Extent bound.
   * @returns Pinned live file or read-only copy.
   */
  async download(scope: WorkspaceFileScope, path: string, maxBytes: number): Promise<WorkspaceFileDownload> {
    const opening = (async () => {
      if (artifactComponents(path).length === 0) throw new ArtifactFailure('not-regular')
      const view = await this.fileView(scope, false)
      if (view.files === undefined) throw new ArtifactFailure('not-found')
      if (typeof view.files !== 'string') return view.files.download(path, maxBytes, view.signal, view.admit)
      const file = await openArtifact(view.files, path, false, view.signal)
      try {
        const bytes = (await file.stat()).size
        if (bytes > maxBytes) throw new ArtifactFailure('too-large')
        view.admit()
        return { bytes, ...streamArtifact(file, bytes, view.signal, view.admit) }
      } catch (error) { await file.close(); throw error }
    })()
    const stream = await this.trackFile(scope.workspaceId, opening)
    void this.trackFile(scope.workspaceId, stream.settled).catch(() => {})
    return stream
  }
  /**
   * Restore or reuse the VM before exclusively publishing the uploaded file.
   * @param scope - Original authority.
   * @param name - Root leaf.
   * @param chunks - Incoming bytes.
   * @param maxBytes - Complete bound.
   * @returns Exclusive live-VM publication.
   */
  upload(scope: WorkspaceFileScope, name: string, chunks: AsyncIterable<Uint8Array>, maxBytes: number): Promise<WorkspaceFileUpload> {
    return this.trackFile(scope.workspaceId, (async () => {
      const view = await this.fileView(scope, true)
      if (view.files === undefined || typeof view.files === 'string') throw new Error('Read-only copies cannot accept uploads')
      return view.files.upload(name, chunks, maxBytes, view.signal, view.admit)
    })())
  }

  private async fileView(scope: WorkspaceFileScope, write: boolean) {
    this.lifetime.signal.throwIfAborted()
    scope.signal.throwIfAborted(); scope.admit()
    const slot = this.slot(scope.workspaceId, scope.project)
    const captured = slot.revocation.signal
    const signal = AbortSignal.any([scope.signal, captured, this.lifetime.signal])
    const admit = (): void => { signal.throwIfAborted(); scope.admit() }
    if (!write && slot.record.state === 'closed') {
      admit()
      const cache = slot.record.cache
      return { files: cache === undefined ? undefined : this.store.copyPath(scope.workspaceId, cache), signal, admit }
    }
    const running = await this.observeOpening(this.open(scope.workspaceId, scope.project), signal)
    admit()
    const bound = await this.runtime.files(scope.workspaceId, running.containerId, signal)
    const files = await this.runtime.binary(scope.workspaceId, running.containerId)
    return { files, signal, admit: (): void => { admit(); bound.assertCurrent(); this.current(scope.workspaceId, running.containerId) } }
  }

  private async observeOpening(result: Promise<RunnerRunningSandbox>, signal: AbortSignal): Promise<RunnerRunningSandbox> {
    signal.throwIfAborted()
    const cancelled = Promise.withResolvers<never>()
    const abort = (): void => { cancelled.reject(signal.reason) }
    signal.addEventListener('abort', abort, { once: true })
    if (signal.aborted) abort()
    try { return await Promise.race([result, cancelled.promise]) }
    finally { signal.removeEventListener('abort', abort) }
  }

  private slot(id: WorkspaceId, project: string): Slot {
    if (this.unassignedOrphan || this.orphanWorkspaces.has(id)) throw new RunnerResponseError('sandbox_cleanup_required', 503, true)
    if (!/^[a-zA-Z0-9_-]{1,128}$/u.test(id)) throw new RunnerResponseError('sandbox_workspace_conflict', 409, false)
    this.store.outside(project)
    for (const secret of [this.settings.apiKeyFile, this.settings.sshKeyFile]) {
      const child = relative(project, secret)
      if (child === '' || (!child.startsWith('../') && child !== '..'
        && !isAbsolute(child))) throw new RunnerResponseError('invalid_workspace_directory', 400, false)
    }
    let slot = this.slots.get(id)
    if (slot !== undefined && slot.record.project !== project) throw new RunnerResponseError('sandbox_workspace_conflict', 409, false)
    if (slot === undefined) {
      const generation = brandString<SandboxContainerId>(randomBytes(32).toString('hex'))
      slot = { record: { format: 1, workspaceId: id, project, remoteRoot: this.settings.remoteRoot,
        deploymentId: this.settings.deploymentId,
        label: this.label(id, generation), generation, seeded: false, state: 'closed', phase: 'closed' },
      revocation: new AbortController() }
      this.slots.set(id, slot)
    }
    return slot
  }

  private current(id: WorkspaceId, target: SandboxContainerId): void {
    const slot = this.slots.get(id)
    if (this.unassignedOrphan || this.orphanWorkspaces.has(id) || this.lifetime.signal.aborted || slot === undefined
      || slot.record.state !== 'running' || slot.record.generation !== target || slot.revocation.signal.aborted) throw new RunnerResponseError('sandbox_workspace_conflict', 409, false)
  }
  private label(id: WorkspaceId, generation: SandboxContainerId): string { return 'antfarm-' + this.settings.deploymentId + '-' + createHash('sha256').update(id).digest('hex').slice(0, 24) + '-' + generation.slice(0, 24) }
  private deploymentTag(): string { return 'antfarm-' + this.settings.deploymentId }
  private owned(record: CloudRecord, instance: VultrInstance): boolean { return instance.label === record.label
    && instance.tags.includes(this.deploymentTag()) && instance.tags.includes('workspace-' + record.workspaceId) }
  private async originalInstance(record: CloudRecord, signal: AbortSignal): Promise<VultrInstance | undefined> {
    if (record.instanceId === undefined) return undefined
    const instance = await this.api.instance(record.instanceId, signal)
    if (instance !== undefined && !this.owned(record, instance)) throw new Error('Vultr VM no longer matches persisted ownership')
    return instance
  }
  private async waitInstance(record: CloudRecord, signal: AbortSignal,
    ready: (instance: VultrInstance) => boolean): Promise<VultrInstance> {
    while (true) {
      const instance = await this.originalInstance(record, signal)
      if (instance === undefined) throw new Error('Vultr VM disappeared during preparation')
      if (ready(instance)) return instance
      await delay(this.settings.pollIntervalMs, signal)
    }
  }
  private async confirmAbsent(record: CloudRecord, signal: AbortSignal): Promise<void> {
    while (await this.originalInstance(record, signal) !== undefined) await delay(this.settings.pollIntervalMs, signal)
  }
  private operationSignal(): AbortSignal { return AbortSignal.any([this.lifetime.signal,
    AbortSignal.timeout(this.settings.operationTimeoutMs)]) }
  private async commit(slot: Slot, record: CloudRecord): Promise<void> { await this.store.save(record); slot.record = record }
  private async failed(slot: Slot, failure: NonNullable<CloudRecord['failure']>): Promise<void> {
    slot.revocation.abort(new Error('Workspace cloud operation failed'))
    try { await this.commit(slot, { ...slot.record, state: 'cleanup_required',
      resumePhase: slot.record.phase === 'failed' ? slot.record.resumePhase : slot.record.phase, phase: 'failed', failure }) }
    finally { this.report(slot.record.workspaceId, failure) }
  }
  private track<T>(result: Promise<T>): Promise<T> {
    this.pending.add(result)
    void result.then(() => this.pending.delete(result), () => this.pending.delete(result))
    return result
  }
  private trackFile<T>(id: WorkspaceId, result: Promise<T>): Promise<T> {
    let operations = this.fileOperations.get(id)
    if (operations === undefined) { operations = new Set(); this.fileOperations.set(id, operations) }
    operations.add(result)
    const captured = operations
    void result.then(() => captured.delete(result), () => captured.delete(result))
    return this.track(result)
  }
  /** Revoke and drain local operations and SSH before releasing state ownership; preserve cloud disks for reconciliation. */
  dispose(): Promise<void> {
    if (this.stopping !== undefined) return this.stopping
    this.lifetime.abort(new Error('Cloud provider stopped'))
    for (const slot of this.slots.values()) slot.revocation.abort(this.lifetime.signal.reason)
    this.stopping = this.drain()
    return this.stopping
  }

  private async drain(): Promise<void> {
    await Promise.allSettled([...this.slots.keys()].map(id => this.runtime.pause(id)))
    while (this.pending.size > 0) await Promise.allSettled([...this.pending])
    try { await this.runtime.dispose() }
    finally { await this.store.close() }
  }
}
