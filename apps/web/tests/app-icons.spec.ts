/** Committed install icon dimensions and the generator's SVG crop and safe-zone scale. */
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  APP_ICON_VARIANTS, ICON_OUTPUT_DIRECTORY, MASKABLE_ARTWORK_SCALE, TILE_SOURCE,
  maskableDocument, tileDocument,
} from '../scripts/render-app-icons.ts'
import { pngSize } from './png-size.ts'

describe('web install icons', () => {
  it('ships every declared variant at its declared edge', async () => {
    for (const variant of APP_ICON_VARIANTS) {
      expect(pngSize(await readFile(join(ICON_OUTPUT_DIRECTORY, variant.file))))
        .toEqual([variant.size, variant.size])
    }
  })

  it('uses the Web ant on an opaque tile and scales only the maskable artwork', async () => {
    const source = await readFile(TILE_SOURCE, 'utf8')
    const tile = tileDocument(source)
    const maskable = maskableDocument(source)
    expect(tile).toContain('viewBox="0 0 64 64"')
    expect(tile).toContain('<rect width="64" height="64" fill="#ffffff"/>')
    expect(tile).not.toContain(`scale(${MASKABLE_ARTWORK_SCALE})`)
    expect(tile).toContain('<g id="app-artwork">')
    expect(tile).toContain(source.match(/<path\b[^>]*>/u)![0])
    expect(tile).toContain(source.match(/<ellipse\b[^>]*>/u)![0])
    expect(maskable).toContain(`transform="translate(32 32) scale(${MASKABLE_ARTWORK_SCALE}) translate(-32 -32)"`)
  })

  it('rejects non-PNG bytes and incomplete image headers', () => {
    expect(() => pngSize(Buffer.from('<svg/>'))).toThrow(/PNG IHDR/)
    expect(() => pngSize(Buffer.alloc(33))).toThrow(/PNG IHDR/)
  })

  it('fails loudly on a source without the tile it transforms', () => {
    expect(() => tileDocument('')).toThrow(/no root element/)
    expect(() => tileDocument('<svg></svg>')).toThrow(/square viewBox/)
    expect(() => maskableDocument('<svg viewBox="0 0 64 64">')).toThrow(/no closing SVG element/)
  })
})
