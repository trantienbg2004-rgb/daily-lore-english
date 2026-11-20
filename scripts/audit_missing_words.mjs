#!/usr/bin/env node
/**
 * Read-only Dictionary & Multi-Word Coverage Audit for SAGA.
 *
 * Scans ALL article JSON files across all CEFR levels (`A1-A2`, `B1-B2`, `C1-C2`)
 * in `public/wiki-reader/` (and any custom --articles-dir) using the exact same
 * tokenizer and lookup/lemmatization pipeline as production:
 *   - `src/utils/dictionaryTokenizer.js`
 *   - `src/services/dictionaryService.js`
 *
 * Strictly read-only: modifies zero app files, zero articles, and zero dictionary shards.
 */

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { tokenizeWithGlossary } from '../src/utils/dictionaryTokenizer.js'
import {
  clearDictionaryCache,
  loadLemmaMap,
  loadPhraseMap,
  lookupDictionaryTerm,
  normalizeLookupTerm,
  shardKeyFor,
  suffixLemmaCandidates,
} from '../src/services/dictionaryService.js'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const DEFAULT_ARTICLES_DIR = path.join(ROOT, 'public', 'wiki-reader')
const DEFAULT_DICT_DIR = path.join(ROOT, 'public', 'dict')

// Curated high-frequency phrasal verbs (canonical lemma -> verb inflections + particle)
const PHRASAL_VERBS = [
  ['account for', ['account', 'accounts', 'accounted', 'accounting'], 'for'],
  ['adapt to', ['adapt', 'adapts', 'adapted', 'adapting'], 'to'],
  ['add up', ['add', 'adds', 'added', 'adding'], 'up'],
  ['back up', ['back', 'backs', 'backed', 'backing'], 'up'],
  ['break down', ['break', 'breaks', 'broke', 'broken', 'breaking'], 'down'],
  ['break out', ['break', 'breaks', 'broke', 'broken', 'breaking'], 'out'],
  ['break through', ['break', 'breaks', 'broke', 'broken', 'breaking'], 'through'],
  ['break up', ['break', 'breaks', 'broke', 'broken', 'breaking'], 'up'],
  ['bring about', ['bring', 'brings', 'brought', 'bringing'], 'about'],
  ['bring back', ['bring', 'brings', 'brought', 'bringing'], 'back'],
  ['bring down', ['bring', 'brings', 'brought', 'bringing'], 'down'],
  ['bring together', ['bring', 'brings', 'brought', 'bringing'], 'together'],
  ['build up', ['build', 'builds', 'built', 'building'], 'up'],
  ['call for', ['call', 'calls', 'called', 'calling'], 'for'],
  ['call off', ['call', 'calls', 'called', 'calling'], 'off'],
  ['carry on', ['carry', 'carries', 'carried', 'carrying'], 'on'],
  ['carry out', ['carry', 'carries', 'carried', 'carrying'], 'out'],
  ['catch on', ['catch', 'catches', 'caught', 'catching'], 'on'],
  ['catch up', ['catch', 'catches', 'caught', 'catching'], 'up'],
  ['clear up', ['clear', 'clears', 'cleared', 'clearing'], 'up'],
  ['come across', ['come', 'comes', 'came', 'coming'], 'across'],
  ['come back', ['come', 'comes', 'came', 'coming'], 'back'],
  ['come down', ['come', 'comes', 'came', 'coming'], 'down'],
  ['come from', ['come', 'comes', 'came', 'coming'], 'from'],
  ['come out', ['come', 'comes', 'came', 'coming'], 'out'],
  ['come up with', ['come', 'comes', 'came', 'coming'], 'up with'],
  ['come up', ['come', 'comes', 'came', 'coming'], 'up'],
  ['cut back', ['cut', 'cuts', 'cutting'], 'back'],
  ['cut down', ['cut', 'cuts', 'cutting'], 'down'],
  ['cut off', ['cut', 'cuts', 'cutting'], 'off'],
  ['deal with', ['deal', 'deals', 'dealt', 'dealing'], 'with'],
  ['depend on', ['depend', 'depends', 'depended', 'depending'], 'on'],
  ['die out', ['die', 'dies', 'died', 'dying'], 'out'],
  ['draw on', ['draw', 'draws', 'drew', 'drawn', 'drawing'], 'on'],
  ['end up', ['end', 'ends', 'ended', 'ending'], 'up'],
  ['fall apart', ['fall', 'falls', 'fell', 'fallen', 'falling'], 'apart'],
  ['fall behind', ['fall', 'falls', 'fell', 'fallen', 'falling'], 'behind'],
  ['figure out', ['figure', 'figures', 'figured', 'figuring'], 'out'],
  ['fill in', ['fill', 'fills', 'filled', 'filling'], 'in'],
  ['find out', ['find', 'finds', 'found', 'finding'], 'out'],
  ['focus on', ['focus', 'focuses', 'focused', 'focusing'], 'on'],
  ['get rid of', ['get', 'gets', 'got', 'gotten', 'getting'], 'rid of'],
  ['give rise to', ['give', 'gives', 'gave', 'given', 'giving'], 'rise to'],
  ['give up', ['give', 'gives', 'gave', 'given', 'giving'], 'up'],
  ['give way to', ['give', 'gives', 'gave', 'given', 'giving'], 'way to'],
  ['go on', ['go', 'goes', 'went', 'gone', 'going'], 'on'],
  ['go through', ['go', 'goes', 'went', 'gone', 'going'], 'through'],
  ['grow out of', ['grow', 'grows', 'grew', 'grown', 'growing'], 'out of'],
  ['grow up', ['grow', 'grows', 'grew', 'grown', 'growing'], 'up'],
  ['hand over', ['hand', 'hands', 'handed', 'handing'], 'over'],
  ['hold back', ['hold', 'holds', 'held', 'holding'], 'back'],
  ['hold on', ['hold', 'holds', 'held', 'holding'], 'on'],
  ['keep up with', ['keep', 'keeps', 'kept', 'keeping'], 'up with'],
  ['keep up', ['keep', 'keeps', 'kept', 'keeping'], 'up'],
  ['lay off', ['lay', 'lays', 'laid', 'laying'], 'off'],
  ['lead to', ['lead', 'leads', 'led', 'leading'], 'to'],
  ['look after', ['look', 'looks', 'looked', 'looking'], 'after'],
  ['look for', ['look', 'looks', 'looked', 'looking'], 'for'],
  ['look forward to', ['look', 'looks', 'looked', 'looking'], 'forward to'],
  ['look into', ['look', 'looks', 'looked', 'looking'], 'into'],
  ['make sense', ['make', 'makes', 'made', 'making'], 'sense'],
  ['make up for', ['make', 'makes', 'made', 'making'], 'up for'],
  ['make up', ['make', 'makes', 'made', 'making'], 'up'],
  ['make use of', ['make', 'makes', 'made', 'making'], 'use of'],
  ['move on', ['move', 'moves', 'moved', 'moving'], 'on'],
  ['open up', ['open', 'opens', 'opened', 'opening'], 'up'],
  ['pass away', ['pass', 'passes', 'passed', 'passing'], 'away'],
  ['pass down', ['pass', 'passes', 'passed', 'passing'], 'down'],
  ['pass on', ['pass', 'passes', 'passed', 'passing'], 'on'],
  ['pay attention to', ['pay', 'pays', 'paid', 'paying'], 'attention to'],
  ['pay off', ['pay', 'pays', 'paid', 'paying'], 'off'],
  ['phase out', ['phase', 'phases', 'phased', 'phasing'], 'out'],
  ['pick up', ['pick', 'picks', 'picked', 'picking'], 'up'],
  ['play a role', ['play', 'plays', 'played', 'playing'], 'a role'],
  ['play out', ['play', 'plays', 'played', 'playing'], 'out'],
  ['point out', ['point', 'points', 'pointed', 'pointing'], 'out'],
  ['pull out', ['pull', 'pulls', 'pulled', 'pulling'], 'out'],
  ['push back', ['push', 'pushes', 'pushed', 'pushing'], 'back'],
  ['put forward', ['put', 'puts', 'putting'], 'forward'],
  ['put off', ['put', 'puts', 'putting'], 'off'],
  ['put together', ['put', 'puts', 'putting'], 'together'],
  ['rely on', ['rely', 'relies', 'relied', 'relying'], 'on'],
  ['result in', ['result', 'results', 'resulted', 'resulting'], 'in'],
  ['roll out', ['roll', 'rolls', 'rolled', 'rolling'], 'out'],
  ['rule out', ['rule', 'rules', 'ruled', 'ruling'], 'out'],
  ['run into', ['run', 'runs', 'ran', 'running'], 'into'],
  ['run out of', ['run', 'runs', 'ran', 'running'], 'out of'],
  ['run out', ['run', 'runs', 'ran', 'running'], 'out'],
  ['scale up', ['scale', 'scales', 'scaled', 'scaling'], 'up'],
  ['set off', ['set', 'sets', 'setting'], 'off'],
  ['set out', ['set', 'sets', 'setting'], 'out'],
  ['set up', ['set', 'sets', 'setting'], 'up'],
  ['show up', ['show', 'shows', 'showed', 'shown', 'showing'], 'up'],
  ['shut down', ['shut', 'shuts', 'shutting'], 'down'],
  ['slow down', ['slow', 'slows', 'slowed', 'slowing'], 'down'],
  ['speed up', ['speed', 'speeds', 'sped', 'speeding'], 'up'],
  ['stand for', ['stand', 'stands', 'stood', 'standing'], 'for'],
  ['stand out', ['stand', 'stands', 'stood', 'standing'], 'out'],
  ['stem from', ['stem', 'stems', 'stemmed', 'stemming'], 'from'],
  ['step down', ['step', 'steps', 'stepped', 'stepping'], 'down'],
  ['step up', ['step', 'steps', 'stepped', 'stepping'], 'up'],
  ['take advantage of', ['take', 'takes', 'took', 'taken', 'taking'], 'advantage of'],
  ['take away', ['take', 'takes', 'took', 'taken', 'taking'], 'away'],
  ['take off', ['take', 'takes', 'took', 'taken', 'taking'], 'off'],
  ['take on', ['take', 'takes', 'took', 'taken', 'taking'], 'on'],
  ['take over', ['take', 'takes', 'took', 'taken', 'taking'], 'over'],
  ['take part in', ['take', 'takes', 'took', 'taken', 'taking'], 'part in'],
  ['take place', ['take', 'takes', 'took', 'taken', 'taking'], 'place'],
  ['take up', ['take', 'takes', 'took', 'taken', 'taking'], 'up'],
  ['turn down', ['turn', 'turns', 'turned', 'turning'], 'down'],
  ['turn into', ['turn', 'turns', 'turned', 'turning'], 'into'],
  ['turn out', ['turn', 'turns', 'turned', 'turning'], 'out'],
  ['wipe out', ['wipe', 'wipes', 'wiped', 'wiping'], 'out'],
  ['work out', ['work', 'works', 'worked', 'working'], 'out'],
]

