/**
 * Wrap the tsc-emitted CommonJS client bundle into the DSH module-system
 * closure factory:
 *
 *   window.__ModuleLoader__.load({ id, factory: (require) => { ... } })
 *
 * `require` here is the factory parameter that resolves platform modules
 * (react etc.); `module`/`exports` are introduced so the CJS body can assign.
 */
import { readFileSync, writeFileSync } from 'node:fs'

const body = readFileSync('lib/client/index.js', 'utf8')
const bundle =
  'window.__ModuleLoader__.load({ id: "dsh-qq-bot", factory: (require) => {\n' +
  'var module = { exports: {} }; var exports = module.exports;\n' +
  body +
  '\nreturn module.exports; } });\n'

writeFileSync('lib/client.js', bundle)
console.log('built lib/client.js')
