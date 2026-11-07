/** Operation-local filesystem adapter; every target belongs to its original Workspace generation. */
import { AsyncLocalStorage } from 'node:async_hooks'
import { posix, relative, isAbsolute } from 'node:path'
import { FileSystem, FsError, FsTargetKey } from '@deepseek-ai/dsh-fs'
import type { FsTarget, FsInfo, FsWriteIntent, FsWriteOutcome, FsEditRequest, FsEditOutcome, FsVersion } from '@deepseek-ai/dsh-fs'
import { HarnessError } from '@deepseek-ai/dsh-llm'
import type { WorkspaceRuntimeFiles } from './backend.ts'
import type { SandboxExecutionPermit } from './conversation.ts'

/** Captured by the authorized tool call; no model argument selects these coordinates. */
interface SandboxFileOperation {
  readonly permit: SandboxExecutionPermit
  readonly files: WorkspaceRuntimeFiles
  readonly root: FsTarget
  readonly project: string
  readonly check: () => void
}

/** Private to the text-tool composition; access without an authorized operation is refused. */
export class WorkspaceToolFileSystem extends FileSystem {
  private readonly operations = new AsyncLocalStorage<SandboxFileOperation>()
  private readonly targets = new WeakMap<FsTarget, { operation: SandboxFileOperation; remote: FsTarget }>()

  /**
   * Execute native file work in its captured authorization scope.
   * @param operation - Original permission, generation and root.
   * @param action - Native executor whose filesystem calls use this scope.
   * @returns The executor's result or original failure; no newer generation is substituted.
   */
  run<T>(operation: SandboxFileOperation, action: () => Promise<T>): Promise<T> {
    return this.operations.run(operation, action)
  }

  private operation(): SandboxFileOperation {
    const operation = this.operations.getStore()
    if (operation === undefined) throw new HarnessError('This file operation has no execution permission.', 'SANDBOX_PERMISSION_REVOKED')
    operation.check()
    operation.files.assertCurrent()
    return operation
  }

  private denied(): never {
    throw new HarnessError('Use a file path inside /workspace.', 'SANDBOX_INVALID_PATH')
  }

  private path(path: string, operation: SandboxFileOperation): string {
    if (!path.trim() || !path.isWellFormed() || path.includes('\0') || path.includes('\\') || path.startsWith('~') || /^[a-z]:/iu.test(path)) this.denied()
    if (path === '/workspace' || path.startsWith('/workspace/')) return operation.files.root + path.slice('/workspace'.length)
    if (!posix.isAbsolute(path)) return path
    if (path === operation.files.root || path.startsWith(`${operation.files.root}/`)) return path
    return this.denied()
  }

  private cwd(cwd: string | undefined, operation: SandboxFileOperation): string {
    if (cwd === undefined) return operation.files.root
    const child = relative(operation.project, cwd)
    if (child === '' || child !== '..' && !child.startsWith('../') && !child.startsWith('..\\') && !isAbsolute(child)) {
      return operation.files.root + (child === '' ? '' : `/${child.replaceAll('\\', '/')}`)
    }
    return this.path(cwd, operation)
  }

  private signal(operation: SandboxFileOperation, signal?: AbortSignal): AbortSignal {
    return signal === undefined ? operation.files.signal : AbortSignal.any([operation.files.signal, signal])
  }

  private unwrap(target: FsTarget): { operation: SandboxFileOperation; remote: FsTarget } {
    const operation = this.operation()
    const record = this.targets.get(target)
    if (record?.operation !== operation) throw new HarnessError('This file target no longer has execution permission.', 'SANDBOX_PERMISSION_REVOKED')
    return record
  }

  private contained(operation: SandboxFileOperation, target: FsTarget): void {
    operation.check()
    operation.files.assertCurrent()
    if (!operation.files.fs.contains(operation.root, target)) this.denied()
  }

  private async fresh(target: FsTarget, signal?: AbortSignal) {
    const { operation, remote } = this.unwrap(target)
    const lifetime = this.signal(operation, signal)
    const fresh = await operation.files.fs.resolve(remote.displayPath, { cwd: operation.files.root, signal: lifetime })
    this.contained(operation, fresh)
    return { operation, target: fresh, signal: lifetime }
  }

