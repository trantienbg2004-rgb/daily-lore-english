// Pure helpers for SAGA Words & Review (Context Flashcards, no SRS).

function escapeRegExp(value) {
  return String(value || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

export function normalizeSavedWord(item, fallbackDefinition = '') {
  if (!item || typeof item !== 'object') return null
  const word = String(item.word || '').trim()
  if (!word) return null
  const rawDef = String(item.definition || '').trim()
  const rawSentence = String(item.sentence || '').trim()
  const isLegacyPlaceholder = /^(Definition not available|Look up this word|Definition unavailable)/i.test(rawDef)
  const isSentenceCopy = Boolean(rawDef && rawSentence && rawDef === rawSentence)
  const definition = rawDef && !isLegacyPlaceholder && !isSentenceCopy ? rawDef : String(fallbackDefinition || '').trim()

  return {
    ...item,
    word,
    definition,
    phonetic: String(item.phonetic || '').trim(),
    partOfSpeech: String(item.partOfSpeech || '').trim(),
    example: String(item.example || '').trim(),
    sentence: rawSentence,
    storyTitle: String(item.storyTitle || '').trim(),
    mastered: Boolean(item.mastered),
    added: Number.isFinite(Number(item.added)) ? Number(item.added) : Date.now(),
  }
}

export function countWordStates(words) {
  let learning = 0
  let mastered = 0
  for (const item of Array.isArray(words) ? words : []) {
    if (item?.mastered) mastered += 1
    else learning += 1
  }
  return { total: learning + mastered, learning, mastered }
}

export function filterSavedWords(words, { filter = 'all', query = '' } = {}) {
  const list = Array.isArray(words) ? words : []
  const normalizedQuery = String(query || '').trim().toLowerCase()
  return list.filter(item => {
    if (filter === 'learning' && item.mastered) return false
    if (filter === 'mastered' && !item.mastered) return false
    if (!normalizedQuery) return true
    const haystack = [item.word, item.definition, item.sentence, item.storyTitle]
      .filter(Boolean)
      .join(' ')
      .toLowerCase()
    return haystack.includes(normalizedQuery)
  })
}

// Avoid lookbehind regex so iOS 15 Safari parses cleanly.
export function splitHighlightedContext(sentence, targetWord) {
  const text = String(sentence || '')
  const clean = String(targetWord || '').trim()
  if (!text) return []
  if (!clean) return [{ text, match: false }]

  const isAlpha = ch => /[A-Za-z]/.test(ch || '')
  const candidates = []
  if (/\s/.test(clean)) {
    candidates.push(clean.split(/\s+/).map(escapeRegExp).join('\\s+'))
  } else {
    const escaped = escapeRegExp(clean)
    if (clean.length >= 4 && clean.endsWith('e')) {
      candidates.push(`${escapeRegExp(clean.slice(0, -1))}(?:ed|es|er|est|ing)`)
    } else if (clean.length >= 4 && clean.endsWith('y')) {
      candidates.push(`${escapeRegExp(clean.slice(0, -1))}(?:ies|ied|ier|iest)`)
    } else if (clean.length >= 3) {
      candidates.push(`${escaped}(?:s|es|ed|d|ing|er|est)`)
    }
    candidates.push(escaped)
  }

  const regex = new RegExp(candidates.join('|'), 'gi')
  const segments = []
  let lastIndex = 0
  let match

  while ((match = regex.exec(text)) !== null) {
    const start = match.index
    const end = start + match[0].length
    const prevChar = start > 0 ? text[start - 1] : ''
    const nextChar = end < text.length ? text[end] : ''
    if (isAlpha(prevChar) || isAlpha(nextChar)) continue
    if (start > lastIndex) {
      segments.push({ text: text.slice(lastIndex, start), match: false })
    }
    segments.push({ text: match[0], match: true })
    lastIndex = end
  }

  if (lastIndex < text.length) {
    segments.push({ text: text.slice(lastIndex), match: false })
  }
  return segments.length ? segments : [{ text, match: false }]
}

export function buildReviewDeckKeys(words, mode = 'learning') {
  const list = Array.isArray(words) ? words : []
  if (mode === 'mastered') {
    return list.filter(item => Boolean(item?.mastered)).map(item => item.word)
  }
  return list.filter(item => !item?.mastered).map(item => item.word)
}

export function shuffleDeckKeys(keys, rng = Math.random) {
  const arr = Array.isArray(keys) ? [...keys] : []
  if (arr.length <= 1) return arr
  for (let i = arr.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rng() * (i + 1))
    ;[arr[i], arr[j]] = [arr[j], arr[i]]
  }
  // Guarantee a visible order change when shuffling >= 2 distinct keys.
  const sameOrder = arr.every((val, idx) => val === keys[idx])
  if (sameOrder) {
    arr.push(arr.shift())
  }
  return arr
}
