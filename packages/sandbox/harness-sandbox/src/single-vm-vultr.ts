/** Single-session Vultr preparation and generation-gated execution on the native VFS volume. */
import { createHash, randomBytes } from 'node:crypto'
import { readFile, realpath } from 'node:fs/promises'
import { isIP } from 'node:net'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { WorkspaceId } from '@deepseek-ai/dsh-workspace/types'
import { z } from 'zod'
import type { WorkspaceRuntimeFiles } from './backend.ts'
import type { RunnerCancellationResult, RunnerExecutionIdentity, RunnerExecutionRequest, RunnerExecutionResult } from './execution.ts'
import {
  RunnerResponseError, type RunnerClosedSandbox, type RunnerRunningSandbox, type RunnerSandboxStatus, type SandboxContainerId,
} from './runner-client.ts'
import type { SingleVmWorkspaces } from './single-vm-workspaces.ts'
import { WorkspaceSshRuntime } from './ssh-controller.ts'
import { VultrApi, VultrApiError, type VultrAttachment, type VultrInstance, vultrInstance, vultrVolumeId, type VultrVolumeId } from './vultr-api.ts'
import { Config, type Config as VultrSettings, type ResolvedConfig, vultrEndpoint } from './vultr-config.ts'
import { delay, VultrSshProvisioning, type VultrVfsProvisioning } from './vultr-provision.ts'
import { cloudGeneration, CloudWorkspaceRecords, cloudWorkspaceId } from './vultr-storage.ts'

/** Private allocation facts retained for the original VM and volume during recovery. */
export const singleVmAllocation = z.strictObject({
  format: z.literal(1), workspaceId: cloudWorkspaceId, project: z.string(), remoteRoot: z.literal('/workspace'),
  deploymentId: z.string(), label: z.string(), generation: cloudGeneration, region: z.string(), plan: z.string(), volumeId: vultrVolumeId,
  state: z.enum(['starting', 'running', 'cleanup_required']),
  phase: z.enum(['creating', 'booting', 'sharing', 'attaching', 'mounting', 'handshake', 'running']),
  cleanup: z.enum(['draining', 'unmounted', 'detaching', 'deleting']).optional(),
  instanceId: vultrInstance.shape.id.optional(),
  attachment: z.discriminatedUnion('state', [
    z.strictObject({ state: z.literal('not-requested') }),
    z.strictObject({ state: z.literal('requested') }),
    z.strictObject({ state: z.literal('attached'), mountTag: z.number().int().positive() }),
  ]),
})

/** One retained allocation, including a create request with no acknowledged instance ID. */
export type SingleVmAllocation = z.infer<typeof singleVmAllocation>

type Settings = Pick<ResolvedConfig, 'deploymentId' | 'region' | 'plan' | 'osId' | 'maxInstances' | 'operationTimeoutMs' | 'pollIntervalMs'>
  & { readonly volumeId: VultrVolumeId }
type Runtime = Pick<WorkspaceSshRuntime, 'bind' | 'open' | 'status' | 'execute' | 'files' | 'cancel' | 'close' | 'releaseStopped' | 'dispose'>
type Records = Pick<CloudWorkspaceRecords<SingleVmAllocation>, 'load' | 'save' | 'remove' | 'outside' | 'close'>

function rejectedMutation(error: unknown): boolean {
  return error instanceof VultrApiError && [400, 401, 403, 422, 429].includes(error.status)
}

interface Slot {
  readonly project: string
  record?: SingleVmAllocation
  opening?: Promise<RunnerRunningSandbox>
  closing?: Promise<RunnerClosedSandbox>
}

/** Cloud and VFS configuration for the single-session provider. */
export interface SingleVmVultrConfig extends Omit<VultrSettings, 'remoteRoot' | 'maxSavedBytes' | 'maxSavedFiles'> {
  /** UUID of the existing volume on the Harness host. */
  readonly volumeId: string
  /** Absolute trusted directory containing check-mount.sh and run-workspace-helper.sh. */
  readonly vfsScriptsRoot: string
}

/** One provider owns cloud preparation, recovery evidence and the matching SSH generation. */
export class SingleVmVultrBackend {
  private readonly slots = new Map<WorkspaceId, Slot>()
  private readonly lifetime = new AbortController()
  private initialized = false
  private disposal: Promise<void> | undefined
  private startupRecovery: Promise<void> | undefined