// Curated high-frequency multi-word expressions / discourse collocations / idioms
const MULTI_WORD_EXPRESSIONS = [
  'according to',
  'as a result',
  'as long as',
  'as opposed to',
  'as soon as',
  'as well as',
  'at first',
  'at least',
  'at risk',
  'at stake',
  'at the same time',
  'because of',
  'by contrast',
  'by means of',
  'contrary to',
  'due to',
  'even though',
  'far from',
  'for example',
  'for instance',
  'hand in hand',
  'in addition to',
  'in addition',
  'in charge of',
  'in contrast to',
  'in contrast',
  'in effect',
  'in fact',
  'in favor of',
  'in general',
  'in light of',
  'in order to',
  'in particular',
  'in place',
  'in practice',
  'in response to',
  'in return',
  'in spite of',
  'in terms of',
  'in the wake of',
  'in theory',
  'in turn',
  'instead of',
  'no longer',
  'on behalf of',
  'on the other hand',
  'on track',
  'out of',
  'over time',
  'prior to',
  'rather than',
  'regardless of',
  'side by side',
  'so far',
  'step by step',
  'subject to',
  'such as',
  'thanks to',
  'under pressure',
  'up to',
  'with regard to',
  'with respect to',
]

function compilePhraseMatchers() {
  const matchers = []
  for (const [lemma, verbs, particle] of PHRASAL_VERBS) {
    const verbAlt = verbs.join('|')
    const partPat = particle.replace(/\s+/g, '\\s+')
    matchers.push({
      lemma,
      kind: 'phrasal_verb',
      regex: new RegExp(`\\b(?:${verbAlt})\\s+${partPat}\\b`, 'giu'),
      length: lemma.length,
    })
  }
  for (const expr of MULTI_WORD_EXPRESSIONS) {
    const pat = expr.replace(/\s+/g, '\\s+')
    matchers.push({
      lemma: expr,
      kind: 'expression',
      regex: new RegExp(`\\b${pat}\\b`, 'giu'),
      length: expr.length,
    })
  }
  // Longest first so e.g. "come up with" takes precedence over "come up"
  matchers.sort((a, b) => b.length - a.length || a.lemma.localeCompare(b.lemma))
  return matchers
}

