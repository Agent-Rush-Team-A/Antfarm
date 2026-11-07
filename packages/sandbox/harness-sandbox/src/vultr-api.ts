/** Bounded Vultr wire operations; mutations are never automatically replayed. */
import { z } from 'zod'
import { brandString, type Branded } from '@deepseek-ai/dsh-brand'

/** Opaque cloud instance identity, distinct from an execution generation. */
export type VultrInstanceId = Branded<'VultrInstanceId'>
/** Opaque durable disk snapshot identity. */
export type VultrSnapshotId = Branded<'VultrSnapshotId'>
/** Opaque Vultr File System volume identity. */
export type VultrVolumeId = Branded<'VultrVolumeId'>
const instanceId = z.uuid().transform(value => brandString<VultrInstanceId>(value))
const snapshotId = z.uuid().transform(value => brandString<VultrSnapshotId>(value))
/** Parse the volume identity supplied by deployment or returned by Vultr. */
export const vultrVolumeId = z.uuid().transform(value => brandString<VultrVolumeId>(value))
/** Validated instance facts used by readiness and restart reconciliation. */
export const vultrInstance = z.object({
  id: instanceId, label: z.string(), tags: z.array(z.string()),
  main_ip: z.string(), status: z.string(), power_status: z.string(), server_status: z.string(),
  region: z.string().optional(), plan: z.string().optional(), enable_memorybacking: z.string().optional() })
/** Validated snapshot facts; only complete permits removal of the source VM. */
export const vultrSnapshot = z.object({ id: snapshotId, description: z.string(), status: z.string() })
/** One cloud instance observation. */
export type VultrInstance = z.infer<typeof vultrInstance>
/** One cloud snapshot observation. */
export type VultrSnapshot = z.infer<typeof vultrSnapshot>
const volume = z.object({ id: vultrVolumeId, region: z.string(), status: z.string() })
const attachment = z.object({ vfs_id: vultrVolumeId, target_id: instanceId, state: z.string(),
  mount_tag: z.number().int().nonnegative().nullable().optional() })
/** VFS volume identity and regional availability. */
export type VultrVolume = z.infer<typeof volume>
/** Observed attachment for one volume and one instance. */
export type VultrAttachment = z.infer<typeof attachment>

/** A sanitized API failure; unknown mutations require inventory reconciliation. */
export class VultrApiError extends Error {
  /**
   * @param status - Known HTTP status or zero for unknown transport outcome.
   * @param outcomeUnknown - Whether the mutation might exist remotely.
   * @param cause - Internal failure, without an API response body.
   */
  constructor(readonly status: number, readonly outcomeUnknown: boolean, cause?: unknown) {
    super('Vultr API operation failed', { cause })
  }
}

/** One deployment's authenticated client, with no resource ownership or retry policy. */
export class VultrApi {
  /**
   * @param key - Deployment management credential.
   * @param endpoint - Trusted API origin.
   * @param timeoutMs - Per-request deadline.
   * @param maxPages - Complete inventory bound.
   * @param maxResponseBytes - Complete wire-response byte bound.
   * @param transport - HTTP transport, replaceable only by owning tests.
   */
  constructor(private readonly key: string, private readonly endpoint: string, private readonly timeoutMs: number,
    private readonly maxPages: number, private readonly maxResponseBytes: number, private readonly transport: typeof fetch = fetch) {}

  /**
   * Submit one VM allocation without replaying an unknown result.
   * @param body - Trusted allocation settings.
   * @param signal - Operation lifetime.
   * @returns Confirmed created identity.
   */
  async create(body: object, signal: AbortSignal): Promise<VultrInstance> {
    return (await this.request('POST', '/instances', body, z.object({ instance: vultrInstance }), signal)).instance
  }
  /**
   * Observe a retained VM identity; only HTTP 404 confirms absence.
   * @param id - Retained instance identity.
   * @param signal - Operation lifetime.
   * @returns Current facts or confirmed absence.
   */
  async instance(id: VultrInstanceId, signal: AbortSignal): Promise<VultrInstance | undefined> {
    try { return (await this.request('GET', '/instances/' + id, undefined, z.object({ instance: vultrInstance }), signal)).instance }
    catch (error) { if (error instanceof VultrApiError && error.status === 404) return undefined; throw error }
  }