  /**
   * @param settings - Resolved allocation and volume settings.
   * @param api - Authenticated Vultr transport.
   * @param records - Exclusive private allocation storage.
   * @param workspaces - Verified VFS workspace mapping and task identities.
   * @param provisioning - Guest preparation through pinned SSH.
   * @param runtime - Command and file provider using the installed helper.
   * @param report - Host-only failure reporting with the original allocation record.
   */
  constructor(private readonly settings: Settings,
    private readonly api: Pick<VultrApi, 'create' | 'instance' | 'instances' | 'shareMemory' | 'volume' | 'attach' | 'attachment'
      | 'detach' | 'deleteInstance'>,
    private readonly records: Records, private readonly workspaces: Pick<SingleVmWorkspaces, 'resolve'>,
    private readonly provisioning: VultrVfsProvisioning, private readonly runtime: Runtime,
    private readonly report: (record: SingleVmAllocation, cause: unknown) => void) {}

  /** Quarantine every prior allocation and reconcile them serially without blocking unrelated startup. */
  async initialize(): Promise<void> {
    for (const record of await this.records.load()) {
      if (record.deploymentId !== this.settings.deploymentId || record.volumeId !== this.settings.volumeId
        || record.region !== this.settings.region || record.plan !== this.settings.plan
        || record.label !== this.label(record.workspaceId, record.generation)) {
        throw new Error('Single VM deployment differs from retained allocation records')
      }
      this.records.outside(record.project)
      this.slots.set(record.workspaceId, { project: record.project, record: { ...record, state: 'cleanup_required' } })
    }
    this.initialized = true
    this.startupRecovery = this.recoverRetained([...this.slots.keys()])
  }

  private async recoverRetained(ids: readonly WorkspaceId[]): Promise<void> {
    for (const id of ids) {
      if (this.lifetime.signal.aborted) return
      await this.recoverTask(id).catch(() => {}) // Reclamation logs and retains the original record for later attempts.
    }
  }

  /**
   * Share one allocation and readiness result per original registered workspace.
   * @param id - Authorized workspace.
   * @param project - Original registered directory.
   * @returns The generation after durable mount and helper readiness.
   */
  async open(id: WorkspaceId, project: string): Promise<RunnerRunningSandbox> {
    this.lifetime.signal.throwIfAborted()
    if (!this.initialized) throw new RunnerResponseError('runner_unavailable', 503, false)
    cloudWorkspaceId.parse(id)
    const current = this.slots.get(id)
    if (current !== undefined) {
      if (current.project !== project) throw new RunnerResponseError('sandbox_workspace_conflict', 409, false)
      if (current.opening !== undefined) return current.opening
      if (current.closing !== undefined || current.record?.state === 'cleanup_required') {
        await this.recoverTask(id)
        return this.open(id, project)
      }
      const status = await this.status(id)
      if (status.state === 'running') return status
      throw new RunnerResponseError('sandbox_cleanup_required', 409, true)
    }
    if (this.slots.size >= this.settings.maxInstances) throw new RunnerResponseError('sandbox_capacity', 429, false)
    this.records.outside(project)
    const slot: Slot = { project }
    this.slots.set(id, slot)
    slot.opening = this.openOnce(id, slot).finally(() => { delete slot.opening })
    return slot.opening
  }

