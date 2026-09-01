/**
 * esbuild client bundle for the DSH Web GUI. Replicates the monorepo tsdown
 * client contract (packages/client/tsdown.client.ts) for a third-party
 * package: one CJS closure artifact wrapped in the `window.__ModuleLoader__
 * .load({ id, factory })` handoff, resolving externals through the injected
 * `require` (the loader's module table). Baseline platform modules stay
 * external; everything else (this package's own pure folds included)
 * inlines. After emitting, the script re-reads the artifact and fails on any
 * `require()` target outside the declared externals — the build-time mirror
 * of the monorepo's client-bundle purity gate.
 */
import { build } from 'esbuild'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const outfile = join(root, 'lib', 'client.js')

/** The shell's frozen module table: implicit externals for every client bundle. */
const BASELINE_EXTERNALS = [
  'react',
  'react/jsx-runtime',
  'react-dom',
  'react-dom/client',
  '@deepseek-ai/cordis',
  '@deepseek-ai/dsh-client-store',
  '@deepseek-ai/dsh-client-ui-slots',
  '@deepseek-ai/dsh-client-ui-primitives',
]

// Factory handoff: banner opens the load() call, intro provides the CJS
// module/exports pair (esbuild emits no intro option, so it rides line 2 of
// the banner), footer returns the exports and closes the call.
const banner = [
  'window.__ModuleLoader__.load({ id: "dsh-orchestrator", factory: (require) => {',
  'var module = { exports: {} }; var exports = module.exports;',
].join('\n')
const footer = 'return module.exports; } });'

await build({
  entryPoints: [join(root, 'src/client/index.ts')],
  outfile,
  bundle: true,
  format: 'cjs',
  platform: 'browser',
  target: 'es2020',
  jsx: 'automatic',
  minify: false,
  sourcemap: true,
  external: BASELINE_EXTERNALS,
  banner: { js: banner },
  footer: { js: footer },
  logLevel: 'info',
})

// Purity gate: every require() the artifact issues must name a declared
// external; anything else means an undeclared dependency was inlined or the
// module table will throw at factory time.
const code = readFileSync(outfile, 'utf8')
const required = [...code.matchAll(/require\((['"])([^'"]+)\1\)/g)].map(match => match[2])
const undeclared = [...new Set(required.filter(spec => !BASELINE_EXTERNALS.includes(spec)))]
  .sort()
if (undeclared.length > 0) {
  throw new Error(`client bundle purity: undeclared require target(s): ${undeclared.join(', ')} — add the specifier to dsh.client.external or drop the value import`)
}
const distinct = [...new Set(required)].sort()
console.log(`client bundle: ${outfile} (${code.length} bytes)`)
console.log(`client bundle requires: ${distinct.length === 0 ? '(none)' : distinct.join(', ')}`)
