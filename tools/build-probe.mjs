// Builds tools/saga-copyfit-probe.js (a paste-into-DevTools script) from the
// real sources, so the probe and the pipeline share the same code.
//   node tools/build-probe.mjs
import {readFile, writeFile} from 'node:fs/promises'

const root = new URL('../', import.meta.url)
const contract = (await readFile(new URL('src/lib/pageContract.js', root), 'utf8'))
  .replace(/^export /gm, '')
  .replace(/\/\*\*[\s\S]*?\*\/\n/, '') // drop the file banner
const meter = await readFile(new URL('scripts/wiki/copyfit-meter.mjs', root), 'utf8')
const measure = meter.match(/function measureInPage\([\s\S]*?\n}\n/)?.[0]
if (!measure) throw Error('measureInPage not found in copyfit-meter.mjs')
const template = await readFile(new URL('tools/probe-template.js', root), 'utf8')
const out = template.replace('/*__CONTRACT__*/', contract).replace('/*__MEASURE__*/', measure)
await writeFile(new URL('tools/saga-copyfit-probe.js', root), out)
console.log(`tools/saga-copyfit-probe.js written (${out.length} chars)`)