  private async openOnce(id: WorkspaceId, slot: Slot): Promise<RunnerRunningSandbox> {
    const signal = AbortSignal.any([this.lifetime.signal, AbortSignal.timeout(this.settings.operationTimeoutMs)])
    const settings = this.settings
    const generation = cloudGeneration.parse(randomBytes(32).toString('hex'))
    const label = this.label(id, generation)
    const record: SingleVmAllocation = {
      format: 1, workspaceId: id, project: slot.project, remoteRoot: '/workspace', deploymentId: settings.deploymentId,
      label, generation, region: settings.region, plan: settings.plan, volumeId: settings.volumeId,
      state: 'starting', phase: 'creating', attachment: { state: 'not-requested' },
    }
    let createAttempted = false
    try {
      const directory = this.workspaces.resolve({ workspaceId: id, project: slot.project, signal, admit() {} })
      const volume = await this.api.volume(record.volumeId, signal)
      if (volume.id !== record.volumeId || volume.region !== record.region || volume.status !== 'active') {
        throw new Error('Single VM VFS volume does not match the active volume in the selected region')
      }
      const bootstrap = await this.provisioning.bootstrap(record, directory, signal)
      directory.assertCurrent()
      slot.record = record
      await this.save(slot, record)
      signal.throwIfAborted()
      createAttempted = true
      const created = await this.api.create({
        region: record.region, plan: record.plan, label, tags: [this.deploymentTag, 'workspace-' + id], os_id: settings.osId,
        backups: 'disabled', enable_ipv6: false, user_data: Buffer.from(bootstrap).toString('base64'),
      }, signal)
      this.verifyInstance(record, created, created.id)
      const booting = { ...record, instanceId: created.id, phase: 'booting' } satisfies SingleVmAllocation
      await this.save(slot, booting)
      let ready = await this.waitReady(booting, created.id, signal, false)
      if (ready.enable_memorybacking === 'none') {
        await this.save(slot, { ...booting, phase: 'sharing' })
        await this.api.shareMemory(created.id, signal)
        ready = await this.waitReady(booting, created.id, signal, true)
      }
      if (ready.enable_memorybacking !== 'shared') throw new Error('Single VM lacks verified Shared Memory Backing')

      directory.assertCurrent()
      const attaching = { ...booting, phase: 'attaching', attachment: { state: 'requested' } } satisfies SingleVmAllocation
      await this.save(slot, attaching)
      try {
        signal.throwIfAborted()
        this.verifyAttachment(attaching, created.id, await this.api.attach(record.volumeId, created.id, signal))
      } catch (error) {
        if (error === signal.reason || rejectedMutation(error) || error instanceof VultrApiError && error.status === 404) {
          await this.save(slot, { ...attaching, attachment: { state: 'not-requested' } })
        }
        throw error
      }
      const mountTag = await this.waitAttachment(attaching, created.id, signal)
      const attached = { ...attaching, attachment: { state: 'attached', mountTag } } satisfies SingleVmAllocation
      await this.save(slot, attached)
      const mounting = { ...attached, phase: 'mounting' } satisfies SingleVmAllocation
      const connection = await this.provisioning.connect(attached, ready, directory, mountTag, signal, () => this.save(slot, mounting))
      directory.assertCurrent()
      if (connection.workspace !== mounting.remoteRoot) throw new Error('Single VM helper has a different workspace root')
      await this.save(slot, { ...mounting, phase: 'handshake' })
      this.runtime.bind(id, { ...connection, instanceId: created.id }, generation)
      const running = await this.runtime.open(id, slot.project)
      if (running.containerId !== generation) throw new Error('Single VM helper returned a different generation')
      signal.throwIfAborted()
      directory.assertCurrent()
      await this.save(slot, { ...mounting, phase: 'running', state: 'running' })
      return running
    } catch (error) {
      const failed = slot.record
      if (failed === undefined) this.slots.delete(id)
      else {
        this.report(failed, error)
        try {
          if (!createAttempted || failed.phase === 'creating' && rejectedMutation(error)) await this.forget(slot, failed)
          else await this.reclaim(slot, failed.generation)
        } catch (cleanupError) {
          error = new AggregateError([error, cleanupError], 'Single VM startup and reclamation failed')
        }
      }
      throw new RunnerResponseError('cloud_open_failed', 503, this.slots.has(id), { cause: error })
    }
  }

  private async save(slot: Slot, record: SingleVmAllocation): Promise<void> {
    await this.records.save(record)
    slot.record = record
  }

  private get deploymentTag(): string { return 'antfarm-single-' + this.settings.deploymentId }

  private label(id: WorkspaceId, generation: SandboxContainerId): string {
    return this.deploymentTag + '-' + createHash('sha256').update(id).digest('hex').slice(0, 16) + '-' + generation.slice(0, 24)
  }

  private verifyInstance(record: SingleVmAllocation, instance: VultrInstance, id: VultrInstance['id']): void {
    if (instance.id !== id || instance.label !== record.label || instance.region !== record.region || instance.plan !== record.plan
      || !instance.tags.includes(this.deploymentTag) || !instance.tags.includes('workspace-' + record.workspaceId)) {
      throw new Error('Single VM allocation does not match the original request')
    }
  }

  private async waitReady(record: SingleVmAllocation, id: VultrInstance['id'], signal: AbortSignal,
    shared: boolean): Promise<VultrInstance> {
    while (true) {
      const instance = await this.api.instance(id, signal)
      if (instance === undefined) throw new Error('Single VM disappeared during preparation')
      this.verifyInstance(record, instance, id)
      if (instance.status === 'active' && instance.power_status === 'running' && instance.server_status === 'ok'
        && instance.main_ip !== '0.0.0.0' && isIP(instance.main_ip) === 4 && (!shared || instance.enable_memorybacking === 'shared')) {
        return instance
      }
      await delay(this.settings.pollIntervalMs, signal)
    }
  }

