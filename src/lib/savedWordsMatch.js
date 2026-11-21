import { cleanWord } from '../utils/dictionaryTokenizer.js'

const hasOwn = (obj, key) => Boolean(obj && Object.prototype.hasOwnProperty.call(obj, key))

/**
 * Normalize a saved word/phrase or token string for case-insensitive matching.
 */
export function normalizeSavedKey(value) {
  return String(value || '')
    .replace(/\s+/gu, ' ')
    .trim()
    .toLowerCase()
    .replace(/[’']/gu, "'")
}

/**
 * Build a fast lowercase lookup Set from dailyLoreWords entries,
 * including both surface/normalized keys and single-word lemmas.
 */
export function buildSavedTokenSet(words, lemmaMap = null) {
  const set = new Set()
  if (!Array.isArray(words) || !words.length) return set

  for (const item of words) {
    const raw = typeof item === 'string' ? item : item?.word
    const normalized = normalizeSavedKey(raw)
    if (!normalized) continue
    set.add(normalized)

    if (!normalized.includes(' ')) {
      const cleaned = cleanWord(normalized)
      if (cleaned) {
        set.add(cleaned)
        if (lemmaMap && hasOwn(lemmaMap, cleaned) && typeof lemmaMap[cleaned] === 'string') {
          const lem = normalizeSavedKey(lemmaMap[cleaned])
          if (lem) set.add(lem)
        }
      }
    }
  }

  return set
}

/**
 * Return true iff a tokenized word/phrase matches an entry in dailyLoreWords
 * (case-insensitive surface, lookupKey, glossary/phrase lemma, or lemmaMap match).
 */
export function isTokenSaved(token, savedSet, lemmaMap = null) {
  if (!token || token.kind === 'text' || !savedSet || savedSet.size === 0) return false

  const lookupKey = normalizeSavedKey(token.lookupKey)
  if (lookupKey && savedSet.has(lookupKey)) return true

  const surface = normalizeSavedKey(token.text)
  if (surface && savedSet.has(surface)) return true

  const entryLemma = normalizeSavedKey(token.entry?.lemma)
  if (entryLemma && savedSet.has(entryLemma)) return true

  const entrySurface = normalizeSavedKey(token.entry?.surface)
  if (entrySurface && savedSet.has(entrySurface)) return true

  if (surface && !surface.includes(' ')) {
    const cleaned = cleanWord(surface)
    if (cleaned) {
      if (savedSet.has(cleaned)) return true
      if (lemmaMap && hasOwn(lemmaMap, cleaned) && typeof lemmaMap[cleaned] === 'string') {
        const lem = normalizeSavedKey(lemmaMap[cleaned])
        if (lem && savedSet.has(lem)) return true
      }
    }
  }

  return false
}
