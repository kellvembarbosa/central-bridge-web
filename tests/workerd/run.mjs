// Optional smoke test inside workerd (the Cloudflare Workers runtime):
//
//   npm install --no-save esbuild miniflare@4 && npm run test:workerd
//
// Bundles tests/workerd/worker.ts and runs it in Miniflare with a real D1
// binding. esbuild/miniflare are not dependencies of the package; they are
// resolved from node_modules (MINIFLARE_PATH overrides the miniflare entry).
import { existsSync } from 'node:fs'

const { build } = await import('esbuild')
const { Miniflare } = await import(process.env.MINIFLARE_PATH ?? 'miniflare')

// Standalone repo: ./test-vectors. Monorepo: ../bridge-test-vectors (canonical).
const local = new URL('../../test-vectors', import.meta.url)
const vectors = existsSync(local) ? local : new URL('../../../bridge-test-vectors', import.meta.url)

const bundled = await build({
  alias: { 'bridge-test-vectors': vectors.pathname },
  entryPoints: [new URL('./worker.ts', import.meta.url).pathname],
  bundle: true,
  format: 'esm',
  platform: 'neutral',
  write: false,
})

const mf = new Miniflare({
  modules: true,
  script: bundled.outputFiles[0].text,
  compatibilityDate: '2025-09-01',
  d1Databases: ['DB'],
})
try {
  const checks = await (await mf.dispatchFetch('https://product.test/')).json()
  for (const [name, ok] of Object.entries(checks)) console.log(`${ok === true ? '✔' : '✖'} ${name}`)
  if (Object.values(checks).some((ok) => ok !== true)) process.exitCode = 1
} finally {
  await mf.dispose()
}