  private verifyAttachment(record: SingleVmAllocation, id: VultrInstance['id'], attachment: VultrAttachment): void {
    if (attachment.vfs_id !== record.volumeId || attachment.target_id !== id) {
      throw new Error('Single VM attachment does not match the requested volume and instance')
    }
  }

  private async waitAttachment(record: SingleVmAllocation, id: VultrInstance['id'], signal: AbortSignal): Promise<number> {
    while (true) {
      const attachment = await this.api.attachment(record.volumeId, id, signal)
      if (attachment !== undefined) {
        this.verifyAttachment(record, id, attachment)
        if (attachment.state === 'ATTACHED' && attachment.mount_tag != null && attachment.mount_tag > 0) return attachment.mount_tag
        if (attachment.state !== 'ATTACHING' && attachment.state !== 'PENDING') throw new Error('Single VM attachment has no usable Mount Tag')
      }
      await delay(this.settings.pollIntervalMs, signal)
    }
  }

  /**
   * Observe preparation or the matching live helper without creating anything.
   * @param id - Authorized workspace.
   * @returns Current execution state.
   */
  async status(id: WorkspaceId): Promise<RunnerSandboxStatus> {
    const slot = this.slots.get(id)
    if (slot === undefined) return { state: 'closed' }
    if (slot.closing !== undefined) return { state: 'closing' }
    if (slot.opening !== undefined) return { state: 'starting' }
    if (slot.record?.state !== 'running') return { state: 'cleanup_required' }
    const live = await this.runtime.status(id)
    return live.state === 'running' && live.containerId === slot.record.generation ? live : { state: 'cleanup_required' }
  }

  /**
   * Confirm absence of an allocation or preserve the original record for the cleanup owner.
   * @param id - Authorized workspace.
   * @returns Closed only when no allocation is retained.
   */
  close(id: WorkspaceId): Promise<RunnerClosedSandbox> {
    return this.slots.has(id) ? Promise.reject(new RunnerResponseError('sandbox_cleanup_required', 409, true))
      : Promise.resolve({ state: 'closed' })
  }

  /**
   * Close only the generation captured by the task lifecycle, even if its helper disconnected.
   * @param id - Authorized workspace.
   * @param generation - Generation retained by the last task user.
   * @returns Closed after guest cleanup, detach and deletion are confirmed.
   */
  closeTask(id: WorkspaceId, generation: SandboxContainerId): Promise<RunnerClosedSandbox> {
    const slot = this.slots.get(id)
    if (slot?.opening !== undefined) return Promise.reject(new RunnerResponseError('sandbox_closing', 409, false))
    return slot === undefined ? Promise.resolve({ state: 'closed' }) : this.reclaim(slot, generation)
  }

  /**
   * Reconcile a failed allocation before the next task or after Harness restart.
   * @param id - Authorized workspace.
   */
  async recoverTask(id: WorkspaceId): Promise<void> {
    const slot = this.slots.get(id)
    if (slot?.closing !== undefined) await slot.closing
    else if (slot?.record?.state === 'cleanup_required') await this.reclaim(slot, slot.record.generation)
  }

  private reclaim(slot: Slot, generation: SandboxContainerId): Promise<RunnerClosedSandbox> {
    const record = slot.record
    if (record?.generation !== generation) return Promise.reject(new RunnerResponseError('sandbox_workspace_conflict', 409, true))
    return slot.closing ??= this.reclaimOnce(slot, record).finally(() => { delete slot.closing })
  }

