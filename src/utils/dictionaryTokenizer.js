/**
 * Pure greedy longest-match tokenizer for Tier-1 contextual glossaries
 * and Tier-1.5 static multi-word phrases (phrasal verbs, expressions, idioms).
 *
 * Priority order:
 *   1. article.glossary (Tier 1, highest priority, longest match first)
 *   2. staticPhrases from /dict/phrases.json (Tier 1.5, greedy 4 -> 3 -> 2 words,
 *      with inflection-aware phrasal verb matching: "relied on" -> "rely on",
 *      "grew out of" -> "grow out of", "broke down" -> "break down", etc.)
 *   3. Single clickable words (Tier 2 sharded dictionary)
 *
 * Seamlessly handles articles without a glossary or before phrases.json loads
 * (100% backward compatible, character-for-character text reconstruction).
 */

const WORD_CHAR_RE = /[A-Za-z0-9]/
const LETTER_RE = /[A-Za-z]/
const HORIZONTAL_SPACE_RE = /^[ \t]+$/u
const MAX_PHRASE_WORDS = 4

// Built-in irregular verb stem fallback so inflected phrasal verbs match
// even before or without a full lemmas.json map.
const IRREGULAR_VERB_STEMS = {
  became: 'become',
  began: 'begin',
  begun: 'begin',
  bought: 'buy',
  broke: 'break',
  broken: 'break',
  brought: 'bring',
  built: 'build',
  came: 'come',
  caught: 'catch',
  chose: 'choose',
  chosen: 'choose',
  dealt: 'deal',
  did: 'do',
  done: 'do',
  does: 'do',
  drawn: 'draw',
  drew: 'draw',
  driven: 'drive',
  drove: 'drive',
  fallen: 'fall',
  fell: 'fall',
  felt: 'feel',
  flew: 'fly',
  flown: 'fly',
  fought: 'fight',
  found: 'find',
  gave: 'give',
  given: 'give',
  gone: 'go',
  got: 'get',
  gotten: 'get',
  grew: 'grow',
  grown: 'grow',
  had: 'have',
  has: 'have',
  heard: 'hear',
  held: 'hold',
  kept: 'keep',
  knew: 'know',
  known: 'know',
  laid: 'lay',
  led: 'lead',
  left: 'leave',
  lit: 'light',
  lost: 'lose',
  made: 'make',
  meant: 'mean',
  met: 'meet',
  paid: 'pay',
  ran: 'run',
  risen: 'rise',
  rose: 'rise',
  said: 'say',
  sank: 'sink',
  sat: 'sit',
  saw: 'see',
  seen: 'see',
  sent: 'send',
  shaken: 'shake',
  shook: 'shake',
  sped: 'speed',
  spent: 'spend',
  spoke: 'speak',
  spoken: 'speak',
  stood: 'stand',
  struck: 'strike',
  sunk: 'sink',
  swore: 'swear',
  sworn: 'swear',
  taken: 'take',
  taught: 'teach',
  thought: 'think',
  told: 'tell',
  took: 'take',
  tore: 'tear',
  torn: 'tear',
  understood: 'understand',
  was: 'be',
  went: 'go',
  were: 'be',
  withdrawn: 'withdraw',
  withdrew: 'withdraw',
  won: 'win',
  wore: 'wear',
  worn: 'wear',
  written: 'write',
  wrote: 'write',
}

const normalizeSurface = value => String(value || '').replace(/\s+/gu, ' ').trim()

