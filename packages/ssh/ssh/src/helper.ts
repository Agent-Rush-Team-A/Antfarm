/** Private POSIX SSH helper; filesystem and process effects use the installed local providers. */
import { createHash, randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { posix } from 'node:path'
import type { Readable, Writable } from 'node:stream'
import { Context } from '@deepseek-ai/cordis'
import { brandString } from '@deepseek-ai/dsh-brand'
import { FsError, type FsTarget, type FsWriteIntent, type FsVersion } from '@deepseek-ai/dsh-fs'
import { SandboxedFileSystem } from '@deepseek-ai/dsh-fs-sandbox'
import type {} from '@deepseek-ai/dsh-subprocess'
import { LocalSubprocessRuntime } from '@deepseek-ai/dsh-subprocess-local'
import { LocalSandboxProvider } from '@deepseek-ai/dsh-sandbox-local'
import { SandboxPolicyService } from '@deepseek-ai/dsh-sandbox-policy'
import { SessionProjectionRegistry } from '@deepseek-ai/dsh-session-projection'
import type { SandboxExecutionPolicy, SandboxPolicy } from '@deepseek-ai/dsh-sandbox'
import { z } from 'zod'
import { SshRpcPeer, RemoteOperationError, SSH_MAX_PROCESS_HANDLES, SSH_MAX_TEXT_STREAMS, SSH_PROTOCOL_VERSION } from './protocol.ts'
import { RemoteProcesses } from './helper-processes.ts'
import { WorkspaceBinaryHandles } from './helper-workspace-files.ts'
import { streamWorkspaceText } from './helper-workspace-text.ts'
import { hunkSchema, moveOptionsSchema, versionGuardSchema, editSchema, environmentSchema, intentSchema, policySchema, processIdSchema, remotePath, targetSchema, textStreamIdSchema } from './schemas.ts'
import type { SshTextStreamId } from './schemas.ts'

const MAX_FRAME_BYTES = 64 * 1024 * 1024
const MAX_TEXT_BYTES = 8 * 1024 * 1024
const object = z.object({}).strict()
const processIdRequest = z.object({ id: processIdSchema }).strict()
const textStreamIdRequest = z.object({ id: textStreamIdSchema }).strict()

class SharedWorkspaceFileSystem extends SandboxedFileSystem {
  protected override newTextFileMode(target: FsTarget): number | undefined {
    const path = posix.relative(this.config.cwd, target.targetKey)
    return path === '..' || path.startsWith('../') || posix.isAbsolute(path) ? undefined : 0o660
  }
}

async function services(sharedWorkspace?: string) {
  const cwd = sharedWorkspace ?? process.cwd()
  const ctx = new Context()
  const fibers = [await ctx.plugin(SessionProjectionRegistry)]
  fibers.push(await ctx.plugin(SandboxPolicyService, { mode: 'read-only', workspaceRoot: cwd }))
  fibers.push(await ctx.plugin(sharedWorkspace === undefined ? SandboxedFileSystem : SharedWorkspaceFileSystem, { cwd }))
  fibers.push(await ctx.plugin(LocalSubprocessRuntime))
  fibers.push(await ctx.plugin(LocalSandboxProvider))
  return { ctx, close: async () => { for (const fiber of fibers.reverse()) await fiber.dispose() } }
}

/** The private helper's authenticated transport and process lifetime. */
export interface HelperTransport {
  /** Authenticated request bytes from OpenSSH. */
  input: Readable
  /** Responses carried only by OpenSSH exec stdout. */
  output: Writable
  /** Installed entry whose digest is compared by the client. */
  entryPath: string
  /** Whether the installed entry includes its own Node and worker runtime. */
  kind: 'node-script' | 'executable'
  /** Process termination joins the same cleanup as transport loss. */
  signal: AbortSignal
  /** Canonical VFS directory fixed by the trusted launcher before it dropped privileges. */
  sharedWorkspace?: string
}

/**
 * Run a helper until its channel closes or its client lease expires.
 * @param transport - private process streams, entry identity, and cancellation.
 */
export async function runSshHelper(transport: HelperTransport): Promise<void> {
  if (process.platform !== 'linux' && process.platform !== 'darwin') throw new Error('SSH helper requires a POSIX host')
  transport.signal.throwIfAborted()
  const sharedWorkspace = transport.sharedWorkspace
  const runtime = await services(sharedWorkspace)
  const { ctx } = runtime
  const root = await mkdtemp('/tmp/dsh-ssh-')
  const processes = new RemoteProcesses(ctx, root, SSH_MAX_PROCESS_HANDLES, 30_000)
  const lifetime = new AbortController()
  const iterators = new Map<SshTextStreamId, { iterator: AsyncIterator<string>; controller: AbortController }>()
  let lease: NodeJS.Timeout | undefined
  let leaseMs = 30_000
  let initialized = false
  let workspace = process.cwd()
  let binary: WorkspaceBinaryHandles | undefined
  let quiescing = false
  const writeLifetime = new AbortController()
  let cleanup: Promise<void> | undefined
  const operations = new Set<Promise<unknown>>()
  const close = (): Promise<void> => {
    cleanup ??= (async () => {
      if (lease !== undefined) clearTimeout(lease)
      lifetime.abort(new Error('SSH helper is closing'))
      writeLifetime.abort(lifetime.signal.reason)
      for (const record of iterators.values()) record.controller.abort(lifetime.signal.reason)
      await Promise.allSettled([...iterators.values()].map(async record => record.iterator.return?.()))
      iterators.clear()
      try { await processes.close() }
      finally {
        // A cancelled filesystem request can still be committing; close acknowledges quiescence.
        await Promise.allSettled(operations)
        try { await binary?.close(); await runtime.close() }
        finally { await rm(root, { recursive: true, force: true }) }
      }
    })()
    return cleanup
  }
  const touchLease = (): void => {
    if (lease !== undefined) clearTimeout(lease)
    lease = setTimeout(() => { peer.close(new Error('SSH helper client lease expired')) }, leaseMs)
  }
  const policy = async (raw: unknown, signal: AbortSignal): Promise<SandboxExecutionPolicy> => {
    const parsed = policySchema.parse(raw)
    const { sessionId, additionalWritableRoots: additional, ...fields } = parsed
    const target = await ctx.fs.resolve(parsed.workspaceRoot, { signal })
    return {
      ...fields,
      workspaceRoot: ctx.fs.processPath(target),
      ...additional === undefined ? {} : { additionalWritableRoots: additional },
      ...sessionId === undefined ? {} : { sessionId: brandString<NonNullable<SandboxExecutionPolicy['sessionId']>>(sessionId) },
    }
  }
  const asTarget = (raw: unknown): FsTarget => targetSchema.parse(raw) as FsTarget
  const dispatch = async (method: string, raw: unknown, requestSignal: AbortSignal): Promise<unknown> => {
    const mutation = ['fs.write', 'fs.edit', 'fs.patch', 'fs.delete', 'fs.move', 'workspace.uploadOpen', 'workspace.uploadChunk', 'workspace.uploadCommit', 'workspace.mkdir', 'process.prepare', 'process.start'].includes(method)
    if (mutation && quiescing) throw new RemoteOperationError('Workspace is read-only during preservation', 'FS_SANDBOX_DENIED')
    const signal = AbortSignal.any([requestSignal, lifetime.signal, ...mutation ? [writeLifetime.signal] : []])
    if (method === 'hello') {
      if (initialized) throw new Error('SSH helper handshake already completed')
      const input = z.object({
        protocol: z.literal(SSH_PROTOCOL_VERSION), workspace: remotePath, leaseMs: z.number().int().min(3000).max(600_000),
        bootstrapPath: remotePath.optional(),
      }).strict().parse(raw)
      if (transport.kind === 'executable' && input.bootstrapPath !== undefined) throw new Error('Executable SSH helper uses its embedded PTC bootstrap')
      workspace = ctx.fs.processPath(await ctx.fs.resolve(input.workspace, { signal }))
      if (sharedWorkspace !== undefined && workspace !== sharedWorkspace) throw new Error('Shared SSH helper workspace differs from its launch directory')
      leaseMs = input.leaseMs
      binary = new WorkspaceBinaryHandles(workspace, lifetime.signal, root)
      initialized = true
      touchLease()
      return {
        protocol: SSH_PROTOCOL_VERSION, hash: createHash('sha256').update(readFileSync(transport.entryPath)).digest('hex'),
        kind: transport.kind, platform: process.platform, nodeVersion: process.version, executable: process.execPath, root, workspace,
        ...(input.bootstrapPath === undefined ? {} : { bootstrapHash: createHash('sha256').update(readFileSync(input.bootstrapPath)).digest('hex') }),
      }
    }
    if (!initialized || cleanup !== undefined) throw new Error('SSH helper is not accepting operations')
    if (method.startsWith('workspace.')) {
      if (binary === undefined) throw new Error('Workspace binary service did not initialize')
      return binary.dispatch(method, raw, signal)
    }
    if (method === 'heartbeat') { object.parse(raw); touchLease(); return null }
    if (method === 'process.prepare') return processes.prepare(raw)
    if (method === 'process.start') return processes.start(processIdRequest.parse(raw).id, signal)
    if (method === 'process.done') return processes.done(processIdRequest.parse(raw).id)
    if (method === 'process.wait') return processes.wait(processIdRequest.parse(raw).id, signal)
    if (method === 'process.terminate') { await processes.terminate(processIdRequest.parse(raw).id); return null }
    if (method === 'terminal.environment') { object.parse(raw); return ctx.subprocess.terminalEnvironment(signal) }
    if (method === 'terminal.resize') {
      const input = z.object({
        id: processIdSchema, cols: z.number().int().positive(), rows: z.number().int().positive(),
      }).strict().parse(raw)
      await processes.resizeTerminal(input.id, input.cols, input.rows)
      return null
    }
    if (method === 'terminal.write' || method === 'terminal.inspect' || method === 'terminal.activity' || method === 'terminal.signal') {
      const input = z.object({ id: processIdSchema, value: z.string().optional() }).strict().parse(raw)
      return processes.terminal(input.id, method === 'terminal.write' ? 'write' : method === 'terminal.inspect' ? 'inspect' : method === 'terminal.activity' ? 'activity' : 'signal', input.value)
    }
    if (method === 'executable') {
      const input = z.object({ command: z.string(), env: environmentSchema.optional() }).strict().parse(raw)
      const env = input.env === undefined ? undefined : Object.fromEntries(
        Object.entries(input.env).filter((entry): entry is [string, string] => entry[1] !== null),
      )
      try {
        return await ctx.subprocess.resolveExecutable(input.command, env, signal)
      } catch (error) {
        if (typeof error === 'object' && error !== null
          && 'name' in error && error.name === 'SubprocessExecutableNotFoundError'
          && 'message' in error && typeof error.message === 'string') {
          throw new RemoteOperationError(error.message, 'SUBPROCESS_EXECUTABLE_NOT_FOUND')
        }
        throw error
      }
    }
    if (method === 'sandbox') {
      const input = z.object({ argv: z.array(z.string()).min(1), policy: policySchema }).strict().parse(raw)
      const resolved = await policy(input.policy, signal)
      if (resolved.mode === 'danger-full-access') throw new Error('Unconfined argv does not need a sandbox wrapper')
      return ctx.sandbox.confine(input.argv, resolved as SandboxPolicy, signal)
    }
    if (method === 'fs.resolve' || method === 'fs.lstat') {
      const input = z.object({ path: z.string(), cwd: remotePath.optional() }).strict().parse(raw)
      return method === 'fs.resolve' ? ctx.fs.resolve(input.path, { cwd: input.cwd ?? workspace, signal }) : await ctx.fs.lstat(input.path, { cwd: input.cwd ?? workspace }, signal) ?? null
    }
    if (method === 'fs.stat' || method === 'fs.list' || method === 'fs.readText' || method === 'fs.stream') {
      const input = (method === 'fs.readText' || method === 'fs.stream'
        ? z.object({ target: targetSchema, workspaceOnly: z.boolean().optional() }).strict()
        : z.object({ target: targetSchema }).strict()).parse(raw)
      const target = asTarget(input.target)
      const textStream = (cancellation: AbortSignal) => 'workspaceOnly' in input && input.workspaceOnly === true
        ? streamWorkspaceText(ctx.fs, workspace, target, cancellation)
        : ctx.fs.streamText(target, cancellation)
      if (method === 'fs.stat') return await ctx.fs.stat(target, signal) ?? null
      if (method === 'fs.list') return ctx.fs.listDir(target, signal)
      if (method === 'fs.stream') {
        if (iterators.size >= SSH_MAX_TEXT_STREAMS) throw new Error('SSH text stream limit reached')
        const controller = new AbortController()
        const stream = await textStream(AbortSignal.any([signal, controller.signal]))
        const iterator = stream[Symbol.asyncIterator]()
        try {
          signal.throwIfAborted()
          if (iterators.size >= SSH_MAX_TEXT_STREAMS) throw new Error('SSH text stream limit reached')
          const id = randomUUID() as SshTextStreamId
          iterators.set(id, { iterator, controller })
          return id
        } catch (error) {
          controller.abort(error)
          await iterator.return?.()
          throw error
        }
      }
      const stream = await textStream(signal)
      let text = ''
      let bytes = 0
      for await (const chunk of stream) {
        bytes += Buffer.byteLength(chunk)
        if (bytes > MAX_TEXT_BYTES) throw new FsError('SSH whole-text transfer exceeds its bounded frame budget; use streaming', 'FS_TOO_LARGE')
        text += chunk
      }
      return text
    }
    if (method === 'fs.next' || method === 'fs.streamClose') {
      const { id } = textStreamIdRequest.parse(raw)
      const record = iterators.get(id)
      if (record === undefined) throw new Error('Unknown SSH text stream')
      if (method === 'fs.streamClose') {
        iterators.delete(id)
        record.controller.abort(new Error('SSH text stream closed'))
        await record.iterator.return?.()
        return null
      }
      const abort = (): void => { record.controller.abort(signal.reason) }
      signal.addEventListener('abort', abort, { once: true })
      try {
        signal.throwIfAborted()
        const next = await record.iterator.next()
        if (next.done) iterators.delete(id)
        return { done: next.done ?? false, value: next.done ? '' : next.value }
      } catch (error) {
        iterators.delete(id)
        record.controller.abort(error)
        await record.iterator.return?.()
        throw error
      } finally { signal.removeEventListener('abort', abort) }
    }
    if (method === 'fs.readBytes' || method === 'fs.readRange') {
      const input = z.object({
        target: targetSchema, maxBytes: z.number().int().nonnegative().optional(),
        offset: z.number().int().nonnegative().optional(), length: z.number().int().nonnegative().optional(),
      }).strict().parse(raw)
      const target = asTarget(input.target)
      const bytes = method === 'fs.readBytes'
        ? await ctx.fs.readBytes(target, signal, Math.min(z.number().int().nonnegative().parse(input.maxBytes), MAX_TEXT_BYTES))
        : await ctx.fs.readByteRange(target, {
          offset: z.number().int().nonnegative().parse(input.offset),
          length: z.number().int().nonnegative().max(MAX_TEXT_BYTES).parse(input.length),
        }, signal)
      return Buffer.from(bytes).toString('base64')
    }
    if (method === 'fs.write' || method === 'fs.edit') {
      const input = z.object({
        target: targetSchema, content: z.string().optional(), edit: editSchema.optional(),
        expected: z.union([intentSchema, z.object({ version: z.string() }).strict()]).optional(), policy: policySchema,
      }).strict().parse(raw)
      const target = asTarget(input.target)
      const resolved = await policy(input.policy, signal)
      if (method === 'fs.write') return ctx.fs.writeText(
        target, z.string().parse(input.content),
        input.expected === undefined ? undefined : intentSchema.parse(input.expected) as FsWriteIntent, signal, resolved,
      )
      return ctx.fs.editText(
        target, editSchema.parse(input.edit),
        input.expected === undefined
          ? undefined : z.object({ version: z.string() }).strict().parse(input.expected) as { version: FsVersion },
        signal, resolved,
      )
    }
    if (method === 'fs.patch' || method === 'fs.delete') {
      const schema = z.object({ target: targetSchema, expected: versionGuardSchema.optional(), policy: policySchema }).strict()
      if (method === 'fs.patch') {
        const input = schema.extend({ hunks: z.array(hunkSchema) }).parse(raw)
        return ctx.fs.patchText(asTarget(input.target), input.hunks,
          input.expected as { version: FsVersion } | undefined, signal, await policy(input.policy, signal))
      }
      const input = schema.parse(raw)
      return ctx.fs.deleteFile(asTarget(input.target), input.expected as { version: FsVersion } | undefined,
        signal, await policy(input.policy, signal))
    }
    if (method === 'fs.move') {
      const input = z.object({
        source: targetSchema, destination: targetSchema, options: moveOptionsSchema, policy: policySchema,
      }).strict().parse(raw)
      const { hunks, expectedSource, expectedDestination } = input.options
      return ctx.fs.moveFile(asTarget(input.source), asTarget(input.destination), {
        ...(hunks === undefined ? {} : { hunks }),
        ...(expectedSource === undefined ? {} : { expectedSource: { version: expectedSource.version as FsVersion } }),
        ...(expectedDestination === undefined ? {} : { expectedDestination: expectedDestination as FsWriteIntent }),
      }, signal, await policy(input.policy, signal))
    }
    throw new Error(`Unknown SSH helper operation: ${method}`)
  }
  const peer = new SshRpcPeer(transport.input, transport.output, MAX_FRAME_BYTES, 128, async (method, raw, requestSignal) => {
    if (!initialized && method !== 'hello' || cleanup !== undefined) throw new Error('SSH helper is not accepting operations')
    if (method === 'close') { object.parse(raw); await close(); return null }
    if (method === 'workspace.quiesce') {
      object.parse(raw)
      quiescing = true
      writeLifetime.abort(new Error('Workspace preservation revoked writes'))
      await binary?.quiesce()
      await processes.close()
      await Promise.allSettled([...operations])
      return null
    }
    const operation = dispatch(method, raw, requestSignal)
    operations.add(operation)
    try { return await operation }
    finally { operations.delete(operation) }
  })
  const closed = Promise.withResolvers<undefined>()
  peer.once('closed', () => {
    void close().catch(() => {})
    closed.resolve(undefined)
  })
  const onAbort = (): void => { peer.close(new Error('SSH helper transport was terminated')) }
  transport.signal.addEventListener('abort', onAbort, { once: true })
  if (transport.signal.aborted) onAbort()
  else touchLease()
  try { await closed.promise; await close() }
  finally { transport.signal.removeEventListener('abort', onAbort) }

}