  private async reclaimOnce(slot: Slot, original: SingleVmAllocation): Promise<RunnerClosedSandbox> {
    const signal = AbortSignal.timeout(this.settings.operationTimeoutMs)
    const id = original.workspaceId
    let record: SingleVmAllocation = { ...original, state: 'cleanup_required' }
    slot.record = record
    try {
      await this.save(slot, record)
      if (record.instanceId === undefined) {
        const matches = (await this.api.instances(signal)).filter(instance => instance.label === record.label)
        const [match] = matches
        if (matches.length !== 1 || match === undefined) throw new Error('Original create outcome is still unconfirmed')
        this.verifyInstance(record, match, match.id)
        record = { ...record, instanceId: match.id }
        await this.save(slot, record)
      }
      const target = record.instanceId
      if (target === undefined) throw new Error('Original allocation has no verified instance ID')
      const originalInstance = async (): Promise<VultrInstance | undefined> => {
        const instance = await this.api.instance(target, signal)
        if (instance !== undefined) this.verifyInstance(record, instance, target)
        return instance
      }
      const instance = await originalInstance()
      if (record.cleanup === undefined || record.cleanup === 'draining') {
        if (record.phase === 'mounting' || record.phase === 'handshake' || record.phase === 'running') {
          record = { ...record, cleanup: 'draining' }
          await this.save(slot, record)
          if (instance === undefined) throw new Error('Guest disappeared before workspace synchronization was confirmed')
          // When helper acknowledgement is lost, the original guest must independently prove quiescence.
          await this.runtime.close(id).catch(() => {})
          await this.provisioning.retire(record, instance, signal)
          await this.runtime.releaseStopped(id)
        }
        record = { ...record, cleanup: 'unmounted' }
        await this.save(slot, record)
      }
      const attachment = async (): Promise<VultrAttachment | undefined> => {
        const attached = await this.api.attachment(record.volumeId, target, signal)
        if (attached !== undefined) {
          this.verifyAttachment(record, target, attached)
          if (record.attachment.state === 'attached' && attached.mount_tag != null && attached.mount_tag > 0
            && attached.mount_tag !== record.attachment.mountTag) throw new Error('Original VFS Mount Tag has changed')
        }
        return attached
      }
      const attached = await attachment()
      if (attached !== undefined) {
        if (record.cleanup === 'deleting' || instance === undefined) throw new Error('Original VM attachment needs reconciliation')
        record = { ...record, cleanup: 'detaching' }
        await this.save(slot, record)
        await this.confirmRemoval(() => this.api.detach(record.volumeId, target, signal), attachment, signal)
      } else if (record.attachment.state === 'requested' && instance !== undefined && record.cleanup === 'unmounted') {
        throw new Error('Original attachment request is still unconfirmed')
      }
      record = { ...record, cleanup: 'deleting' }
      await this.save(slot, record)
      if (await originalInstance() !== undefined) {
        await this.confirmRemoval(() => this.api.deleteInstance(target, signal), originalInstance, signal)
      }
      if (await attachment() !== undefined) throw new Error('Original attachment remains after deletion')
      await this.forget(slot, record)
      return { state: 'closed' }
    } catch (error) {
      this.report(record, error)
      throw new RunnerResponseError('sandbox_cleanup_required', 503, true, { cause: error })
    }
  }

  private async confirmRemoval(remove: () => Promise<void>, query: () => Promise<unknown>, signal: AbortSignal): Promise<void> {
    let failure: Error | undefined
    try { await remove() }
    catch (error) { failure = error instanceof Error ? error : new Error('Cloud removal failed', { cause: error }) }
    while (await query() !== undefined) {
      if (failure !== undefined) throw failure
      await delay(this.settings.pollIntervalMs, signal)
    }
  }

  private async forget(slot: Slot, record: SingleVmAllocation): Promise<void> {
    slot.record = { ...record, state: 'cleanup_required' }
    await this.records.remove(record.workspaceId)
    this.slots.delete(record.workspaceId)
  }

  /**
   * Run through the prepared helper for the original generation.
   * @param id - Original workspace.
   * @param request - Command and expected generation.
   * @param signal - Optional caller wait lifetime.
   * @returns Original command result.
   */
  execute(id: WorkspaceId, request: RunnerExecutionRequest, signal?: AbortSignal): Promise<RunnerExecutionResult> {
    this.current(id, request.expectedContainerId)
    return this.runtime.execute(id, request, signal)
  }

  /**
   * Cancel only a command on the original helper.
   * @param id - Original workspace.
   * @param request - Command and expected generation.
   * @returns Original cancellation receipt.
   */
  cancel(id: WorkspaceId, request: RunnerExecutionIdentity): Promise<RunnerCancellationResult> {
    this.current(id, request.expectedContainerId)
    return this.runtime.cancel(id, request)
  }

  /**
   * Acquire the original helper's text filesystem.
   * @param id - Original workspace.
   * @param generation - Admitted execution generation.
   * @param signal - Optional caller lifetime.
   * @returns Files bound to that generation.
   */
  files(id: WorkspaceId, generation: SandboxContainerId, signal?: AbortSignal): Promise<WorkspaceRuntimeFiles> {
    this.current(id, generation)
    return this.runtime.files(id, generation, signal)
  }

  private current(id: WorkspaceId, generation: SandboxContainerId): void {
    const record = this.slots.get(id)?.record
    if (this.lifetime.signal.aborted || record?.state !== 'running' || record.generation !== generation) {
      throw new RunnerResponseError('sandbox_workspace_conflict', 409, false)
    }
  }

