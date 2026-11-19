/**
 * Build both halves of the plugin.
 *
 * The host half is an ESM library whose `@deepseek-ai/*` imports resolve from
 * the booted profile at runtime. The browser half is the loader artifact the
 * DSH shell evaluates: a closure that calls
 * `window.__ModuleLoader__.load({ id, factory })` and receives React through the
 * injected `require`, so React, React DOM, and cordis stay external.
 *
 * `?raw` imports a stylesheet as text, as Vite does for the vendored panel
 * (`client.css?raw`); tsdown refuses bare `.css` ids, so this plugin resolves
 * them itself.
 */
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { defineConfig } from 'tsdown'

const ID = '@gamegeek-saikel/dsh-superagent-remote'

const raw = {
  name: 'raw',
  resolveId: (source: string, importer?: string) =>
    source.endsWith('?raw') && importer !== undefined ? resolve(dirname(importer), source) : undefined,
  load: (id: string) => id.endsWith('?raw')
    ? { code: `export default ${JSON.stringify(readFileSync(id.slice(0, -4), 'utf8'))}`, moduleType: 'js' as const }
    : undefined,
}

export default defineConfig([
  {
    name: `${ID}/host`,
    entry: { index: 'src/index.ts' },
    outDir: 'lib',
    format: 'esm',
    fixedExtension: false,
    platform: 'node',
    target: 'es2024',
    dts: false,
    clean: true,
    sourcemap: true,
    deps: { neverBundle: [/^@deepseek-ai\//] },
  },
  {
    name: `${ID}/client`,
    entry: { client: 'src/client/index.tsx' },
    outDir: 'lib',
    format: 'cjs',
    platform: 'browser',
    target: 'es2022',
    dts: false,
    clean: false,
    sourcemap: true,
    plugins: [raw],
    // The browser half reaches these through the loader's module table only.
    deps: { neverBundle: ['react', 'react/jsx-runtime', 'react-dom', '@deepseek-ai/cordis'] },
    outputOptions: {
      entryFileNames: 'client.js',
      banner: `window.__ModuleLoader__.load({ id: ${JSON.stringify(ID)}, factory: (require) => {`,
      footer: 'return module.exports; } });',
      intro: 'var module = { exports: {} }; var exports = module.exports;',
    },
  },
])