  /**
   * Request Shared Memory Backing for a verified VM. The caller confirms readiness after the update.
   * @param id - Owned instance.
   * @param signal - Operation lifetime.
   */
  async shareMemory(id: VultrInstanceId, signal: AbortSignal): Promise<void> {
    await this.request('PATCH', '/instances/' + id, { enable_memorybacking: 'shared' },
      z.object({ instance: vultrInstance }), signal)
  }

  /**
   * Read the configured volume before allocating a VM in its region.
   * @param id - Deployment-owned volume identity.
   * @param signal - Operation lifetime.
   * @returns Validated VFS facts.
   */
  volume(id: VultrVolumeId, signal: AbortSignal): Promise<VultrVolume> {
    return this.request('GET', '/vfs/' + id, undefined, volume, signal)
  }

  /**
   * Request a native attachment without replaying an unknown outcome.
   * @param id - Deployment-owned volume.
   * @param target - Original VM.
   * @param signal - Operation lifetime.
   * @returns Attachment facts from the mutation response.
   */
  attach(id: VultrVolumeId, target: VultrInstanceId, signal: AbortSignal): Promise<VultrAttachment> {
    return this.request('PUT', '/vfs/' + id + '/attachments/' + target, undefined, attachment, signal)
  }

  /**
   * Read the native attachment by both identities.
   * @param id - Deployment-owned volume.
   * @param target - Original VM.
   * @param signal - Operation lifetime.
   * @returns Current attachment or confirmed HTTP 404.
   */
  async attachment(id: VultrVolumeId, target: VultrInstanceId, signal: AbortSignal): Promise<VultrAttachment | undefined> {
    try { return await this.request('GET', '/vfs/' + id + '/attachments/' + target, undefined, attachment, signal) }
    catch (error) { if (error instanceof VultrApiError && error.status === 404) return undefined; throw error }
  }

  /**
   * Remove only the original VM's attachment. The volume remains under deployment ownership.
   * @param id - Original volume.
   * @param target - Original VM.
   * @param signal - Cleanup lifetime.
   */
  async detach(id: VultrVolumeId, target: VultrInstanceId, signal: AbortSignal): Promise<void> {
    await this.remove('/vfs/' + id + '/attachments/' + target, signal)
  }
  /**
   * Request start or halt; the caller separately confirms power state.
   * @param id - Source VM.
   * @param action - Explicit power action.
   * @param signal - Operation lifetime.
   */
  async power(id: VultrInstanceId, action: 'halt' | 'start', signal: AbortSignal): Promise<void> {
    await this.request('POST', '/instances/' + id + '/' + action, {}, z.null(), signal)
  }
  /**
   * Request removal of a reclaimed VM without retrying automatically.
   * @param id - VM whose persistent data has been preserved by its owner.
   * @param signal - Operation lifetime.
   */
  async deleteInstance(id: VultrInstanceId, signal: AbortSignal): Promise<void> {
    await this.remove('/instances/' + id, signal)
  }
  /**
   * Submit one disk snapshot operation for the original stopped VM.
   * @param id - Quiescent stopped source VM.
   * @param description - Persisted unique operation label.
   * @param signal - Operation lifetime.
   * @returns Created snapshot facts.
   */
  async createSnapshot(id: VultrInstanceId, description: string, signal: AbortSignal): Promise<VultrSnapshot> {
    return (await this.request('POST', '/snapshots', { instance_id: id, description },
      z.object({ snapshot: vultrSnapshot }), signal)).snapshot
  }
  /**
   * Observe snapshot completion using its retained identity.
   * @param id - Persisted snapshot.
   * @param signal - Operation lifetime.
   * @returns Current facts or confirmed absence.
   */
  async snapshot(id: VultrSnapshotId, signal: AbortSignal): Promise<VultrSnapshot | undefined> {
    try { return (await this.request('GET', '/snapshots/' + id, undefined, z.object({ snapshot: vultrSnapshot }), signal)).snapshot }
    catch (error) { if (error instanceof VultrApiError && error.status === 404) return undefined; throw error }
  }
  /**
   * Remove a superseded snapshot while retaining the current saved disk.
   * @param id - Superseded snapshot, never the only retained disk.
   * @param signal - Operation lifetime.
   */
  async deleteSnapshot(id: VultrSnapshotId, signal: AbortSignal): Promise<void> { await this.remove('/snapshots/' + id, signal) }
  /**
   * Read the complete instance inventory within the configured page budget.
   * @param signal - Operation lifetime.
   * @returns Complete account instance inventory, bounded by deployment configuration.
   */
  instances(signal: AbortSignal): Promise<VultrInstance[]> { return this.inventory('instances', vultrInstance, signal) }
  /**
   * Read the complete snapshot inventory within the configured page budget.
   * @param signal - Operation lifetime.
   * @returns Complete account snapshot inventory for ambiguous creation reconciliation.
   */
  snapshots(signal: AbortSignal): Promise<VultrSnapshot[]> { return this.inventory('snapshots', vultrSnapshot, signal) }

