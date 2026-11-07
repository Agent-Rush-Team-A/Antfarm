import { defineConfig } from 'tsdown'

export default defineConfig({
  entry: ['lib/types/{index,workspace-access}.js'],
  outputOptions: { chunkFileNames: 'shared-[hash].js' },
  outDir: 'lib', format: ['esm'], platform: 'node', target: 'es2024', fixedExtension: false, dts: false, clean: false,
})
