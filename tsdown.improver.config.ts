import { defineConfig } from 'tsdown'

export default defineConfig([
  { entry: { host: 'superagent-improver/src/host.ts' }, outDir: 'superagent-improver/lib', format: 'esm', platform: 'node', dts: true, clean: true, outputOptions: { entryFileNames: 'host.js' } },
  { entry: { improver: 'superagent-improver/src/main.ts' }, outDir: 'superagent-improver/lib', format: 'esm', platform: 'node', dts: false, clean: false,
    outputOptions: { entryFileNames: 'improver.js' }, deps: { neverBundle: ['zod'] } },
])