  private async inventory<T>(kind: string, schema: z.ZodType<T>, signal: AbortSignal): Promise<T[]> {
    const result: T[] = []
    let cursor: string | undefined
    const seen = new Set<string>()
    for (let page = 0; page < this.maxPages; page++) {
      const response = await this.request('GET',
        '/' + kind + '?per_page=100' + (cursor === undefined ? '' : '&cursor=' + encodeURIComponent(cursor)), undefined,
        z.object({ meta: z.object({ links: z.object({ next: z.string().nullable() }) }) }).catchall(z.unknown()), signal)
      const rows = z.array(schema).parse(response[kind])
      result.push(...rows)
      cursor = response.meta.links.next ?? undefined
      if (cursor === undefined || cursor === '') return result
      if (seen.has(cursor)) throw new VultrApiError(0, false)
      seen.add(cursor)
    }
    throw new VultrApiError(0, false)
  }

  private async remove(path: string, signal: AbortSignal): Promise<void> {
    try { await this.request('DELETE', path, undefined, z.null(), signal) }
    catch (error) { if (!(error instanceof VultrApiError && error.status === 404)) throw error }
  }

  private async request<T>(method: string, path: string, body: object | undefined, schema: z.ZodType<T>, signal: AbortSignal): Promise<T> {
    const lifetime = AbortSignal.any([signal, AbortSignal.timeout(this.timeoutMs)])
    lifetime.throwIfAborted()
    try {
      const response = await this.transport(this.endpoint + path, {
        method, signal: lifetime, redirect: 'error', headers: { authorization: 'Bearer ' + this.key, 'content-type': 'application/json' },
        ...body === undefined ? {} : { body: JSON.stringify(body) },
      })
      if (!response.ok) { await response.body?.cancel(); throw new VultrApiError(response.status, method !== 'GET'
        && response.status >= 500) }
      if (response.status === 204) return schema.parse(null)
      const reader = response.body?.getReader()
      if (reader === undefined) throw new VultrApiError(0, method !== 'GET')
      let bytes = 0
      const parts: Uint8Array[] = []
      try {
        while (true) {
          const value = await reader.read()
          if (value.done) break
          bytes += value.value.length
          if (bytes > this.maxResponseBytes) throw new VultrApiError(0, method !== 'GET')
          parts.push(value.value)
        }
      } finally { await reader.cancel(); reader.releaseLock() }
      const raw: unknown = JSON.parse(Buffer.concat(parts).toString('utf8'))
      return schema.parse(raw)
    } catch (error) {
      if (error instanceof VultrApiError) throw error
      throw new VultrApiError(0, method !== 'GET', error)
    }
  }
}