function splitSentences(text) {
  return (String(text || '').match(/[^.!?]+[.!?]*|[^.!?]+$/g) || [])
    .map(s => s.replace(/\s+/g, ' ').trim())
    .filter(Boolean)
}

function loadArticleFiles(articlesDir) {
  const files = fs
    .readdirSync(articlesDir)
    .filter(f => f.endsWith('.json') && f !== 'manifest.json' && !f.startsWith('catalog-index'))
    .sort()

  const articles = []
  for (const file of files) {
    const full = path.join(articlesDir, file)
    const raw = JSON.parse(fs.readFileSync(full, 'utf8'))
    if (Array.isArray(raw)) {
      for (const item of raw) {
        if (item && typeof item === 'object') articles.push({ file, story: item })
      }
    } else if (raw && typeof raw === 'object') {
      const list = raw.stories || raw.articles || raw.items
      if (Array.isArray(list)) {
        for (const item of list) {
          if (item && typeof item === 'object') articles.push({ file, story: item })
        }
      } else {
        articles.push({ file, story: raw })
      }
    }
  }
  return articles
}

function createLocalDictTools(dictDir) {
  const rawShardCache = new Map()
  const fetchImpl = async url => {
    const rel = String(url).replace(/^\/+/, '').replace(/^dict\//, '')
    const fullPath = path.join(dictDir, rel)
    if (!fs.existsSync(fullPath)) {
      return { ok: false, status: 404, async json() { return null } }
    }
    const parsed = JSON.parse(fs.readFileSync(fullPath, 'utf8'))
    return { ok: true, status: 200, async json() { return parsed } }
  }

  const hasExactInShard = word => {
    const norm = normalizeLookupTerm(word)
    if (!norm || !/[a-z]/u.test(norm)) return false
    const key = shardKeyFor(norm)
    if (!rawShardCache.has(key)) {
      const full = path.join(dictDir, `${key}.json`)
      rawShardCache.set(key, fs.existsSync(full) ? JSON.parse(fs.readFileSync(full, 'utf8')) : {})
    }
    return Boolean(rawShardCache.get(key)[norm])
  }

  return { fetchImpl, hasExactInShard }
}

/**
 * Deeper inflection-base check to detect words ending in -s/-es/-ies/-ed/-ing/-ly
 * whose base word actually exists in public/dict/ even if lookupDictionaryTerm missed it.
 */
function findUnmatchedInflectionBase(word, hasExactInShard) {
  const w = normalizeLookupTerm(word)
  if (!w || w.includes(' ') || w.includes('-') || w.includes("'")) return ''
  if (!/(?:s|es|ies|ed|ied|ing|ly|ily|er|est)$/u.test(w)) return ''

  const cands = new Set(suffixLemmaCandidates(w))
  // Additional morphological patterns that safe suffix stripping may miss
  if (w.endsWith('s') && w.length > 3) cands.add(w.slice(0, -1))
  if (w.endsWith('es') && w.length > 4) cands.add(w.slice(0, -2))
  if (w.endsWith('ies') && w.length > 4) cands.add(`${w.slice(0, -3)}y`)
  if (w.endsWith('ied') && w.length > 4) cands.add(`${w.slice(0, -3)}y`)
  if (w.endsWith('ed') && w.length > 4) {
    cands.add(w.slice(0, -2))
    cands.add(`${w.slice(0, -2)}e`)
    if (w.length > 5 && w[w.length - 3] === w[w.length - 4]) cands.add(w.slice(0, -3))
  }
  if (w.endsWith('ing') && w.length > 5) {
    cands.add(w.slice(0, -3))
    cands.add(`${w.slice(0, -3)}e`)
    cands.add(`${w.slice(0, -3)}ie`)
    if (w.length > 6 && w[w.length - 4] === w[w.length - 5]) cands.add(w.slice(0, -4))
  }
  if (w.endsWith('ying') && w.length > 5) cands.add(`${w.slice(0, -4)}ie`)
  if (w.endsWith('ically') && w.length > 7) cands.add(w.slice(0, -4))
  if (w.endsWith('ally') && w.length > 6) cands.add(w.slice(0, -2))
  if (w.endsWith('ly') && w.length > 4) {
    cands.add(w.slice(0, -2))
    cands.add(`${w.slice(0, -2)}le`)
    cands.add(`${w.slice(0, -2)}e`)
  }
  if (w.endsWith('ised') && w.length > 5) cands.add(`${w.slice(0, -4)}ize`)
  if (w.endsWith('ising') && w.length > 6) cands.add(`${w.slice(0, -5)}ize`)

  for (const cand of cands) {
    if (cand && cand.length >= 2 && cand !== w && hasExactInShard(cand)) {
      return cand
    }
  }
  return ''
}

function classifyMissingToken(info, hasExactInShard) {
  const { rawForms, norm, sawLowercase, sawMidSentenceCap } = info

  // Pick the most frequent original surface spelling
  let topSurface = norm
  let topCount = -1
  for (const [surface, c] of rawForms.entries()) {
    if (c > topCount) {
      topCount = c
      topSurface = surface
    }
  }

  // 1. Contractions / Possessives
  if (/['’]/u.test(topSurface) || /['’]/u.test(norm)) {
    return { category: 'contractions', display: topSurface, note: '' }
  }

  // 2. Hyphenated / Compound Words
  if (/[-–—]/u.test(topSurface) || /[-–—]/u.test(norm)) {
    return { category: 'hyphenated', display: topSurface, note: '' }
  }

  // 3. Acronyms / All-Caps (e.g., GDP, IMF, AI, NATO, DNA)
  const isAllCaps =
    !sawLowercase &&
    [...rawForms.keys()].some(s => /^[A-Z]{2,}(?:[A-Z0-9]*)$/u.test(s) || /^[A-Z]{2,}s$/u.test(s))
  if (isAllCaps) {
    return { category: 'acronyms', display: topSurface, note: '' }
  }

  // 4. Proper Nouns / Capitalized Entities
  const looksCapitalizedEntity =
    !sawLowercase &&
    (sawMidSentenceCap || /^[A-Z][a-z]/u.test(topSurface))
  if (looksCapitalizedEntity) {
    return { category: 'properNouns', display: topSurface, note: '' }
  }

  // 5. Unmatched Inflections
  const base = findUnmatchedInflectionBase(norm, hasExactInShard)
  if (base) {
    return { category: 'unmatchedInflections', display: topSurface, note: `base "${base}" in dict` }
  }

  // 6. Regular Common / News Words
  return { category: 'regularWords', display: topSurface, note: '' }
}

async function main() {
  const args = process.argv.slice(2)
  const articlesDirArg = args.find(a => a.startsWith('--articles-dir='))?.split('=')[1]
  const dictDirArg = args.find(a => a.startsWith('--dict-dir='))?.split('=')[1]
  const articlesDir = articlesDirArg ? path.resolve(articlesDirArg) : DEFAULT_ARTICLES_DIR
  const dictDir = dictDirArg ? path.resolve(dictDirArg) : DEFAULT_DICT_DIR

  const loaded = loadArticleFiles(articlesDir)
  const { fetchImpl, hasExactInShard } = createLocalDictTools(dictDir)
  clearDictionaryCache()
  const [staticPhrases, lemmaMap] = await Promise.all([
    loadPhraseMap({ baseUrl: '/', fetchImpl }),
    loadLemmaMap({ baseUrl: '/', fetchImpl }),
  ])
  const hasStaticPhrases = staticPhrases && Object.keys(staticPhrases).length > 0

  const phraseMatchers = compilePhraseMatchers()

  let totalLevelVariants = 0
  let articlesWithGlossary = 0
  let articlesWithoutGlossary = 0
  let variantsWithGlossary = 0
  let variantsWithoutGlossary = 0
  let totalTokenOccurrences = 0
  let coveredTokenOccurrences = 0

  // Map<normalizedWord, { norm, count, found, rawForms: Map, sawLowercase, sawMidSentenceCap }>
  const tokenStats = new Map()
  // Cache Tier-2 lookup results per normalized word (when not covered by article glossary)
  const tier2FoundCache = new Map()

  // Multi-word phrase stats
  let totalPhraseMatches = 0
  let coveredPhraseMatches = 0
  // Map<lemma, { lemma, kind, count, articles: Set<string>, sampleSurface, sampleSentence }>
  const uncoveredPhrases = new Map()

  for (const { story } of loaded) {
    const storyId = String(story.id || story.title || 'unknown')
    const variants =
      story.levelVariants && typeof story.levelVariants === 'object'
        ? Object.entries(story.levelVariants).map(([level, v]) => ({
            level,
            pages: Array.isArray(v?.pages) ? v.pages : [],
            glossary: Array.isArray(v?.glossary) ? v.glossary : (Array.isArray(story.glossary) ? story.glossary : null),
          }))
        : [
            {
              level: 'default',
              pages: Array.isArray(story.pages) ? story.pages : [],
              glossary: Array.isArray(story.glossary) ? story.glossary : null,
            },
          ]

    const storyHasAnyGlossary = variants.some(v => Array.isArray(v.glossary) && v.glossary.length > 0)
    if (storyHasAnyGlossary) articlesWithGlossary++
    else articlesWithoutGlossary++

    for (const variant of variants) {
      totalLevelVariants++
      const hasGlossary = Array.isArray(variant.glossary) && variant.glossary.length > 0
      if (hasGlossary) variantsWithGlossary++
      else variantsWithoutGlossary++

      // Build fast lookup set of multi-word glossary surfaces/lemmas on this variant
      const glossaryMultiWords = new Set()
      if (hasGlossary) {
        for (const g of variant.glossary) {
          const s = normalizeLookupTerm(g?.surface)
          const l = normalizeLookupTerm(g?.lemma)
          if (s && s.includes(' ')) glossaryMultiWords.add(s)
          if (l && l.includes(' ')) glossaryMultiWords.add(l)
        }
      }

      for (const page of variant.pages) {
        const text = String(page?.text || '')
        if (!text) continue

        const sentences = splitSentences(text)

        // --- Part A: Audit single words & phrases using exact production tokenizer & lookup ---
        for (const sentence of sentences) {
          const tokens = tokenizeWithGlossary(
            sentence,
            variant.glossary,
            hasStaticPhrases ? staticPhrases : null,
            lemmaMap
          )
          let wordIndexInSentence = 0

          for (const tok of tokens) {
            if (tok.kind === 'text') continue
            const isSentenceStart = wordIndexInSentence === 0
            wordIndexInSentence++

            totalTokenOccurrences++

            if (tok.kind === 'glossary' || tok.kind === 'phrase') {
              coveredTokenOccurrences++
              const key = normalizeLookupTerm(tok.lookupKey || tok.text)
              if (key) {
                let rec = tokenStats.get(key)
                if (!rec) {
                  rec = { norm: key, count: 0, found: true, rawForms: new Map(), sawLowercase: false, sawMidSentenceCap: false }
                  tokenStats.set(key, rec)
                }
                rec.count++
                rec.found = true
                rec.rawForms.set(tok.text, (rec.rawForms.get(tok.text) || 0) + 1)
              }
              continue
            }

            const rawSurface = tok.text
            const normKey = normalizeLookupTerm(tok.lookupKey || rawSurface)
            if (!normKey || !/[a-z]/u.test(normKey)) {
              // Non-alphabetic token skipped cleanly (same guard as dictionaryService)
              totalTokenOccurrences--
              continue
            }

            let found
            if (tier2FoundCache.has(normKey)) {
              found = tier2FoundCache.get(normKey)
            } else {
              const res = await lookupDictionaryTerm(rawSurface, {
                sentence,
                glossary: variant.glossary,
                baseUrl: '/',
                fetchImpl,
              })
              found = Boolean(res.found)
              tier2FoundCache.set(normKey, found)
            }

            if (found) coveredTokenOccurrences++

            let rec = tokenStats.get(normKey)
            if (!rec) {
              rec = {
                norm: normKey,
                count: 0,
                found,
                rawForms: new Map(),
                sawLowercase: false,
                sawMidSentenceCap: false,
              }
              tokenStats.set(normKey, rec)
            }
            rec.count++
            if (found) rec.found = true
            rec.rawForms.set(rawSurface, (rec.rawForms.get(rawSurface) || 0) + 1)
            if (rawSurface === rawSurface.toLowerCase()) rec.sawLowercase = true
            if (!isSentenceStart && /^[A-Z]/u.test(rawSurface)) rec.sawMidSentenceCap = true
          }

          // --- Part B: Audit multi-word phrases in this sentence ---
          const occupied = new Uint8Array(sentence.length)
          for (const matcher of phraseMatchers) {
            matcher.regex.lastIndex = 0
            let match
            while ((match = matcher.regex.exec(sentence)) !== null) {
              const start = match.index
              const end = start + match[0].length
              let overlap = false
              for (let i = start; i < end; i++) {
                if (occupied[i]) {
                  overlap = true
                  break
                }
              }
              if (overlap) continue
              for (let i = start; i < end; i++) occupied[i] = 1

              totalPhraseMatches++
              const matchedSurfaceNorm = normalizeLookupTerm(match[0])
              const matchedByStaticPhrase = tokens.some(
                t =>
                  t.kind === 'phrase' &&
                  (t.lookupKey === matcher.lemma ||
                    normalizeLookupTerm(t.text) === matchedSurfaceNorm)
              )
              const isCovered =
                glossaryMultiWords.has(matcher.lemma) ||
                glossaryMultiWords.has(matchedSurfaceNorm) ||
                matchedByStaticPhrase

              if (isCovered) {
                coveredPhraseMatches++
              } else {
                let entry = uncoveredPhrases.get(matcher.lemma)
                if (!entry) {
                  entry = {
                    lemma: matcher.lemma,
                    kind: matcher.kind,
                    count: 0,
                    articles: new Set(),
                    sampleSurface: match[0],
                    sampleSentence: sentence,
                    sampleStart: start,
                    sampleEnd: end,
                  }
                  uncoveredPhrases.set(matcher.lemma, entry)
                }
                entry.count++
                entry.articles.add(storyId)
              }
            }
          }
        }
      }
    }
  }

  // Group missing unique single words into the 6 required categories
  const categories = {
    properNouns: { label: 'Proper Nouns / Capitalized Entities', items: [] },
    hyphenated: { label: 'Hyphenated / Compound Words', items: [] },
    acronyms: { label: 'Acronyms / All-Caps', items: [] },
    contractions: { label: 'Contractions / Possessives', items: [] },
    unmatchedInflections: { label: 'Unmatched Inflections (base in dict)', items: [] },
    regularWords: { label: 'Regular Common / News Words', items: [] },
  }

  let totalUniqueWords = 0
  let coveredUniqueWords = 0
  let missingUniqueWords = 0
  let missingOccurrences = 0

  for (const rec of tokenStats.values()) {
    totalUniqueWords++
    if (rec.found) {
      coveredUniqueWords++
      continue
    }
    missingUniqueWords++
    missingOccurrences += rec.count
    const { category, display, note } = classifyMissingToken(rec, hasExactInShard)
    categories[category].items.push({
      word: display,
      norm: rec.norm,
      count: rec.count,
      note,
    })
  }

  for (const cat of Object.values(categories)) {
    cat.items.sort((a, b) => b.count - a.count || a.word.localeCompare(b.word))
  }

  const uniqueCoveragePct = totalUniqueWords ? (coveredUniqueWords / totalUniqueWords) * 100 : 100
  const tokenCoveragePct = totalTokenOccurrences
    ? (coveredTokenOccurrences / totalTokenOccurrences) * 100
    : 100
  const phraseCoveragePct = totalPhraseMatches
    ? (coveredPhraseMatches / totalPhraseMatches) * 100
    : 100

  const dictManifestPath = path.join(dictDir, 'manifest.json')
  const dictManifest = fs.existsSync(dictManifestPath)
    ? JSON.parse(fs.readFileSync(dictManifestPath, 'utf8'))
    : null

  console.log('======================================================================')
  console.log('SAGA DICTIONARY & MULTI-WORD PHRASE COVERAGE AUDIT (READ-ONLY)')
  console.log('======================================================================')
  console.log(`Articles directory : ${path.relative(ROOT, articlesDir)}`)
  console.log(`Dictionary dir     : ${path.relative(ROOT, dictDir)}${dictManifest ? ` (${dictManifest.words?.toLocaleString()} headwords, ${dictManifest.lemmas?.toLocaleString()} lemmas)` : ''}`)
  console.log(`Articles scanned   : ${loaded.length.toLocaleString()} articles (${totalLevelVariants.toLocaleString()} CEFR level variants)`)
  console.log(`Total word tokens  : ${totalTokenOccurrences.toLocaleString()} occurrences (${coveredTokenOccurrences.toLocaleString()} covered = ${tokenCoveragePct.toFixed(2)}%)`)
  console.log(`Unique single words: ${totalUniqueWords.toLocaleString()} unique (${coveredUniqueWords.toLocaleString()} covered, ${missingUniqueWords.toLocaleString()} missing = ${uniqueCoveragePct.toFixed(2)}% unique coverage)`)
  console.log(`Missing occurrences: ${missingOccurrences.toLocaleString()} token taps (${(100 - tokenCoveragePct).toFixed(2)}% of all taps)`)
  console.log('')

  console.log('----------------------------------------------------------------------')
  console.log('MISSING SINGLE WORDS BY CATEGORY (Top 20 examples per category)')
  console.log('----------------------------------------------------------------------')
  for (const cat of Object.values(categories)) {
    const occ = cat.items.reduce((sum, x) => sum + x.count, 0)
    console.log(`\n[${cat.label}] — ${cat.items.length.toLocaleString()} unique words (${occ.toLocaleString()} occurrences)`)
    if (!cat.items.length) {
      console.log('  (none)')
      continue
    }
    const top20 = cat.items.slice(0, 20).map(item => {
      const suffix = item.note ? ` [${item.note}]` : ''
      return `${item.word} (${item.count})${suffix}`
    })
    console.log('  ' + top20.join(', '))
  }

  console.log('')
  console.log('----------------------------------------------------------------------')
  console.log('MULTI-WORD PHRASES & TIER-1 GLOSSARY COVERAGE')
  console.log('----------------------------------------------------------------------')
  console.log(`Articles with glossary   : ${articlesWithGlossary.toLocaleString()} / ${loaded.length.toLocaleString()} (${((articlesWithGlossary / Math.max(1, loaded.length)) * 100).toFixed(1)}%)`)
  console.log(`Articles missing glossary: ${articlesWithoutGlossary.toLocaleString()} / ${loaded.length.toLocaleString()}`)
  console.log(`CEFR variants w/ glossary: ${variantsWithGlossary.toLocaleString()} / ${totalLevelVariants.toLocaleString()}`)
  console.log(`Static phrases loaded    : ${Object.keys(staticPhrases || {}).length.toLocaleString()} entries (/dict/phrases.json)`)
  console.log(`Multi-word phrase hits   : ${totalPhraseMatches.toLocaleString()} total (${coveredPhraseMatches.toLocaleString()} covered = ${phraseCoveragePct.toFixed(2)}%)`)
  console.log(`Distinct uncovered phrases: ${uncoveredPhrases.size.toLocaleString()}`)

  const top25Phrases = [...uncoveredPhrases.values()]
    .sort((a, b) => b.count - a.count || b.articles.size - a.articles.size || a.lemma.localeCompare(b.lemma))
    .slice(0, 25)

  console.log('\nTop 25 Uncovered Multi-Word Phrases:')
  top25Phrases.forEach((p, idx) => {
    let ctx = p.sampleSentence
    if (ctx.length > 115) {
      const center = Math.floor((p.sampleStart + p.sampleEnd) / 2)
      let sliceStart = Math.max(0, center - 55)
      let sliceEnd = Math.min(ctx.length, sliceStart + 115)
      if (sliceEnd === ctx.length) sliceStart = Math.max(0, ctx.length - 115)
      const prefix = sliceStart > 0 ? '…' : ''
      const suffix = sliceEnd < ctx.length ? '…' : ''
      ctx = `${prefix}${ctx.slice(sliceStart, sliceEnd).trim()}${suffix}`
    }
    console.log(
      `  ${String(idx + 1).padStart(2, ' ')}. "${p.lemma}" [${p.kind}] — ${p.count} hits across ${p.articles.size} articles`
    )
    console.log(`      e.g. "${ctx}"`)
  })
  console.log('======================================================================')
}

main().catch(err => {
  console.error(err)
  process.exit(1)
})