  /**
   * Drain local setup and SSH without destroying cloud resources or removing their records.
   * @returns Settlement and release of the private store lock.
   */
  dispose(): Promise<void> {
    this.lifetime.abort()
    return this.disposal ??= (async () => {
      const operations = [...this.slots.values()].flatMap(slot => [slot.opening, slot.closing])
      await Promise.allSettled(operations.filter(operation => operation !== undefined))
      await this.startupRecovery
      try { await this.runtime.dispose() } finally { await this.records.close() }
    })()
  }
}

/**
 * Create an owned single-session provider for a mode composition.
 * @param ctx - Deployment context.
 * @param config - Cloud allocation and trusted provisioning assets.
 * @param workspaces - The same VFS mapping used by mode files and transitions.
 * @returns Initialized provider. Its composition must dispose it after admission stops.
 */
export async function createSingleVmVultrBackend(ctx: Context, config: SingleVmVultrConfig,
  workspaces: SingleVmWorkspaces): Promise<SingleVmVultrBackend> {
  if (process.platform !== 'linux') throw new Error('Single VM Vultr requires a Linux Harness')
  const settings = Config({ ...config, remoteRoot: '/workspace' })
  z.string().regex(/^[a-zA-Z0-9_-]{1,32}$/u).parse(settings.deploymentId)
  const volumeId = vultrVolumeId.parse(config.volumeId)
  const endpoint = vultrEndpoint(settings.apiEndpoint)
  if (!isAbsolute(config.vfsScriptsRoot) || resolve(config.vfsScriptsRoot) !== config.vfsScriptsRoot
    || await realpath(config.vfsScriptsRoot) !== config.vfsScriptsRoot) throw new Error('VFS scripts root must be canonical and absolute')
  for (const path of [settings.apiKeyFile, settings.sshKeyFile, settings.helperArchive]) {
    if (!isAbsolute(path)) throw new Error('Vultr deployment files must use absolute paths')
  }
  if (!isAbsolute(settings.stateRoot) || resolve(settings.stateRoot) !== settings.stateRoot
    || await realpath(dirname(settings.stateRoot)) !== dirname(settings.stateRoot)) throw new Error('Single VM state parent must be canonical')
  settings.apiKeyFile = await realpath(settings.apiKeyFile)
  settings.sshKeyFile = await realpath(settings.sshKeyFile)
  settings.helperArchive = await realpath(settings.helperArchive)
  for (const path of [settings.stateRoot, settings.apiKeyFile, settings.sshKeyFile, settings.helperArchive, config.vfsScriptsRoot]) {
    workspaces.assertOutside(path)
  }
  const provisioning = new VultrSshProvisioning(settings)
  await provisioning.validate()
  const key = (await readFile(settings.apiKeyFile, 'utf8')).trim()
  if (key.length === 0 || /[\r\n]/u.test(key)) throw new Error('Vultr API credential is empty or malformed')
  const [checkMount, launchHelper] = await Promise.all(['check-mount.sh', 'run-workspace-helper.sh'].map(async (name) => {
    const path = join(config.vfsScriptsRoot, name)
    if (await realpath(path) !== path) throw new Error('Single VM provisioning scripts must not be symlinks')
    return readFile(path, 'utf8')
  }))
  if (!checkMount || !launchHelper) throw new Error('Single VM provisioning scripts must not be empty')
  const api = new VultrApi(key, endpoint, settings.requestTimeoutMs, settings.maxInventoryPages, settings.maxApiResponseBytes)
  const store = new CloudWorkspaceRecords(settings.stateRoot, singleVmAllocation)
  const runtime = new WorkspaceSshRuntime(ctx, { bindings: {}, maxExecutions: settings.maxExecutions,
    maxOutputBytes: settings.maxOutputBytes, graceMs: settings.graceMs })
  const backend = new SingleVmVultrBackend({ ...settings, volumeId }, api, store, workspaces,
    provisioning.forVfs({ checkMount, launchHelper }), runtime, (record) => {
      ctx.logger.warn('single-vm: workspace %s allocation %s instance %s failed at %s (reclamation %s)',
        record.workspaceId, record.label, record.instanceId ?? '(unconfirmed)', record.phase, record.cleanup ?? 'not started')
    })
  await store.initialize()
  try { await backend.initialize() }
  catch (error) { await backend.dispose(); throw error }
  return backend
}