  override async resolve(path: string, opts?: { cwd?: string; signal?: AbortSignal }): Promise<FsTarget> {
    const operation = this.operation()
    const remote = await operation.files.fs.resolve(this.path(path, operation), {
      cwd: this.cwd(opts?.cwd, operation), signal: this.signal(operation, opts?.signal),
    })
    this.contained(operation, remote)
    const displayPath = operation.files.displayRoot === undefined ? remote.displayPath
      : posix.join(operation.files.displayRoot, posix.relative(operation.files.root, operation.files.fs.processPath(remote)))
    const target = { targetKey: FsTargetKey(`${operation.permit.workspaceId}:${operation.permit.containerId}:${remote.targetKey}`), displayPath }
    this.targets.set(target, { operation, remote })
    return target
  }

  override processPath(target: FsTarget): string {
    const { operation, remote } = this.unwrap(target)
    return operation.files.fs.processPath(remote)
  }

  override fileUrl(target: FsTarget): string {
    const { operation, remote } = this.unwrap(target)
    return operation.files.fs.fileUrl(remote)
  }

  override contains(parent: FsTarget, child: FsTarget): boolean {
    const a = this.unwrap(parent)
    const b = this.unwrap(child)
    return a.operation.files.fs.contains(a.remote, b.remote)
  }

  override async stat(target: FsTarget, signal?: AbortSignal): Promise<FsInfo | undefined> {
    const call = await this.fresh(target, signal)
    const result = await call.operation.files.fs.stat(call.target, call.signal)
    this.operation()
    return result
  }

  override async readText(target: FsTarget, signal?: AbortSignal): Promise<string> {
    const call = await this.fresh(target, signal)
    const result = await call.operation.files.fs.readText(call.target, call.signal)
    this.operation()
    return result
  }

  override async streamText(target: FsTarget, signal?: AbortSignal): Promise<AsyncIterable<string>> {
    const call = await this.fresh(target, signal)
    const stream = await call.operation.files.fs.streamText(call.target, call.signal)
    const check = () => { this.operation() }
    return (async function* () {
      for await (const chunk of stream) { check(); yield chunk }
    })()
  }

  override async writeText(target: FsTarget, content: string, expected?: FsWriteIntent, signal?: AbortSignal): Promise<FsWriteOutcome> {
    const call = await this.fresh(target, signal)
    return this.mutation(() => call.operation.files.fs.writeText(call.target, content, expected, call.signal,
      { mode: 'workspace-write', workspaceRoot: call.operation.files.root }))
  }

  override async editText(
    target: FsTarget, edit: FsEditRequest, expected?: { version: FsVersion }, signal?: AbortSignal,
  ): Promise<FsEditOutcome> {
    const call = await this.fresh(target, signal)
    return this.mutation(() => call.operation.files.fs.editText(call.target, edit, expected, call.signal,
      { mode: 'workspace-write', workspaceRoot: call.operation.files.root }))
  }

  private async mutation<T>(action: () => Promise<T>): Promise<T> {
    try {
      const result = await action()
      this.operation()
      return result
    } catch (cause) {
      if (cause instanceof FsError && cause.code === 'FS_SANDBOX_DENIED') {
        throw new HarnessError('Use a file path inside /workspace.', 'SANDBOX_INVALID_PATH', { cause })
      }
      throw cause
    }
  }

  private unsupported<T>(): Promise<T> {
    return Promise.reject(new FsError('Only read, write and edit are available in this composition.', 'FS_IO_ERROR'))
  }
  override lstat(): ReturnType<FileSystem['lstat']> { return this.unsupported() }
  override readBytes(): ReturnType<FileSystem['readBytes']> { return this.unsupported() }
  override readByteRange(): ReturnType<FileSystem['readByteRange']> { return this.unsupported() }
  override listDir(): ReturnType<FileSystem['listDir']> { return this.unsupported() }
  override patchText(): ReturnType<FileSystem['patchText']> { return this.unsupported() }
  override deleteFile(): ReturnType<FileSystem['deleteFile']> { return this.unsupported() }
  override moveFile(): ReturnType<FileSystem['moveFile']> { return this.unsupported() }
}
