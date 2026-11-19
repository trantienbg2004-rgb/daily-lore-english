/**
 * Pure greedy longest-match tokenizer for Tier-1 contextual glossaries.
 *
 * Matches article.glossary surface phrases (case-insensitive, word-boundary safe,
 * longest match first) BEFORE splitting remaining text into clickable single words.
 * Seamlessly handles articles without a glossary field (100% backward compatible).
 */

const WORD_CHAR_RE = /[A-Za-z0-9]/
const LETTER_RE = /[A-Za-z]/

const normalizeSurface = value => String(value || '').replace(/\s+/gu, ' ').trim()

const cleanWord = value =>
  String(value || '')
    .toLowerCase()
    .replace(/^[^a-z]+|[^a-z]+$/gu, '')

const escapeRegex = value => value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')

function isWordBoundary(text, start, end) {
  const prev = start > 0 ? text[start - 1] : ''
  const next = end < text.length ? text[end] : ''
  const leftOk = !prev || !WORD_CHAR_RE.test(prev)
  const rightOk = !next || !WORD_CHAR_RE.test(next)
  return leftOk && rightOk
}

function splitPlainSegment(segment) {
  if (!segment) return []
  const parts = segment.split(/(\s+)/u)
  const tokens = []
  for (const part of parts) {
    if (!part) continue
    if (/^\s+$/u.test(part)) {
      tokens.push({ kind: 'text', text: part, lookupKey: '', entry: null })
      continue
    }
    const match = part.match(/^([^A-Za-z]*)([A-Za-z](?:.*[A-Za-z])?)([^A-Za-z]*)$/u)
    if (!match) {
      tokens.push({ kind: 'text', text: part, lookupKey: '', entry: null })
      continue
    }
    const [, lead, core, trail] = match
    const word = cleanWord(core)
    if (!word || !LETTER_RE.test(word)) {
      tokens.push({ kind: 'text', text: part, lookupKey: '', entry: null })
      continue
    }
    if (lead) tokens.push({ kind: 'text', text: lead, lookupKey: '', entry: null })
    tokens.push({ kind: 'word', text: core, lookupKey: word, entry: null })
    if (trail) tokens.push({ kind: 'text', text: trail, lookupKey: '', entry: null })
  }
  return tokens
}

/**
 * Prepare deduplicated glossary entries sorted by surface length descending
 * so greedy longest-match always prefers multi-word phrases/idioms over sub-words.
 */
export function prepareGlossaryEntries(glossary) {
  if (!Array.isArray(glossary) || !glossary.length) return []
  const bySurface = new Map()
  for (const item of glossary) {
    if (!item || typeof item !== 'object') continue
    const surface = normalizeSurface(item.surface)
    if (!surface || !LETTER_RE.test(surface)) continue
    const key = surface.toLowerCase()
    if (!bySurface.has(key)) {
      bySurface.set(key, { ...item, surface })
    }
  }
  return [...bySurface.values()].sort(
    (a, b) => b.surface.length - a.surface.length || a.surface.localeCompare(b.surface)
  )
}

/**
 * Tokenize a paragraph into an ordered array of tokens:
 * - { kind: 'glossary', text, lookupKey, entry }  -> Tier-1 matched phrase/word (0ms)
 * - { kind: 'word',     text, lookupKey, entry: null } -> single clickable word (Tier 2)
 * - { kind: 'text',     text, lookupKey: '', entry: null } -> whitespace / punctuation
 */
export function tokenizeWithGlossary(text, glossary = null) {
  const source = String(text || '')
  if (!source) return []

  const entries = prepareGlossaryEntries(glossary)
  if (!entries.length) return splitPlainSegment(source)

  // Compile each unique surface pattern with flexible internal whitespace.
  const compiled = entries.map(entry => {
    const pattern = escapeRegex(entry.surface).replace(/\s+/gu, '\\s+')
    return {
      entry,
      regex: new RegExp(pattern, 'giu'),
    }
  })

  // Collect non-overlapping greedy longest-match spans.
  // Because `compiled` is sorted longest-first, earlier entries win ties and
  // longer phrases block shorter sub-phrases inside the same span.
  const spans = []
  const occupied = new Uint8Array(source.length)

  for (const { entry, regex } of compiled) {
    regex.lastIndex = 0
    let match
    while ((match = regex.exec(source)) !== null) {
      const start = match.index
      const end = start + match[0].length
      if (!isWordBoundary(source, start, end)) continue
      let overlaps = false
      for (let i = start; i < end; i++) {
        if (occupied[i]) {
          overlaps = true
          break
        }
      }
      if (overlaps) continue
      for (let i = start; i < end; i++) occupied[i] = 1
      spans.push({ start, end, text: match[0], entry })
    }
  }

  if (!spans.length) return splitPlainSegment(source)

  spans.sort((a, b) => a.start - b.start)
  const tokens = []
  let cursor = 0

  for (const span of spans) {
    if (span.start > cursor) {
      tokens.push(...splitPlainSegment(source.slice(cursor, span.start)))
    }
    const lookupKey = normalizeSurface(span.entry.lemma || span.entry.surface).toLowerCase()
    tokens.push({
      kind: 'glossary',
      text: span.text,
      lookupKey,
      entry: span.entry,
    })
    cursor = span.end
  }

  if (cursor < source.length) {
    tokens.push(...splitPlainSegment(source.slice(cursor)))
  }

  return tokens
}

export { cleanWord }
