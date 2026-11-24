/**
 * Standalone Multi-Tier $0-Runtime Dictionary Service.
 *
 * Tier 1 (0ms, highest priority):
 *   Pre-annotated contextual glossary entry on the current article.
 *
 * Tier 1.5 (0ms once loaded, cached in memory):
 *   Static multi-word phrase dictionary `/dict/phrases.json` (phrasal verbs,
 *   multi-word expressions, idioms) with inflection-aware phrasal verb lookup.
 *
 * Tier 2 ($0 runtime, lazy-loaded static shards):
 *   1. Preserve original surface; strip punctuation & possessives ('s, ’s, trailing ').
 *   2. Lemmatize via cached `/dict/lemmas.json` + comprehensive suffix rules
 *      (including -bly -> -ble, -ically -> -ic, -ying -> -ie, British -ised/-ising).
 *   3. Lazy-load `/dict/<first-2-letters>.json` once with in-memory Map caching.
 *   4. Hyphenated compound fallback: exact compound -> closed form -> component parts.
 *   5. Context-aware POS re-ranking (Proper noun mid-sentence boost, Verb boost,
 *      Noun boost, Adjective/Adverb boost) while preserving ALL remaining senses
 *      in build-time commonality order.
 */

import { matchStaticPhraseWords } from '../utils/dictionaryTokenizer.js'

const shardCache = new Map()
let lemmasPromise = null
let lemmasCacheKey = null
let phrasesPromise = null
let phrasesCacheKey = null

const COMPOUND_SKIP_PARTS = new Set([
  'a', 'an', 'the', 'of', 'to', 'in', 'on', 'at', 'by', 'for', 'and', 'or', 'de', 'la', 'le', 'al', 'el',
])

const DETERMINERS = new Set([
  'a', 'an', 'the', 'this', 'that', 'these', 'those',
  'my', 'your', 'his', 'her', 'its', 'our', 'their',
  'many', 'several', 'few', 'some', 'any', 'each', 'every',
  'no', 'both', 'another', 'such', 'much', 'one', 'two', 'three',
])

const MODALS_AUX = new Set([
  'will', 'would', 'can', 'could', 'should', 'must', 'may', 'might', 'shall',
  'do', 'does', 'did', "don't", "doesn't", "didn't",
  "won't", "wouldn't", "can't", "couldn't", "shouldn't", "mustn't",
  'have', 'has', 'had', "haven't", "hasn't", "hadn't",
])

const SUBJECT_PRONOUNS = new Set(['i', 'you', 'we', 'they', 'he', 'she', 'it', 'who'])
const SINGULAR_SUBJECTS = new Set(['he', 'she', 'it'])

const FUNCTION_STOP_WORDS = new Set([
  ...DETERMINERS,
  ...MODALS_AUX,
  ...SUBJECT_PRONOUNS,
  'of', 'in', 'to', 'for', 'with', 'on', 'at', 'from', 'by', 'about', 'as',
  'into', 'like', 'through', 'after', 'over', 'between', 'out', 'against',
  'during', 'without', 'before', 'under', 'around', 'among', 'and', 'or',
  'but', 'nor', 'yet', 'so', 'if', 'than', 'because', 'although', 'though',
  'while', 'when', 'where', 'which', 'what', 'whose', 'whom', 'is', 'am',
  'are', 'was', 'were', 'be', 'been', 'being', 'not', 'very', 'quite', 'too',
  'also', 'just', 'only', 'more', 'most', 'less', 'least', 'still', 'even',
  'never', 'always', 'often', 'already', 'again', 'here', 'there', 'now', 'then',
  'him', 'them', 'us', 'me', 'myself', 'himself', 'herself', 'itself', 'themselves',
])

const NON_MODIFIER_BEFORE_NOUN = new Set([
  'is', 'am', 'are', 'was', 'were', 'be', 'been', 'being',
  'to', 'of', 'in', 'on', 'at', 'by', 'for', 'with', 'from', 'into', 'onto',
  'and', 'or', 'but', 'if', 'when', 'while', 'that', 'which', 'who', 'as',
  ...MODALS_AUX,
])

const NON_ADVERB_LY_WORDS = new Set([
  'family', 'early', 'daily', 'weekly', 'monthly', 'yearly', 'friendly',
  'likely', 'unlikely', 'lonely', 'lovely', 'lively', 'elderly', 'costly',
  'deadly', 'ugly', 'silly', 'holy', 'only', 'july', 'italy', 'lily', 'ally',
  'rally', 'belly', 'jelly', 'folly', 'bully', 'fly', 'ply', 'rely', 'reply',
  'apply', 'supply', 'imply', 'comply', 'multiply', 'assembly', 'monopoly',
])

