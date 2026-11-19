/**
 * Standalone 2-Tier $0-Runtime Dictionary Service.
 *
 * Tier 1 (0ms, highest priority):
 *   Pre-annotated contextual glossary entry on the current article.
 *
 * Tier 2 ($0 runtime, lazy-loaded static shards):
 *   1. Normalize tapped word (strip punctuation, possessives, lowercase).
 *   2. Lemmatize via cached `/dict/lemmas.json` + safe suffix-stripping rules.
 *   3. Lazy-load `/dict/<first-2-letters>.json` once with in-memory Map caching.
 *   4. Context-rank senses against the current sentence via existing rankMeaningOptions.
 *   5. Graceful fallback with Cambridge Learner's Dictionary URL when missing.
 */

import { rankMeaningOptions } from '../lib/contextualDictionary.js'

const shardCache = new Map()
let lemmasPromise = null
let lemmasCacheKey = null

export function normalizeLookupTerm(raw) {
  return String(raw || '')
    .trim()
    .toLowerCase()
    .replace(/[’']/gu, "'")
    .replace(/^[^a-z0-9]+|[^a-z0-9]+$/gu, '')
    .replace(/'s$/u, '')
    .replace(/\s+/gu, ' ')
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
  if (w.endsWith('ed') && w.length > 4) {
    const stem = w.slice(0, -2)
    add(stem)
    add(w.slice(0, -1))
    if (stem.length >= 3 && stem[stem.length - 1] === stem[stem.length - 2]) {
      add(stem.slice(0, -1))
    }
  }
  if (w.endsWith('ing') && w.length > 5) {
    const stem = w.slice(0, -3)
    add(stem)
    add(`${stem}e`)
    if (stem.length >= 3 && stem[stem.length - 1] === stem[stem.length - 2]) {
      add(stem.slice(0, -1))
    }
  }
  if (w.endsWith('ily') && w.length > 5) add(`${w.slice(0, -3)}y`)
  if (w.endsWith('ly') && w.length > 4) {
    add(w.slice(0, -2))
    add(`${w.slice(0, -2)}e`)
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
}

/**
 * Synchronous Tier-1 lookup against an article's optional glossary array.
 * Returns normalized lookup payload in 0ms or null if absent.
 */
export function resolveTier1Glossary(term, glossary = null, directEntry = null) {
  let entry = directEntry && typeof directEntry === 'object' ? directEntry : null
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
  const viContext = String(entry.vi_context || '').trim()
  const enDef = String(entry.en_def || '').trim()
  const pos = String(entry.pos || '').trim()
  const ipa = String(entry.ipa || '').trim()
  const cefr = String(entry.cefr || '').trim()
  const type = String(entry.type || 'word').trim()
  const primaryDefinition = viContext && enDef ? `${viContext} — ${enDef}` : (viContext || enDef)

  return {
    tier: 1,
    found: true,
    surface,
    lemma,
    type,
    pos,
    ipa,
    cefr,
    vi_context: viContext,
    en_def: enDef,
    options: [
      {
        definition: primaryDefinition,
        en_def: enDef,
        vi_context: viContext,
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
      partOfSpeech: item.p || '',
      phonetic: ipa,
      fromLemma: fromLemma || word,
      source: 'Simple Wiktionary',
    }))
}

/**
 * Full 2-tier dictionary lookup ($0 runtime).
 * 1. Tier 1: article glossary (0ms).
 * 2. Tier 2: static sharded dictionary + lemmatization + context ranking.
 * 3. Offline fallback / clean missing state with Cambridge Dictionary link.
 */
export async function lookupDictionaryTerm(
  term,
  {
    sentence = '',
    glossary = null,
    glossaryEntry = null,
    offlineFallback = null,
    baseUrl = defaultBaseUrl(),
    fetchImpl = fetch,
  } = {}
) {
  // Tier 1: instant 0ms contextual glossary match
  const tier1 = resolveTier1Glossary(term, glossary, glossaryEntry)
  if (tier1) return tier1

  const normalized = normalizeLookupTerm(term)
  if (!normalized || !/[a-z]/u.test(normalized)) {
    return {
      tier: 0,
      found: false,
      surface: String(term || ''),
      lemma: '',
      type: 'word',
      pos: '',
      ipa: '',
      cefr: '',
      vi_context: '',
      en_def: '',
      options: [],
      cambridgeUrl: buildCambridgeUrl(term),
    }
  }

  // Tier 2: static sharded dictionary + lemmatization
  const lemmaMap = await loadLemmaMap({ baseUrl, fetchImpl })
  const mappedLemma = typeof lemmaMap[normalized] === 'string' ? lemmaMap[normalized] : ''

  // Check exact word shard first, plus mapped lemma shard if different.
  const exactShard = await loadDictionaryShard(shardKeyFor(normalized), { baseUrl, fetchImpl })
  const exactRec = exactShard[normalized] || null

  let lemmaRec = null
  let resolvedLemma = normalized

  if (mappedLemma && mappedLemma !== normalized) {
    const lemmaShard = await loadDictionaryShard(shardKeyFor(mappedLemma), { baseUrl, fetchImpl })
    lemmaRec = lemmaShard[mappedLemma] || null
  }

  let options = []
  let ipa = ''

  if (exactRec) {
    ipa = exactRec.ipa || ''
    options.push(...formatShardRecord(normalized, exactRec, normalized))
    if (lemmaRec) {
      if (!ipa) ipa = lemmaRec.ipa || ''
      options.push(...formatShardRecord(mappedLemma, lemmaRec, mappedLemma))
    }
  } else if (lemmaRec) {
    resolvedLemma = mappedLemma
    ipa = lemmaRec.ipa || ''
    options.push(...formatShardRecord(mappedLemma, lemmaRec, mappedLemma))
  } else {
    // Safe suffix-stripping fallback rules
    const suffixCandidates = suffixLemmaCandidates(normalized)
    for (const candidate of suffixCandidates) {
      const candShard = await loadDictionaryShard(shardKeyFor(candidate), { baseUrl, fetchImpl })
      if (candShard[candidate]) {
        resolvedLemma = candidate
        ipa = candShard[candidate].ipa || ''
        options.push(...formatShardRecord(candidate, candShard[candidate], candidate))
        break
      }
      // Also check if suffix-stripped candidate maps through lemmas.json
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

  if (options.length) {
    const ranked = rankMeaningOptions(options, sentence, resolvedLemma)
    const primary = ranked[0]
    return {
      tier: 2,
      found: true,
      surface: normalized,
      lemma: primary.fromLemma || resolvedLemma,
      type: 'word',
      pos: primary.partOfSpeech || '',
      ipa: primary.phonetic || ipa,
      cefr: '',
      vi_context: '',
      en_def: primary.definition || '',
      options: ranked,
      cambridgeUrl: buildCambridgeUrl(primary.fromLemma || resolvedLemma),
    }
  }

  // Optional built-in offline dictionary fallback for core words if shards unavailable
  const fallbackText = typeof offlineFallback === 'function' ? offlineFallback(normalized) : ''
  if (fallbackText) {
    return {
      tier: 2,
      found: true,
      surface: normalized,
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
    surface: normalized,
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
