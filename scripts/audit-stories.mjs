import fs from 'node:fs/promises'
import path from 'node:path'

// Read-only audit of the PUBLISHED feed, not the legacy stories.json file.
const root = 'public/feed'
const manifest = JSON.parse(await fs.readFile(path.join(root, 'manifest.json'), 'utf8'))
if (!Number.isSafeInteger(manifest.chunks) || manifest.chunks < 1) throw Error('Invalid feed manifest: chunks')
const raw = []
for (let i = 0; i < manifest.chunks; i++) {
  const file = path.join(root, `${String(i).padStart(4, '0')}.json`)
  const chunk = JSON.parse(await fs.readFile(file, 'utf8'))
  if (!Array.isArray(chunk)) throw Error(`Invalid feed chunk: ${file}`)
  raw.push(...chunk)
}
const idOf = s => s?.sourceUrl || s?.sourceTitle || `${s?.category}:${s?.title}`
const unique = new Map()
let duplicates = 0
for (const story of raw) {
  const id = idOf(story)
  if (unique.has(id)) duplicates++
  else unique.set(id, story)
}
const stories = [...unique.values()]
const words = s => (String(s || '').match(/[\p{L}\p{N}]+(?:[’'-][\p{L}\p{N}]+)*/gu) || []).length
const stats = {manifestTotal:manifest.total,rawEntries:raw.length,total:stories.length,news:0,knowledge:0,other:0,short:0,missingSource:0,duplicate:duplicates,missingImage:0,onePage:0,readyForReview:0}
const issues = []
for (const [index, story] of stories.entries()) {
  const pages = Array.isArray(story?.pages) ? story.pages : []
  const count = pages.reduce((n, p) => n + words(p?.text), 0)
  const type = story?.contentType === 'news' ? 'news' : story?.contentType === 'knowledge' ? 'knowledge' : 'other'
  stats[type]++
  const reasons = []
  if (!/^https:\/\//.test(story?.sourceUrl || '')) { reasons.push('missing-source'); stats.missingSource++ }
  if (pages.length < 2) { reasons.push('one-page'); stats.onePage++ }
  if (count < 180) { reasons.push('short-under-180-words'); stats.short++ }
  if (!pages.length || pages.some(p => !/^https:\/\//.test(p?.image || ''))) { reasons.push('missing-image'); stats.missingImage++ }
  if (count >= 180 && count <= 450 && pages.length >= 3 && pages.length <= 6 && reasons.length === 0) stats.readyForReview++
  if (reasons.length) issues.push({index, title:story?.title || '(untitled)',type,pages:pages.length,words:count,reasons})
}
const warnings = []
if (Number.isFinite(manifest.total) && manifest.total !== raw.length) warnings.push(`Manifest says ${manifest.total} entries, but chunks contain ${raw.length}`)
if (duplicates) warnings.push(`${duplicates} repeated story IDs across feed chunks`)
const report = {note:'Structural checks only; not a judgment of factual accuracy, writing quality, image resolution, or licensing.',source:'public/feed/manifest.json + all feed chunks',stats,warnings,issues}
await fs.mkdir('reports', {recursive:true})
await fs.writeFile('reports/story-quality-audit.json', JSON.stringify(report,null,2)+'\n')
const lines = [
  '# Daily Lore English — Full published feed audit','',
  '> Read-only report. No website data was changed.',
  '> Passing structural checks does not establish editorial quality or accuracy.','',
  `- Feed entries: **${stats.rawEntries}**; unique stories: **${stats.total}**; manifest total: **${stats.manifestTotal}**`,
  `- News: **${stats.news}**; knowledge: **${stats.knowledge}**; other: **${stats.other}**`,
  `- Under 180 words: **${stats.short}**; one-page: **${stats.onePage}**`,
  `- Missing source: **${stats.missingSource}**; duplicate IDs: **${stats.duplicate}**; missing images: **${stats.missingImage}**`,
  `- Structural review candidates: **${stats.readyForReview}**`, '',
  ...warnings.map(w=>`- WARNING: ${w}`),'',
  '| # | Story | Type | Pages | Words | Issues |',
  '|---:|---|---|---:|---:|---|',
  ...issues.map(x=>`| ${x.index+1} | ${String(x.title).replaceAll('|','\\|').slice(0,75)} | ${x.type} | ${x.pages} | ${x.words} | ${x.reasons.join(', ')} |`),'',
]
await fs.writeFile('reports/story-quality-audit.md',lines.join('\n'))
console.log(`Audited ${stats.total} unique stories from ${manifest.chunks} feed chunks (${raw.length} entries).`)
console.log(`${stats.short} short; ${stats.onePage} one-page; ${stats.readyForReview} structural review candidates.`)
console.log('Report: reports/story-quality-audit.md')