const DEGREE_ADVERBS = new Set([
  'very', 'quite', 'fairly', 'rather', 'pretty', 'extremely', 'really',
  'truly', 'remarkably', 'especially', 'particularly', 'so', 'too', 'as', 'how',
])

const LEXICAL_STOP_WORDS = new Set([
  ...FUNCTION_STOP_WORDS,
  'something', 'someone', 'person', 'people', 'thing', 'things', 'used',
  'make', 'made', 'making', 'take', 'took', 'taken', 'give', 'gave', 'given',
  'state', 'form', 'part', 'type', 'kind', 'sort', 'way', 'time', 'good',
  'great', 'small', 'large', 'long', 'high', 'often', 'usually', 'especially',
])

export function normalizeLookupTerm(raw, { stripPossessive = true } = {}) {
  let text = String(raw || '')
    .trim()
    .toLowerCase()
    .replace(/[’‘]/gu, "'")
    .replace(/[–—]/gu, '-')
    .replace(/^[^a-z0-9]+|[^a-z0-9]+$/gu, '')
    .replace(/\s+/gu, ' ')
  if (stripPossessive) {
    text = text.replace(/'s$/u, '').replace(/'$/u, '')
  }
  return text
}

export function shardKeyFor(word) {
  const letters = String(word || '')
    .toLowerCase()
    .replace(/[^a-z]/gu, '')
  if (letters.length >= 2) return letters.slice(0, 2)
  if (letters.length === 1) return `${letters}_`
  return '__'
}

export function buildCambridgeUrl(term) {
  const slug = normalizeLookupTerm(term).replace(/\s+/gu, '-')
  return `https://dictionary.cambridge.org/dictionary/english/${encodeURIComponent(slug || 'english')}`
}

/**
 * Safe suffix-stripping fallback rules when an inflected form is not listed
 * in `/dict/lemmas.json`.
 */
export function suffixLemmaCandidates(word) {
  const w = normalizeLookupTerm(word)
  if (!w || w.includes(' ')) return []
  const out = []
  const add = cand => {
    if (cand && cand.length >= 2 && cand !== w && !out.includes(cand)) out.push(cand)
  }

  if (w.endsWith('ies') && w.length > 4) add(`${w.slice(0, -3)}y`)
  if (w.endsWith('ves') && w.length > 4) {
    add(`${w.slice(0, -3)}f`)
    add(`${w.slice(0, -3)}fe`)
  }
  if (w.endsWith('es') && w.length > 4) {
    add(w.slice(0, -2))
    add(w.slice(0, -1))
  }
  if (w.endsWith('s') && w.length > 3 && !w.endsWith('ss') && !w.endsWith('us') && !w.endsWith('is')) {
    add(w.slice(0, -1))
  }
  if (w.endsWith('ied') && w.length > 4) add(`${w.slice(0, -3)}y`)
  if (w.endsWith('ised') && w.length > 5) add(`${w.slice(0, -4)}ize`)
  if (w.endsWith('ed') && w.length > 4) {
    const stem = w.slice(0, -2)
    add(stem)
    add(w.slice(0, -1))
    if (stem.length >= 3 && stem[stem.length - 1] === stem[stem.length - 2]) {
      add(stem.slice(0, -1))
    }
  }
  if (w.endsWith('ying') && w.length > 5) add(`${w.slice(0, -4)}ie`)
  if (w.endsWith('ising') && w.length > 6) add(`${w.slice(0, -5)}ize`)
  if (w.endsWith('ing') && w.length > 5) {
    const stem = w.slice(0, -3)
    add(stem)
    add(`${stem}e`)
    if (stem.length >= 3 && stem[stem.length - 1] === stem[stem.length - 2]) {
      add(stem.slice(0, -1))
    }
  }
  if (w.endsWith('ically') && w.length > 7) {
    add(w.slice(0, -4))
    add(w.slice(0, -2))
  }
  if (w.endsWith('ily') && w.length > 5) add(`${w.slice(0, -3)}y`)
  if (w.endsWith('bly') && w.length > 4) add(`${w.slice(0, -1)}e`)
  if (w.endsWith('ally') && w.length > 6) add(w.slice(0, -2))
  if (w.endsWith('lly') && w.length > 4) add(w.slice(0, -1))
  if (w.endsWith('ly') && w.length > 4) {
    add(w.slice(0, -2))
    add(`${w.slice(0, -2)}e`)
    add(`${w.slice(0, -1)}e`)
  }
  if (w.endsWith('ier') && w.length > 5) add(`${w.slice(0, -3)}y`)
  if (w.endsWith('iest') && w.length > 6) add(`${w.slice(0, -4)}y`)
  if (w.endsWith('er') && w.length > 4) {
    const stem = w.slice(0, -2)
    add(stem)
    add(`${stem}e`)
    if (stem.length >= 3 && stem[stem.length - 1] === stem[stem.length - 2]) {
      add(stem.slice(0, -1))
    }
  }
  if (w.endsWith('est') && w.length > 5) {
    const stem = w.slice(0, -3)
    add(stem)
    add(`${stem}e`)
    if (stem.length >= 3 && stem[stem.length - 1] === stem[stem.length - 2]) {
      add(stem.slice(0, -1))
    }
  }

  return out
}

