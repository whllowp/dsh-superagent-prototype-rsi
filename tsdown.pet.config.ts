import { defineConfig } from 'tsdown'

export default defineConfig([
  { entry: { host: 'zelda-pet/src/host.ts' }, outDir: 'zelda-pet/lib', format: 'esm', platform: 'node', dts: true, clean: true, outputOptions: { entryFileNames: 'host.js' } },
  { entry: { client: 'zelda-pet/src/index.tsx' }, outDir: 'zelda-pet/lib', format: 'cjs', platform: 'browser', dts: false, clean: false,
    deps: { neverBundle: ['react', 'react/jsx-runtime', 'react-dom'] },
    outputOptions: { entryFileNames: 'client.js', banner: 'window.__ModuleLoader__.load({ id: "dsh-zelda-pet", factory: (require) => {', footer: 'return module.exports; } });', intro: 'var module = { exports: {} }; var exports = module.exports;' } },
])
