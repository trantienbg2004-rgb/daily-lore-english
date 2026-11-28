#!/usr/bin/env node
// Re-fit already published lore-v1 articles to Page Contract v1 WITHOUT
// regenerating them:
//   1. lossless paragraph merges/splits (no word changes)
//   2. targeted Gemini edits only for pages still off budget (+/- N words),
//      long headlines/captions, and focus words for the vocabulary card
//   3. factual check + catalog validation
//   4. publish the story with pageContractVersion: 1 (the reader switches to
//      PageFrame for that story only)
//
// Run where Playwright browsers are installed (CI or your machine):
//   npm run build && (npx vite preview --port 4173 &)
//   node scripts/wiki/refit-catalog.mjs --base-url http://127.0.0.1:4173 --dry-run
//   node scripts/wiki/refit-catalog.mjs --base-url http://127.0.0.1:4173 --limit 5 --webkit
// Options: --dry-run (measure + report only), --limit N, --story <sourcePageId>,
//          --webkit (also measure in WebKit), --max-rounds N (default 2)
import path from 'node:path'
import fs from 'node:fs/promises'
import {createHash} from 'node:crypto'
import {fileURLToPath} from 'node:url'
import {PAGE_CONTRACT} from '../../src/lib/pageContract.js'
import {copyfitLoop} from './copyfit-prompts.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const sha256 = text => createHash('sha256').update(text).digest('hex')

/** Full text of the passages the story cited, from the pinned revision. */
export async function rebuildEvidence(story, {fetchSource}) {
  const source = await fetchSource({pageId: story.sourcePageId, title: story.sourceTitle, revisionId: story.sourceRevisionId})
  const rows = source.paragraphDetails?.length ? source.paragraphDetails : (source.paragraphs || []).map(text => ({heading: '', text}))
  const byHash = new Map(rows.map(row => [sha256(row.text), row]))
  const evidence = []
  for (const e of story.sourceEvidence || []) {
    // Exact hash first; trimmed passages fall back to the stored excerpt prefix.
    const row = byHash.get(e.hash) || rows.find(r => e.excerpt && r.text.startsWith(e.excerpt.slice(0, 80)))
    if (row) evidence.push({id: e.id, heading: e.heading || row.heading || 'Lead', text: row.text})
  }
  return {source: {...source, sourceTitle: story.sourceTitle, sourceRevisionId: story.sourceRevisionId}, evidence}
}

/** Pure-ish core, injectable for tests. Returns {status, story?, errors?}. */
export async function refitStory(story, {meter, callGemini, fetchSource, validate, factCheck, maxRounds = 2, now = () => new Date()}) {
  const {source, evidence} = await rebuildEvidence(story, {fetchSource})
  if (!evidence.length) return {status: 'no-evidence', errors: ['cited passages not found in the pinned revision']}
  const draft = {variants: structuredClone(story.levelVariants)}
  const result = await copyfitLoop({draft, meter, source, evidence, callGemini, maxRounds})
  if (!result.ok) return {status: 'needs-attention', errors: [...result.audit].slice(0, 20), rounds: result.rounds}
  if (factCheck) {
    const facts = factCheck(result.draft, {source, evidence})
    if (facts && facts.ok === false) return {status: 'fact-check-failed', errors: facts.errors || []}
  }
  const updated = structuredClone(story)
  updated.levelVariants = result.draft.variants
  updated.pages = structuredClone(updated.levelVariants['B1-B2'].pages) // catalog rule: root pages = B1-B2
  updated.pageContractVersion = PAGE_CONTRACT.version
  updated.refitAt = now().toISOString()
  if (validate) {
    const gate = validate(updated)
    if (gate && gate.accepted === false) return {status: 'invalid', errors: gate.errors}
  }
  return {status: 'ok', story: updated, rounds: result.rounds}
}

function parseArgs(argv) {
  const out = {baseUrl: 'http://127.0.0.1:4173', limit: Infinity, dryRun: false, story: null, webkit: false, maxRounds: 2}
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--base-url') out.baseUrl = argv[++i]
    else if (a === '--limit') out.limit = Number(argv[++i])
    else if (a === '--dry-run') out.dryRun = true
    else if (a === '--story') out.story = Number(argv[++i])
    else if (a === '--webkit') out.webkit = true
    else if (a === '--max-rounds') out.maxRounds = Number(argv[++i])
  }
  return out
}

async function main() {
  const opts = parseArgs(process.argv.slice(2))
  const [{readWikiCatalog, replaceWikiStory, validateWikiStory}, {fetchWikipediaRevision}, {openCopyfitMeter}, batch] = await Promise.all([
    import('./catalog.mjs'), import('./source.mjs'), import('./copyfit-meter.mjs'), import('../publish_wiki_batch.mjs'),
  ])
  const catalog = await readWikiCatalog(ROOT)
  const todo = catalog.stories
    .filter(s => s.pageContractVersion !== PAGE_CONTRACT.version)
    .filter(s => !opts.story || s.sourcePageId === opts.story)
    .slice(0, opts.limit)
  const meter = await openCopyfitMeter(opts.baseUrl, {engines: opts.webkit ? ['chromium', 'webkit'] : ['chromium']})
  const apiKey = process.env.GEMINI_API_KEY || ''
  const callGemini = opts.dryRun || !apiKey ? null : async (prompt, schema) =>
    (await batch.callGeminiFlashLite(prompt, {apiKey, model: process.env.GEMINI_MODEL || undefined, schema})).draft
  const report = []
  try {
    for (const story of todo) {
      if (opts.dryRun) {
        const audit = await meter.audit(story.levelVariants)
        report.push({id: story.sourcePageId, title: story.title, status: audit.length ? 'off-contract' : 'fits',
          fixable: audit.fixes.length, rewrites: audit.rewrites.length, errors: [...audit].slice(0, 20)})
        continue
      }
      const res = await refitStory(story, {
        meter, callGemini, fetchSource: fetchWikipediaRevision,
        validate: validateWikiStory, factCheck: batch.validateFactualConsistency, maxRounds: opts.maxRounds,
      })
      if (res.status === 'ok') await replaceWikiStory(ROOT, res.story)
      report.push({id: story.sourcePageId, title: story.title, status: res.status, rounds: res.rounds, errors: res.errors})
      console.log(`[refit] ${res.status.padEnd(18)} ${story.title}`)
    }
  } finally {
    await meter.close()
  }
  const file = path.join(ROOT, 'refit-report.json')
  await fs.writeFile(file, JSON.stringify({contract: PAGE_CONTRACT.version, at: new Date().toISOString(), report}, null, 2))
  const counts = report.reduce((m, r) => (m[r.status] = (m[r.status] || 0) + 1, m), {})
  console.log('[refit] done', counts, '->', path.relative(ROOT, file))
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error('[refit] fatal', error); process.exit(1) })
}