/**
 * Extract immediate grammatical context around a tapped word inside a sentence:
 * prevWord, prevPrevWord, nextWord, isSentenceStart, and exact matched surface.
 */
export function extractSentenceContext(
  sentence,
  rawSurface,
  { prevWord = '', nextWord = '', isSentenceStart = undefined } = {}
) {
  const src = String(sentence || '').trim()
  const surfaceClean = String(rawSurface || '').trim().replace(/^[^A-Za-z0-9]+|[^A-Za-z0-9]+$/gu, '')
  if (!src || !surfaceClean) {
    return {
      prevWord: normalizeLookupTerm(prevWord, { stripPossessive: false }),
      prevPrevWord: '',
      nextWord: normalizeLookupTerm(nextWord, { stripPossessive: false }),
      isSentenceStart: Boolean(isSentenceStart),
      matchedSurface: surfaceClean || String(rawSurface || '').trim(),
    }
  }

  const tokens = []
  const re = /[A-Za-z][A-Za-z'’-]*/gu
  let m
  while ((m = re.exec(src)) !== null) {
    tokens.push({ text: m[0], index: m.index, end: m.index + m[0].length })
  }

  const normTarget = normalizeLookupTerm(surfaceClean, { stripPossessive: false })
  const normStripped = normalizeLookupTerm(surfaceClean, { stripPossessive: true })

  // Prefer exact case-sensitive match first (critical for "Turkey" vs "turkey")
  let foundIdx = tokens.findIndex(t => t.text === surfaceClean)
  if (foundIdx === -1) {
    foundIdx = tokens.findIndex(
      t => normalizeLookupTerm(t.text, { stripPossessive: false }) === normTarget
    )
  }
  if (foundIdx === -1) {
    foundIdx = tokens.findIndex(
      t => normalizeLookupTerm(t.text, { stripPossessive: true }) === normStripped
    )
  }

  if (foundIdx === -1) {
    return {
      prevWord: normalizeLookupTerm(prevWord, { stripPossessive: false }),
      prevPrevWord: '',
      nextWord: normalizeLookupTerm(nextWord, { stripPossessive: false }),
      isSentenceStart: isSentenceStart !== undefined ? Boolean(isSentenceStart) : false,
      matchedSurface: surfaceClean,
    }
  }

  const tok = tokens[foundIdx]
  const beforeSlice = src.slice(0, tok.index)
  const inferredStart = foundIdx === 0 || /[.!?]\s*["'“‘(\[]*\s*$/u.test(beforeSlice)

  const prevTok = foundIdx > 0 ? tokens[foundIdx - 1] : null
  const prevPrevTok = foundIdx > 1 ? tokens[foundIdx - 2] : null
  const nextTok = foundIdx + 1 < tokens.length ? tokens[foundIdx + 1] : null

  // Do not cross punctuation boundaries like commas/semicolons/periods for prev/next word
  const gapBefore = prevTok ? src.slice(prevTok.end, tok.index) : ''
  const gapPrevPrev = prevPrevTok && prevTok ? src.slice(prevPrevTok.end, prevTok.index) : ''
  const gapAfter = nextTok ? src.slice(tok.end, nextTok.index) : ''

  const cleanPrev =
    prevTok && !/[,.;:!?()—–]/u.test(gapBefore)
      ? normalizeLookupTerm(prevTok.text, { stripPossessive: false })
      : ''
  const cleanPrevPrev =
    cleanPrev && prevPrevTok && !/[,.;:!?()—–]/u.test(gapPrevPrev)
      ? normalizeLookupTerm(prevPrevTok.text, { stripPossessive: false })
      : ''
  const cleanNext =
    nextTok && !/[,.;:!?()—–]/u.test(gapAfter)
      ? normalizeLookupTerm(nextTok.text, { stripPossessive: false })
      : ''

  return {
    prevWord: prevWord ? normalizeLookupTerm(prevWord, { stripPossessive: false }) : cleanPrev,
    prevPrevWord: cleanPrevPrev,
    nextWord: nextWord ? normalizeLookupTerm(nextWord, { stripPossessive: false }) : cleanNext,
    isSentenceStart: isSentenceStart !== undefined ? Boolean(isSentenceStart) : inferredStart,
    matchedSurface: tok.text,
  }
}

function normalizePosCategory(rawPos) {
  const p = String(rawPos || '').toLowerCase().trim()
  if (p === 'proper noun' || p === 'name') return 'proper noun'
  if (p === 'verb' || p === 'phrasal verb') return 'verb'
  if (p === 'noun') return 'noun'
  if (p === 'adj' || p === 'adjective') return 'adj'
  if (p === 'adv' || p === 'adverb') return 'adv'
  return p
}

function contentWordsOf(text, excludeWord = '') {
  const excluded = normalizeLookupTerm(excludeWord)
  const words = String(text || '')
    .toLowerCase()
    .match(/[a-z]{4,}/gu)
  if (!words) return []
  return [...new Set(words.filter(w => w !== excluded && !LEXICAL_STOP_WORDS.has(w)))]
}

/**
 * Zero-cost context-aware POS re-ranking.
 * Boosts the most probable POS for the current sentence to #1 while preserving
 * ALL remaining senses right below in build-time commonality order.
 */
export function rerankSensesByContext(
  options,
  {
    rawSurface = '',
    normalized = '',
    resolvedLemma = '',
    sentence = '',
    prevWord = '',
    prevPrevWord = '',
    nextWord = '',
    isSentenceStart = false,
    nextWordIsNoun = false,
    prevWordIsVerb = false,
  } = {}
) {
  if (!Array.isArray(options) || options.length <= 1) return options || []

  const availablePos = new Set(options.map(opt => normalizePosCategory(opt.partOfSpeech)))
  const posBoosts = new Map()
  const addBoost = (pos, val) => {
    posBoosts.set(pos, (posBoosts.get(pos) || 0) + val)
  }

  const surfaceStr = String(rawSurface || '').trim()
  const norm = normalized || normalizeLookupTerm(surfaceStr)
  const lemma = resolvedLemma || norm

  // 1. Proper Noun boost: capitalized mid-sentence with a proper noun/name sense
  const isMidSentenceCap =
    Boolean(surfaceStr) &&
    /^[A-Z]/u.test(surfaceStr) &&
    surfaceStr !== 'I' &&
    !isSentenceStart

  if (isMidSentenceCap && availablePos.has('proper noun')) {
    addBoost('proper noun', 120)
  } else {
    // 2. Determiner / Noun / Adjective rules
    const prevIsDet = DETERMINERS.has(prevWord)
    const prevPrevIsDet = DETERMINERS.has(prevPrevWord)

    if (prevIsDet && nextWordIsNoun && availablePos.has('adj')) {
      // Between a determiner and a known noun: "a right decision", "the present system"
      addBoost('adj', 85)
    } else if (prevIsDet && !nextWordIsNoun && availablePos.has('noun')) {
      // After determiner/possessive/quantifier without a following noun: "water from the well"
      addBoost('noun', 85)
    } else if (
      prevPrevIsDet &&
      prevWord &&
      !NON_MODIFIER_BEFORE_NOUN.has(prevWord) &&
      !nextWordIsNoun &&
      availablePos.has('noun')
    ) {
      // Head noun of a 3-word noun phrase: "a morning run", "the long run"
      addBoost('noun', 85)
    } else if (
      norm !== lemma &&
      /(?:s|es|ies)$/u.test(norm) &&
      !SINGULAR_SUBJECTS.has(prevWord) &&
      !MODALS_AUX.has(prevWord) &&
      prevWord !== 'to' &&
      availablePos.has('noun')
    ) {
      // Plural noun inflection
      addBoost('noun', 75)
    }

    // 3. Verb boost: preceded by 'to' / modals / auxiliaries, or -ed/-ing not after determiner
    if (
      availablePos.has('verb') &&
      (prevWord === 'to' || MODALS_AUX.has(prevWord))
    ) {
      addBoost('verb', 90)
    } else if (
      availablePos.has('verb') &&
      !prevIsDet &&
      !prevPrevIsDet &&
      /(?:ed|ing)$/u.test(norm) &&
      norm.length >= 4
    ) {
      addBoost('verb', 80)
    } else if (
      availablePos.has('verb') &&
      SUBJECT_PRONOUNS.has(prevWord) &&
      !prevIsDet &&
      !availablePos.has('adv')
    ) {
      addBoost('verb', 55)
    }

    // 4. Adverb / Adjective rules
    if (
      availablePos.has('adv') &&
      norm.endsWith('ly') &&
      norm.length >= 5 &&
      !NON_ADVERB_LY_WORDS.has(norm)
    ) {
      addBoost('adv', 85)
    } else if (
      availablePos.has('adv') &&
      !prevIsDet &&
      !prevPrevIsDet &&
      (prevWordIsVerb || DEGREE_ADVERBS.has(prevWord))
    ) {
      // Verb + adverb: "she speaks well", "very well"
      addBoost('adv', 85)
    } else if (
      availablePos.has('adj') &&
      !prevIsDet &&
      DEGREE_ADVERBS.has(prevWord)
    ) {
      addBoost('adj', 70)
    }
  }

  // Lightweight lexical overlap tie-break within same POS tier (0 to +14)
  const sentWords = contentWordsOf(sentence, lemma)
  const sentStems = sentWords.map(w => (w.length >= 5 ? w.slice(0, 5) : w))

  const scored = options.map((opt, idx) => {
    const posCat = normalizePosCategory(opt.partOfSpeech)
    const pBoost = posBoosts.get(posCat) || 0

    let lexBoost = 0
    if (sentWords.length) {
      const defWords = contentWordsOf(opt.en_def || opt.definition || '', lemma)
      if (defWords.length) {
        let hits = 0
        for (let i = 0; i < sentWords.length; i++) {
          const sw = sentWords[i]
          const stem = sentStems[i]
          if (defWords.some(dw => dw === sw || (stem.length >= 5 && dw.startsWith(stem)))) {
            hits++
          }
        }
        lexBoost = Math.min(14, hits * 7)
      }
    }

    // Preserve build-time commonality order strictly inside the same POS boost bucket
    // except when lexical overlap clearly identifies a specific sense in the winning POS.
    const total = pBoost + (pBoost > 0 || posBoosts.size === 0 ? lexBoost : 0)
    return { opt, idx, total }
  })

  scored.sort((a, b) => b.total - a.total || a.idx - b.idx)
  return scored.map(item => item.opt)
}

function defaultBaseUrl() {
  try {
    const base = import.meta?.env?.BASE_URL || '/'
    return base.endsWith('/') ? base : `${base}/`
  } catch {
    return '/'
  }
}

async function fetchJsonSafe(url, fetchImpl) {
  try {
    const res = await fetchImpl(url, { headers: { Accept: 'application/json' } })
    if (!res || !res.ok) return null
    return await res.json()
  } catch {
    return null
  }
}

export async function loadLemmaMap({ baseUrl = defaultBaseUrl(), fetchImpl = fetch } = {}) {
  const key = `${baseUrl}dict/lemmas.json`
  if (lemmasPromise && lemmasCacheKey === key) return lemmasPromise
  lemmasCacheKey = key
  lemmasPromise = fetchJsonSafe(key, fetchImpl).then(data =>
    data && typeof data === 'object' ? data : {}
  )
  return lemmasPromise
}

export async function loadPhraseMap({ baseUrl = defaultBaseUrl(), fetchImpl = fetch } = {}) {
  const key = `${baseUrl}dict/phrases.json`
  if (phrasesPromise && phrasesCacheKey === key) return phrasesPromise
  phrasesCacheKey = key
  phrasesPromise = fetchJsonSafe(key, fetchImpl).then(data =>
    data && typeof data === 'object' ? data : {}
  )
  return phrasesPromise
}

export async function loadDictionaryShard(shardKey, { baseUrl = defaultBaseUrl(), fetchImpl = fetch } = {}) {
  const url = `${baseUrl}dict/${shardKey}.json`
  if (shardCache.has(url)) return shardCache.get(url)
  const promise = fetchJsonSafe(url, fetchImpl).then(data =>
    data && typeof data === 'object' ? data : {}
  )
  shardCache.set(url, promise)
  return promise
}

export function clearDictionaryCache() {
  shardCache.clear()
  lemmasPromise = null
  lemmasCacheKey = null
  phrasesPromise = null
  phrasesCacheKey = null
}

/**
 * Synchronous Tier-1 lookup against an article's optional glossary array.
 * Returns normalized lookup payload in 0ms or null if absent.
 */
export function resolveTier1Glossary(term, glossary = null, directEntry = null) {
  let entry =
    directEntry && typeof directEntry === 'object' && !directEntry.isStaticPhrase
      ? directEntry
      : null
  if (!entry && Array.isArray(glossary) && glossary.length) {
    const norm = normalizeLookupTerm(term)
    if (norm) {
      entry =
        glossary.find(item => normalizeLookupTerm(item?.surface) === norm) ||
        glossary.find(item => normalizeLookupTerm(item?.lemma) === norm) ||
        null
    }
  }
  if (!entry) return null

  const surface = String(entry.surface || term || '').trim()
  const lemma = String(entry.lemma || surface).trim()
  const enDef = String(entry.en_def || '').trim()
  if (!enDef) return null
  const pos = String(entry.pos || '').trim()
  const ipa = String(entry.ipa || '').trim()
  const cefr = String(entry.cefr || '').trim()
  const type = String(entry.type || 'word').trim()

  return {
    tier: 1,
    found: true,
    surface,
    lemma,
    type,
    pos,
    ipa,
    cefr,
    vi_context: '',
    en_def: enDef,
    options: [
      {
        definition: enDef,
        en_def: enDef,
        vi_context: '',
        example: '',
        partOfSpeech: pos,
        phonetic: ipa,
        cefr,
        source: 'Article Glossary',
      },
    ],
    cambridgeUrl: buildCambridgeUrl(lemma || surface),
  }
}

function formatShardRecord(word, record, fromLemma = '') {
  const ipa = record?.ipa || ''
  const rawMeanings = Array.isArray(record?.m) ? record.m : []
  return rawMeanings
    .filter(item => item && item.d)
    .map(item => ({
      definition: item.d,
      en_def: item.d,
      vi_context: '',
      example: item.e || '',
      partOfSpeech: item.p || record?.p || '',
      phonetic: ipa,
      fromLemma: fromLemma || word,
      source: 'Static Dictionary',
    }))
}

/**
 * Synchronous Tier-1.5 lookup against /dict/phrases.json (or a pre-attached
 * static phrase token entry). Supports exact and inflected phrasal verbs.
 */
export function resolveStaticPhrase(
  term,
  phraseMap = null,
  lemmaMap = null,
  directEntry = null,
  sentence = ''
) {
  const rawSurface = String(directEntry?.surface || term || '').trim()
  let matchedKey = ''
  let record = null

  if (
    directEntry &&
    typeof directEntry === 'object' &&
    directEntry.isStaticPhrase &&
    Array.isArray(directEntry.m) &&
    directEntry.m.length
  ) {
    matchedKey = String(directEntry.lemma || rawSurface).toLowerCase().trim()
    record = directEntry
  } else if (phraseMap && typeof phraseMap === 'object') {
    const norm = normalizeLookupTerm(term, { stripPossessive: false })
    if (norm && norm.includes(' ')) {
      const words = norm.split(' ').filter(Boolean)
      const hit = matchStaticPhraseWords(words, phraseMap, lemmaMap)
      if (hit) {
        matchedKey = hit.key
        record = hit.record
      }
    }
  }

  if (!record || !matchedKey) return null

  const formatted = formatShardRecord(matchedKey, record, matchedKey)
  if (!formatted.length) return null
  const ranked = rerankSensesByContext(formatted, {
    rawSurface,
    normalized: matchedKey,
    resolvedLemma: matchedKey,
    sentence,
  })
  const primary = ranked[0]
  const pos = String(record.p || primary.partOfSpeech || 'phrase').trim()

  return {
    tier: 2,
    found: true,
    surface: rawSurface || matchedKey,
    lemma: matchedKey,
    type: pos === 'phrasal verb' ? 'phrasal_verb' : 'phrase',
    pos,
    ipa: record.ipa || primary.phonetic || '',
    cefr: '',
    vi_context: '',
    en_def: primary.definition || '',
    options: ranked,
    cambridgeUrl: buildCambridgeUrl(matchedKey),
  }
}

async function resolveWordFromShards(termKey, lemmaMap, { baseUrl, fetchImpl }) {
  if (!termKey || !/[a-z]/u.test(termKey)) return null

  const mappedLemma = typeof lemmaMap[termKey] === 'string' ? lemmaMap[termKey] : ''
  const exactShard = await loadDictionaryShard(shardKeyFor(termKey), { baseUrl, fetchImpl })
  const exactRec = exactShard[termKey] || null

  let lemmaRec = null
  let resolvedLemma = termKey

  if (mappedLemma && mappedLemma !== termKey) {
    const lemmaShard = await loadDictionaryShard(shardKeyFor(mappedLemma), { baseUrl, fetchImpl })
    lemmaRec = lemmaShard[mappedLemma] || null
  }

  const options = []
  let ipa = ''

  if (exactRec) {
    ipa = exactRec.ipa || ''
    options.push(...formatShardRecord(termKey, exactRec, termKey))
    if (lemmaRec) {
      if (!ipa) ipa = lemmaRec.ipa || ''
      options.push(...formatShardRecord(mappedLemma, lemmaRec, mappedLemma))
    }
  } else if (lemmaRec) {
    resolvedLemma = mappedLemma
    ipa = lemmaRec.ipa || ''
    options.push(...formatShardRecord(mappedLemma, lemmaRec, mappedLemma))
  } else {
    const suffixCandidates = suffixLemmaCandidates(termKey)
    for (const candidate of suffixCandidates) {
      const candShard = await loadDictionaryShard(shardKeyFor(candidate), { baseUrl, fetchImpl })
      if (candShard[candidate]) {
        resolvedLemma = candidate
        ipa = candShard[candidate].ipa || ''
        options.push(...formatShardRecord(candidate, candShard[candidate], candidate))
        break
      }
      const chained = lemmaMap[candidate]
      if (chained) {
        const chainedShard = await loadDictionaryShard(shardKeyFor(chained), { baseUrl, fetchImpl })
        if (chainedShard[chained]) {
          resolvedLemma = chained
          ipa = chainedShard[chained].ipa || ''
          options.push(...formatShardRecord(chained, chainedShard[chained], chained))
          break
        }
      }
    }
  }

  if (!options.length) return null
  return { resolvedLemma, ipa, options }
}

async function inspectNeighborPos(word, lemmaMap, { baseUrl, fetchImpl }) {
  if (!word || FUNCTION_STOP_WORDS.has(word) || !/[a-z]/u.test(word)) {
    return { isNoun: false, isVerb: false }
  }
  const hit = await resolveWordFromShards(word, lemmaMap, { baseUrl, fetchImpl })
  if (!hit || !hit.options.length) return { isNoun: false, isVerb: false }

  const topPos = normalizePosCategory(hit.options[0].partOfSpeech)
  const hasNoun = hit.options.some(o => normalizePosCategory(o.partOfSpeech) === 'noun')
  const hasVerb = hit.options.some(o => normalizePosCategory(o.partOfSpeech) === 'verb')

  return {
    isNoun: topPos === 'noun' || (hasNoun && topPos !== 'verb' && topPos !== 'adv' && topPos !== 'prep'),
    isVerb: topPos === 'verb' || (hasVerb && /(?:s|ed|ing)$/u.test(word)),
  }
}

/**
 * Full multi-tier dictionary lookup ($0 runtime).
 * 1. Tier 1: article glossary (0ms).
 * 2. Tier 1.5: static multi-word phrase dictionary (/dict/phrases.json).
 * 3. Tier 2: static sharded dictionary + possessives + lemmatization + hyphenated compounds
 *    + context-aware POS re-ranking (preserving all senses in commonality order).
 * 4. Offline fallback / clean missing state with Cambridge Dictionary link.
 */
export async function lookupDictionaryTerm(
  term,
  {
    sentence = '',
    prevWord = '',
    nextWord = '',
    isSentenceStart = undefined,
    glossary = null,
    glossaryEntry = null,
    phraseMap = null,
    offlineFallback = null,
    baseUrl = defaultBaseUrl(),
    fetchImpl = fetch,
  } = {}
) {
  const rawSurface = String(term || '').trim()

  // Tier 1: instant 0ms contextual glossary match
  const tier1 = resolveTier1Glossary(rawSurface, glossary, glossaryEntry)
  if (tier1) return tier1

  // Tier 1.5 fast path: direct static phrase entry attached by tokenizer
  if (glossaryEntry?.isStaticPhrase) {
    const directPhrase = resolveStaticPhrase(rawSurface, phraseMap, null, glossaryEntry, sentence)
    if (directPhrase) return directPhrase
  }

  const normalizedKeepApostrophe = normalizeLookupTerm(rawSurface, { stripPossessive: false })
  const normalized = normalizeLookupTerm(rawSurface, { stripPossessive: true })

  if (!normalized || !/[a-z]/u.test(normalized)) {
    return {
      tier: 0,
      found: false,
      surface: rawSurface,
      lemma: '',
      type: 'word',
      pos: '',
      ipa: '',
      cefr: '',
      vi_context: '',
      en_def: '',
      options: [],
      cambridgeUrl: buildCambridgeUrl(rawSurface),
    }
  }

  const lemmaMap = await loadLemmaMap({ baseUrl, fetchImpl })

  // Tier 1.5: multi-word phrase lookup
  if (normalizedKeepApostrophe.includes(' ')) {
    const activePhrases = phraseMap || (await loadPhraseMap({ baseUrl, fetchImpl }))
    const phraseResult = resolveStaticPhrase(
      rawSurface,
      activePhrases,
      lemmaMap,
      null,
      sentence
    )
    if (phraseResult) return phraseResult
  }

  // Tier 2: single-word shard lookup
  let resolved = null
  if (normalizedKeepApostrophe !== normalized && normalizedKeepApostrophe.includes("'")) {
    resolved = await resolveWordFromShards(normalizedKeepApostrophe, lemmaMap, { baseUrl, fetchImpl })
  }
  if (!resolved) {
    resolved = await resolveWordFromShards(normalized, lemmaMap, { baseUrl, fetchImpl })
  }

  // Hyphenated compound fallback
  if (!resolved && normalized.includes('-')) {
    const closed = normalized.replace(/-/gu, '')
    if (closed.length >= 3) {
      resolved = await resolveWordFromShards(closed, lemmaMap, { baseUrl, fetchImpl })
    }
    if (!resolved) {
      const parts = normalized
        .split('-')
        .map(p => p.trim())
        .filter(p => p.length >= 2 && /[a-z]/u.test(p) && !COMPOUND_SKIP_PARTS.has(p))
      const uniqueParts = [...new Set(parts)]
      const componentOptions = []
      let matchedMeaningfulPart = false

      for (const part of uniqueParts) {
        const partHit = await resolveWordFromShards(part, lemmaMap, { baseUrl, fetchImpl })
        if (!partHit || !partHit.options.length) continue
        if (part.length >= 3) matchedMeaningfulPart = true
        const best = partHit.options[0]
        if (best?.definition) {
          componentOptions.push({
            definition: `${partHit.resolvedLemma}: ${best.definition}`,
            en_def: `${partHit.resolvedLemma}: ${best.definition}`,
            vi_context: '',
            example: '',
            partOfSpeech: best.partOfSpeech || '',
            phonetic: '',
            fromLemma: normalized,
            source: 'Compound Parts',
          })
        }
      }

      if (matchedMeaningfulPart && componentOptions.length) {
        return {
          tier: 2,
          found: true,
          surface: rawSurface || normalized,
          lemma: normalized,
          type: 'word',
          pos: 'compound',
          ipa: '',
          cefr: '',
          vi_context: '',
          en_def: componentOptions[0].definition,
          options: componentOptions,
          cambridgeUrl: buildCambridgeUrl(normalized),
        }
      }
    }
  }

  if (resolved && resolved.options.length) {
    const ctx = extractSentenceContext(sentence, rawSurface, {
      prevWord,
      nextWord,
      isSentenceStart,
    })

    // Only check neighbor POS in cached shards when the word actually has multiple POS
    const posSet = new Set(resolved.options.map(o => normalizePosCategory(o.partOfSpeech)))
    let nextWordIsNoun = false
    let prevWordIsVerb = false

    if (posSet.size > 1) {
      if (ctx.nextWord && (DETERMINERS.has(ctx.prevWord) || DETERMINERS.has(ctx.prevPrevWord))) {
        const nextInfo = await inspectNeighborPos(ctx.nextWord, lemmaMap, { baseUrl, fetchImpl })
        nextWordIsNoun = nextInfo.isNoun
      }
      if (ctx.prevWord && posSet.has('adv') && !DETERMINERS.has(ctx.prevWord)) {
        const prevInfo = await inspectNeighborPos(ctx.prevWord, lemmaMap, { baseUrl, fetchImpl })
        prevWordIsVerb = prevInfo.isVerb
      }
    }

    const ranked = rerankSensesByContext(resolved.options, {
      rawSurface: ctx.matchedSurface || rawSurface,
      normalized,
      resolvedLemma: resolved.resolvedLemma,
      sentence,
      prevWord: ctx.prevWord,
      prevPrevWord: ctx.prevPrevWord,
      nextWord: ctx.nextWord,
      isSentenceStart: ctx.isSentenceStart,
      nextWordIsNoun,
      prevWordIsVerb,
    })

    const primary = ranked[0]
    return {
      tier: 2,
      found: true,
      surface: rawSurface || normalized,
      lemma: primary.fromLemma || resolved.resolvedLemma,
      type: 'word',
      pos: primary.partOfSpeech || '',
      ipa: primary.phonetic || resolved.ipa,
      cefr: '',
      vi_context: '',
      en_def: primary.definition || '',
      options: ranked,
      cambridgeUrl: buildCambridgeUrl(primary.fromLemma || resolved.resolvedLemma),
    }
  }

  // Optional built-in offline dictionary fallback for core words if shards unavailable
  const mappedLemma = typeof lemmaMap[normalized] === 'string' ? lemmaMap[normalized] : ''
  const fallbackText = typeof offlineFallback === 'function' ? offlineFallback(normalized) : ''
  if (fallbackText) {
    return {
      tier: 2,
      found: true,
      surface: rawSurface || normalized,
      lemma: mappedLemma || normalized,
      type: 'word',
      pos: '',
      ipa: '',
      cefr: '',
      vi_context: '',
      en_def: fallbackText,
      options: [
        {
          definition: fallbackText,
          en_def: fallbackText,
          vi_context: '',
          example: '',
          partOfSpeech: '',
          phonetic: '',
          source: 'Offline Dictionary',
        },
      ],
      cambridgeUrl: buildCambridgeUrl(mappedLemma || normalized),
    }
  }

  return {
    tier: 0,
    found: false,
    surface: rawSurface || normalized,
    lemma: mappedLemma || normalized,
    type: 'word',
    pos: '',
    ipa: '',
    cefr: '',
    vi_context: '',
    en_def: '',
    options: [],
    cambridgeUrl: buildCambridgeUrl(mappedLemma || normalized),
  }
}
