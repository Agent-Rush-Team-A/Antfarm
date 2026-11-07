import { expect, test } from 'vitest'
import { z } from 'zod'
import { randomUUID } from 'node:crypto'
import { SshWorkspaceFiles } from '../src/workspace-files.ts'

test.each(['../secret', 'parent/child', '',
  'bad\0name'])('rejects the remote directory leaf %j before it can form a local copy path', async (name) => {
  const signal = new AbortController().signal
  const files = new SshWorkspaceFiles({
    signal, request: async <T>(_method: string, _fields: unknown, schema: z.ZodType<T>) => schema.parse({ entries: [{ name, kind: 'file', bytes: 1 }], truncated: false }) })
  await expect(files.list('', 10, signal)).rejects.toMatchObject({ reason: 'io' })
})

test('rejects a remote listing above the caller entry budget', async () => {
  const signal = new AbortController().signal
  const files = new SshWorkspaceFiles({
    signal, request: async <T>(_method: string, _fields: unknown, schema: z.ZodType<T>) => schema.parse({ entries: [{ name: 'one', kind: 'file' }, { name: 'two', kind: 'file' }], truncated: false }) })
  await expect(files.list('', 1, signal)).rejects.toMatchObject({ reason: 'io' })
})

test('rejects a remote file extent above the complete-file byte budget', async () => {
  const signal = new AbortController().signal
  const files = new SshWorkspaceFiles({
    signal, request: async <T>(_method: string, _fields: unknown, schema: z.ZodType<T>) => schema.parse({ id: randomUUID(), bytes: 11 }) })
  await expect(files.download('file', 10, signal, () => {})).rejects.toMatchObject({ reason: 'io' })
})

test('a lost upload-commit acknowledgement reports unknown publication rather than a definite failed write', async () => {
  const signal = new AbortController().signal
  const id = randomUUID()
  const files = new SshWorkspaceFiles({ signal, request: async <T>(method: string, _fields: unknown, schema: z.ZodType<T>) => {
    if (method === 'workspace.uploadOpen') return schema.parse(id)
    if (method === 'workspace.uploadChunk') return schema.parse(null)
    throw new Error('Acknowledgement lost')
  } })
  const chunks = (async function* () { yield Buffer.from('published remotely') })()
  await expect(files.upload('file', chunks, 100, signal, () => {})).rejects.toMatchObject({ reason: 'unknown', stored: false })
})