const cleanWord = value =>
  String(value || '')
    .toLowerCase()
    .replace(/[’']/gu, "'")
    .replace(/^[^a-z]+|[^a-z]+$/gu, '')

const escapeRegex = value => value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')

const hasOwn = (obj, key) => Boolean(obj && Object.prototype.hasOwnProperty.call(obj, key))

function isWordBoundary(text, start, end) {
  const prev = start > 0 ? text[start - 1] : ''
  const next = end < text.length ? text[end] : ''
  const leftOk = !prev || !WORD_CHAR_RE.test(prev)
  const rightOk = !next || !WORD_CHAR_RE.test(next)
  return leftOk && rightOk
}

/**
 * Generate candidate base verb forms for the leading word of a potential
 * inflected phrasal verb (e.g. "relied" -> "rely", "grew" -> "grow",
 * "stemmed" -> "stem", "depending" -> "depend", "bringing" -> "bring").
 */
export function verbLemmaCandidates(word, lemmaMap = null) {
  const w = cleanWord(word)
  if (!w || w.includes(' ') || w.includes("'") || w.includes('-')) return []
  const out = []
  const add = cand => {
    if (cand && cand.length >= 2 && cand !== w && !out.includes(cand)) out.push(cand)
  }

  if (hasOwn(IRREGULAR_VERB_STEMS, w)) add(IRREGULAR_VERB_STEMS[w])
  if (lemmaMap && hasOwn(lemmaMap, w) && typeof lemmaMap[w] === 'string') {
    add(lemmaMap[w].toLowerCase())
  }

  if (w.endsWith('ies') && w.length > 4) add(`${w.slice(0, -3)}y`)
  if (w.endsWith('es') && w.length > 4) {
    add(w.slice(0, -2))
    add(w.slice(0, -1))
  }
  if (w.endsWith('s') && w.length > 3 && !w.endsWith('ss')) add(w.slice(0, -1))

  if (w.endsWith('ied') && w.length > 4) add(`${w.slice(0, -3)}y`)
  if (w.endsWith('ed') && w.length > 4) {
    const stem = w.slice(0, -2)
    add(stem)
    add(w.slice(0, -1))
    if (stem.length >= 3 && stem[stem.length - 1] === stem[stem.length - 2]) {
      add(stem.slice(0, -1))
    }
  }

  if (w.endsWith('ying') && w.length > 5) add(`${w.slice(0, -4)}ie`)
  if (w.endsWith('ing') && w.length > 5) {
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
 * Look up a multi-word sequence [w0, w1, ...] in staticPhrases:
 * 1. Exact lowercase phrase match
 * 2. Inflected phrasal verb match [lemmatize(w0), w1, ...]
 */
export function matchStaticPhraseWords(words, staticPhrases, lemmaMap = null) {
  if (!staticPhrases || !Array.isArray(words) || words.length < 2) return null

  const exactKey = words.join(' ')
  if (hasOwn(staticPhrases, exactKey)) {
    return { key: exactKey, record: staticPhrases[exactKey] }
  }

  // Test inflected phrasal verb forms on the leading verb w0
  const tail = words.slice(1).join(' ')
  const verbBases = verbLemmaCandidates(words[0], lemmaMap)
  for (const base of verbBases) {
    const candidateKey = `${base} ${tail}`
    if (hasOwn(staticPhrases, candidateKey)) {
      const rec = staticPhrases[candidateKey]
      const pos = String(rec?.p || '').toLowerCase()
      if (pos === 'phrasal verb' || pos === 'verb') {
        return { key: candidateKey, record: rec }
      }
    }
  }

  return null
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

function mergeStaticPhrases(plainTokens, staticPhrases, lemmaMap = null) {
  if (!staticPhrases || typeof staticPhrases !== 'object' || plainTokens.length < 3) {
    return plainTokens
  }

  const out = []
  let i = 0
  while (i < plainTokens.length) {
    if (plainTokens[i].kind !== 'word') {
      out.push(plainTokens[i])
      i++
      continue
    }

    let matched = null
    let matchedWordCount = 0

    // Greedy longest-match: 4 -> 3 -> 2 words
    for (let n = MAX_PHRASE_WORDS; n >= 2; n--) {
      const lastTokenIdx = i + 2 * (n - 1)
      if (lastTokenIdx >= plainTokens.length) continue

      let contiguous = true
      const words = []
      for (let k = 0; k < n; k++) {
        const wordTok = plainTokens[i + 2 * k]
        if (!wordTok || wordTok.kind !== 'word') {
          contiguous = false
          break
        }
        words.push(wordTok.lookupKey)
        if (k < n - 1) {
          const sepTok = plainTokens[i + 2 * k + 1]
          if (!sepTok || sepTok.kind !== 'text' || !HORIZONTAL_SPACE_RE.test(sepTok.text)) {
            contiguous = false
            break
          }
        }
      }

      if (!contiguous) continue

      const hit = matchStaticPhraseWords(words, staticPhrases, lemmaMap)
      if (hit) {
        matched = hit
        matchedWordCount = n
        break
      }
    }

    if (matched) {
      const spanEnd = i + 2 * (matchedWordCount - 1)
      let surfaceText = ''
      for (let j = i; j <= spanEnd; j++) {
        surfaceText += plainTokens[j].text
      }
      const pos = String(matched.record?.p || 'phrase').trim()
      out.push({
        kind: 'phrase',
        text: surfaceText,
        lookupKey: matched.key,
        entry: {
          lemma: matched.key,
          surface: surfaceText,
          type: pos === 'phrasal verb' ? 'phrasal_verb' : 'phrase',
          pos,
          ipa: matched.record?.ipa || '',
          m: Array.isArray(matched.record?.m) ? matched.record.m : [],
          isStaticPhrase: true,
        },
      })
      i = spanEnd + 1
    } else {
      out.push(plainTokens[i])
      i++
    }
  }

  return out
}

function tokenizePlainWithPhrases(segment, staticPhrases = null, lemmaMap = null) {
  const plain = splitPlainSegment(segment)
  if (!staticPhrases) return plain
  return mergeStaticPhrases(plain, staticPhrases, lemmaMap)
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
 * - { kind: 'glossary', text, lookupKey, entry }        -> Tier-1 article glossary (0ms)
 * - { kind: 'phrase',   text, lookupKey, entry }        -> Tier-1.5 static phrase (0ms)
 * - { kind: 'word',     text, lookupKey, entry: null }  -> single clickable word (Tier 2)
 * - { kind: 'text',     text, lookupKey: '', entry: null } -> whitespace / punctuation
 */
export function tokenizeWithGlossary(
  text,
  glossary = null,
  staticPhrases = null,
  lemmaMap = null
) {
  const source = String(text || '')
  if (!source) return []

  const entries = prepareGlossaryEntries(glossary)
  if (!entries.length) return tokenizePlainWithPhrases(source, staticPhrases, lemmaMap)

  // Compile each unique surface pattern with flexible internal whitespace.
  const compiled = entries.map(entry => {
    const pattern = escapeRegex(entry.surface).replace(/\s+/gu, '\\s+')
    return {
      entry,
      regex: new RegExp(pattern, 'giu'),
    }
  })

  // Collect non-overlapping greedy longest-match spans for Tier-1 glossary.
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

  if (!spans.length) return tokenizePlainWithPhrases(source, staticPhrases, lemmaMap)

  spans.sort((a, b) => a.start - b.start)
  const tokens = []
  let cursor = 0

  for (const span of spans) {
    if (span.start > cursor) {
      tokens.push(...tokenizePlainWithPhrases(source.slice(cursor, span.start), staticPhrases, lemmaMap))
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
    tokens.push(...tokenizePlainWithPhrases(source.slice(cursor), staticPhrases, lemmaMap))
  }

  return tokens
}

export { cleanWord }
