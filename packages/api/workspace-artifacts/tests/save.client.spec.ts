// @vitest-environment jsdom
/** Temporary object URLs are scoped to the completed browser download gesture. */
import { afterEach, expect, it, vi } from 'vitest'
import { saveArtifact } from '../src/client/transfer.ts'

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); document.body.replaceChildren() })

it.each([false, true])('releases its anchor and object URL when click fails: %s', (throws) => {
  const create = vi.fn(() => 'blob:download')
  const revoke = vi.fn()
  vi.stubGlobal('URL', { createObjectURL: create, revokeObjectURL: revoke })
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
    expect(this.download).toBe('结果.bin')
    expect(this.isConnected).toBe(true)
    expect(this.hidden).toBe(true)
    if (throws) throw new Error('gesture failed')
  })
  const blob = new Blob(['abc'])
  if (throws) expect(() =>{  saveArtifact(blob, '结果.bin') }).toThrow('gesture failed')
  else saveArtifact(blob, '结果.bin')
  expect(create).toHaveBeenCalledWith(blob)
  expect(revoke).toHaveBeenCalledWith('blob:download')
  expect(document.querySelector('a')).toBeNull()
})
