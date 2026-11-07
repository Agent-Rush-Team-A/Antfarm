import { defineConfig } from 'tsdown'

export default defineConfig({
  entry: ['lib/types/{index,conversation,bash,backend,ssh,files,idle,vultr,docker,mode-backend}.js'],
  outDir: 'lib',
  format: ['esm'],
  platform: 'node',
  target: 'es2024',
  fixedExtension: false,
  outputOptions: { chunkFileNames: 'shared-[hash].js' },
  dts: false,
  clean: false,
})
