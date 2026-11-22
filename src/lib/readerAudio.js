// Modular Audio Engine for SAGA Reader & Dictionary
// - Smart Neural/Enhanced English voice selection with async voiceschanged handling
// - Sentence chunking (<= ~200 chars) & CEFR-aware speaking rates
// - Optional Phase-2 `page.audioUrl` HTMLAudioElement playback with seamless TTS fallback
// - Real human Wikimedia/Wiktionary word pronunciation with fast <=700ms timeout + TTS fallback
// - Continuous Auto-Read + Auto-Page-Turn controller with strict cancellation guards

export const PAGE_TURN_PAUSE_MS = 550
export const WORD_AUDIO_TIMEOUT_MS = 650
export const MAX_CHUNK_CHARS = 200

export const LEVEL_SPEECH_RATES = Object.freeze({
  'A1-A2': 0.92,
  'B1-B2': 0.97,
  'C1-C2': 1.0,
})

const NOVELTY_VOICE_RE = /\b(zarvox|trinoids|bells|albert|fred|espeak|bad news|bahh|boing|bubbles|cellos|deranged|good news|hysterical|jester|organ|superstar|whisper|wobble|junior|kathy|ralph|bruce|agnes|vicki|eloquence|compact)\b/i
const ABBREVIATION_END_RE = /(?:^|[\s([{"'“‘])(?:Mr|Mrs|Ms|Dr|Prof|Sr|Jr|St|vs|etc|e\.g|i\.e|U\.S|U\.K|U\.N|E\.U|A\.M|P\.M|a\.m|p\.m|No|Fig|Vol|Inc|Ltd|Co|Gen|Col|Lt|Sgt|Gov|Sen|Rep|Jan|Feb|Mar|Apr|Aug|Sept|Oct|Nov|Dec|[A-HJ-Z])\.$/i

export function rateForReadingLevel(level) {
  return LEVEL_SPEECH_RATES[level] ?? LEVEL_SPEECH_RATES['B1-B2']
}

export function isSafeAudioUrl(url) {
  if (typeof url !== 'string') return false
  const trimmed = url.trim()
  if (!trimmed) return false
  if (trimmed.startsWith('/') && !trimmed.startsWith('//')) return true
  try {
    const parsed = new URL(trimmed)
    return parsed.protocol === 'https:'
  } catch {
    return false
  }
}

function voiceLocaleBonus(lang) {
  const norm = String(lang || '').replace('_', '-').toLowerCase()
  if (norm === 'en-us') return 6
  if (norm === 'en-gb') return 4
  if (norm === 'en-au') return 2
  return 0
}

function scoreEnglishVoice(voice) {
  if (!voice) return -1
  const lang = String(voice.lang || '').replace('_', '-')
  if (!/^en(?:-|$)/i.test(lang)) return -1
  const name = String(voice.name || '')
  if (NOVELTY_VOICE_RE.test(name)) return -1

  const localeBonus = voiceLocaleBonus(lang)

  // Tier 1: Edge / Windows Natural Online & any Neural / Natural English voice
  if (/microsoft\s+aria\b.*(natural|neural)/i.test(name)) return 450 + localeBonus
  if (/microsoft\s+jenny\b.*(natural|neural)/i.test(name)) return 445 + localeBonus
  if (/microsoft\s+guy\b.*(natural|neural)/i.test(name)) return 440 + localeBonus
  if (/microsoft\b.*online.*\b(natural|neural)\b/i.test(name)) return 430 + localeBonus
  if (/\b(natural|neural)\b/i.test(name)) return 415 + localeBonus

  // Tier 2: Apple Enhanced / Premium / Siri / high-craft macOS & iOS voices
  if (/\bava\b.*premium/i.test(name)) return 350 + localeBonus
  if (/\bsamantha\b.*enhanced/i.test(name)) return 345 + localeBonus
  if (/\bdaniel\b.*enhanced/i.test(name)) return 340 + localeBonus
  if (/\bpremium\b/i.test(name)) return 335 + localeBonus
  if (/\benhanced\b/i.test(name)) return 330 + localeBonus
  if (/\bsiri\b/i.test(name)) return 325 + localeBonus
  if (/\b(samantha|ava|allison|daniel|karen)\b/i.test(name)) return 315 + localeBonus

  // Tier 3: Chrome / Android Google voices
  if (/^google us english$/i.test(name)) return 235 + localeBonus
  if (/^google uk english female$/i.test(name)) return 230 + localeBonus
  if (/^google uk english male$/i.test(name)) return 225 + localeBonus
  if (/\bgoogle\b/i.test(name)) return 210 + localeBonus

  // Tier 4: Standard clean en-US / en-GB / en-AU fallback
  if (/^en-us$/i.test(lang)) return 120 + (voice.localService ? 2 : 0)
  if (/^en-gb$/i.test(lang)) return 115 + (voice.localService ? 2 : 0)
  if (/^en-au$/i.test(lang)) return 110 + (voice.localService ? 2 : 0)
  return 100
}

export function selectBestEnglishVoice(voices) {
  if (!Array.isArray(voices) || !voices.length) return null
  let best = null
  let bestScore = -1
  for (const voice of voices) {
    const score = scoreEnglishVoice(voice)
    if (score > bestScore) {
      bestScore = score
      best = voice
    }
  }
  return bestScore >= 0 ? best : null
}

export function getVoicesReady(synth, timeoutMs = 450) {
  if (!synth || typeof synth.getVoices !== 'function') return Promise.resolve([])
  const immediate = synth.getVoices()
  if (Array.isArray(immediate) && immediate.length > 0) {
    return Promise.resolve(immediate)
  }
  return new Promise(resolve => {
    let settled = false
    const finish = () => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (typeof synth.removeEventListener === 'function') {
        synth.removeEventListener('voiceschanged', onChanged)
      }
      if (synth.onvoiceschanged === onChanged) {
        synth.onvoiceschanged = null
      }
      const list = synth.getVoices()
      resolve(Array.isArray(list) ? list : [])
    }
    const onChanged = () => {
      const list = synth.getVoices()
      if (Array.isArray(list) && list.length > 0) finish()
    }
    const timer = setTimeout(finish, timeoutMs)
    if (typeof synth.addEventListener === 'function') {
      synth.addEventListener('voiceschanged', onChanged)
    } else if ('onvoiceschanged' in synth) {
      synth.onvoiceschanged = onChanged
    }
  })
}

function splitOverlongSentence(sentence, maxChars) {
  const clean = sentence.trim()
  if (clean.length <= maxChars) return clean ? [clean] : []

  // Try splitting along natural clause punctuation (; : — ,) while preserving punctuation
  const clauses = clean.match(/[^,;:—–]+(?:[,;:—–]+|$)/g) || [clean]
  const out = []
  let buf = ''

  const pushWordSplit = text => {
    const words = text.trim().split(/\s+/).filter(Boolean)
    let line = ''
    for (const w of words) {
      if (!line) {
        line = w
      } else if (line.length + 1 + w.length <= maxChars) {
        line += ' ' + w
      } else {
        out.push(line)
        line = w
      }
    }
    if (line) out.push(line)
  }

  for (const rawClause of clauses) {
    const clause = rawClause.trim()
    if (!clause) continue
    if (clause.length > maxChars) {
      if (buf) {
        out.push(buf)
        buf = ''
      }
      pushWordSplit(clause)
    } else if (!buf) {
      buf = clause
    } else if (buf.length + 1 + clause.length <= maxChars) {
      buf += ' ' + clause
    } else {
      out.push(buf)
      buf = clause
    }
  }
  if (buf) out.push(buf)
  return out
}

// Deterministic, Safari-15-safe sentence splitter (no lookbehind).
// Joining the returned array reproduces the exact original text verbatim,
// preserving abbreviations (Dr., Mr., U.S., U.K.), decimals (3.14), and spacing.
export function splitPageIntoSentences(text) {
  const source = String(text ?? '')
  if (!source) return []

  const segments = []
  const boundaryRe = /([.!?…]+["”’')\]]*)(\s+|$)/g
  let start = 0
  let match

  while ((match = boundaryRe.exec(source)) !== null) {
    const punctEnd = match.index + match[1].length
    const afterWs = punctEnd + match[2].length
    if (afterWs <= start) continue

    const candidateCore = source.slice(start, punctEnd)
    // Keep abbreviations attached to the following words within the same sentence
    if (afterWs < source.length && ABBREVIATION_END_RE.test(candidateCore)) {
      continue
    }

    segments.push(source.slice(start, afterWs))
    start = afterWs
  }

  if (start < source.length) {
    segments.push(source.slice(start))
  }

  return segments
}

export function chunkSpeechText(text, maxChars = MAX_CHUNK_CHARS) {
  const normalized = String(text || '').replace(/\s+/g, ' ').trim()
  if (!normalized) return []
  const limit = Math.max(60, Number(maxChars) || MAX_CHUNK_CHARS)

  const sentences = splitPageIntoSentences(normalized)
    .map(part => part.trim())
    .filter(Boolean)

  const chunks = []
  for (const sentence of sentences) {
    if (sentence.length > limit) {
      chunks.push(...splitOverlongSentence(sentence, limit))
    } else {
      chunks.push(sentence)
    }
  }
  return chunks
}

function defaultCreateAudio(url) {
  if (typeof Audio === 'undefined') return null
  const audio = new Audio()
  audio.preload = 'auto'
  audio.src = url
  return audio
}

function canBrowserPlayAudioMime(mime, url, probeAudio) {
  const audio = probeAudio || (typeof Audio !== 'undefined' ? new Audio() : null)
  if (!audio || typeof audio.canPlayType !== 'function') return true
  const m = String(mime || '').toLowerCase()
  const u = String(url || '').toLowerCase()
  if (m.includes('ogg') || u.endsWith('.ogg') || u.endsWith('.oga')) {
    return Boolean(audio.canPlayType('audio/ogg; codecs="vorbis"') || audio.canPlayType('audio/ogg'))
  }
  if (m.includes('mpeg') || m.includes('mp3') || u.endsWith('.mp3')) {
    return Boolean(audio.canPlayType('audio/mpeg'))
  }
  if (m.includes('wav') || u.endsWith('.wav')) {
    return Boolean(audio.canPlayType('audio/wav'))
  }
  if (m.includes('mp4') || m.includes('m4a') || u.endsWith('.m4a')) {
    return Boolean(audio.canPlayType('audio/mp4'))
  }
  return Boolean(m ? audio.canPlayType(m) : true)
}

function buildWikimediaTitleCandidates(word) {
  const lower = word.toLowerCase()
  const cap = lower.charAt(0).toUpperCase() + lower.slice(1)
  return [
    `File:En-us-${lower}.ogg`,
    `File:En-us-${cap}.ogg`,
    `File:En-us-${lower}.mp3`,
    `File:En-uk-${lower}.ogg`,
    `File:En-uk-${cap}.ogg`,
    `File:En-uk-${lower}.mp3`,
  ]
}

const wordAudioCache = new Map()

export function clearWordAudioCache() {
  wordAudioCache.clear()
}

export async function lookupWikimediaWordAudio(word, {
  fetchImpl = typeof fetch === 'function' ? fetch : null,
  timeoutMs = WORD_AUDIO_TIMEOUT_MS,
  probeAudio = null,
} = {}) {
  const cleaned = String(word || '').trim().replace(/^[^a-zA-Z]+|[^a-zA-Z]+$/g, '')
  if (!cleaned || !/^[a-zA-Z'-]{2,40}$/.test(cleaned)) return null

  const cacheKey = cleaned.toLowerCase()
  if (wordAudioCache.has(cacheKey)) {
    return wordAudioCache.get(cacheKey)
  }
  if (!fetchImpl) return null
  if (typeof navigator !== 'undefined' && navigator.onLine === false) return null

  const candidates = buildWikimediaTitleCandidates(cleaned)
  const apiUrl = `https://commons.wikimedia.org/w/api.php?action=query&format=json&origin=*&prop=imageinfo&iiprop=url|mime&titles=${encodeURIComponent(candidates.join('|'))}`

  const controller = typeof AbortController !== 'undefined' ? new AbortController() : null
  const timer = setTimeout(() => controller?.abort(), Math.min(700, Math.max(150, timeoutMs)))

  try {
    const response = await fetchImpl(apiUrl, controller ? { signal: controller.signal } : undefined)
    if (!response || !response.ok) {
      wordAudioCache.set(cacheKey, null)
      return null
    }
    const payload = await response.json()
    const pages = Object.values(payload?.query?.pages || {})
    // Rank matches by our preferred order (US before UK, playable MIME only)
    const foundByTitle = new Map()
    for (const page of pages) {
      const info = Array.isArray(page?.imageinfo) ? page.imageinfo[0] : null
      const url = info?.url
      const mime = info?.mime || ''
      if (url && isSafeAudioUrl(url) && canBrowserPlayAudioMime(mime, url, probeAudio)) {
        foundByTitle.set(String(page.title || '').toLowerCase(), url)
      }
    }
    let chosen = null
    for (const candidate of candidates) {
      const hit = foundByTitle.get(candidate.toLowerCase())
      if (hit) {
        chosen = hit
        break
      }
    }
    wordAudioCache.set(cacheKey, chosen)
    return chosen
  } catch {
    return null
  } finally {
    clearTimeout(timer)
  }
}

export function createArticleReaderController({
  synth = typeof window !== 'undefined' ? window.speechSynthesis : null,
  UtteranceCtor = typeof window !== 'undefined' ? window.SpeechSynthesisUtterance : null,
  createAudio = defaultCreateAudio,
  fetchImpl = typeof fetch === 'function' ? fetch : null,
  setTimeoutFn = (...args) => setTimeout(...args),
  clearTimeoutFn = id => clearTimeout(id),
  pageTurnPauseMs = PAGE_TURN_PAUSE_MS,
  wordTimeoutMs = WORD_AUDIO_TIMEOUT_MS,
  onStateChange = () => {},
  onAdvancePage = () => {},
  onSentenceChange = () => {},
} = {}) {
  let sessionId = 0
  let playing = false
  let currentPageIndex = 0
  let activeSentenceIndex = null
  let activeAudio = null
  let pendingTimer = null

  const clearPendingTimer = () => {
    if (pendingTimer !== null) {
      clearTimeoutFn(pendingTimer)
      pendingTimer = null
    }
  }

  const stopActiveAudioElement = () => {
    if (!activeAudio) return
    const audio = activeAudio
    activeAudio = null
    try {
      audio.onended = null
      audio.onerror = null
      audio.pause?.()
      if ('currentTime' in audio) audio.currentTime = 0
    } catch {
      /* ignore audio cleanup errors */
    }
  }

  const emitSentence = nextIndex => {
    if (activeSentenceIndex === nextIndex) return
    activeSentenceIndex = nextIndex
    onSentenceChange(nextIndex)
  }

  const emitState = (isPlaying, pageIndex = currentPageIndex) => {
    playing = isPlaying
    currentPageIndex = pageIndex
    onStateChange({ playing, pageIndex })
  }

  const stop = () => {
    sessionId += 1
    clearPendingTimer()
    stopActiveAudioElement()
    try {
      synth?.cancel?.()
    } catch {
      /* ignore synth cancel errors */
    }
    emitSentence(null)
    if (playing) {
      emitState(false, currentPageIndex)
    } else {
      playing = false
    }
  }

  const speakUtteranceQueue = async (chunks, rate, expectedSessionId) => {
    if (!synth || !UtteranceCtor || !chunks.length) return false
    const voices = await getVoicesReady(synth)
    if (sessionId !== expectedSessionId) return false
    const preferredVoice = selectBestEnglishVoice(voices)

    for (const chunk of chunks) {
      if (sessionId !== expectedSessionId) return false
      const finished = await new Promise(resolve => {
        const utterance = new UtteranceCtor(chunk)
        utterance.lang = preferredVoice?.lang || 'en-US'
        if (preferredVoice) utterance.voice = preferredVoice
        utterance.rate = rate
        utterance.pitch = 1.0
        utterance.onend = () => resolve(true)
        utterance.onerror = () => resolve(false)
        try {
          synth.speak(utterance)
        } catch {
          resolve(false)
        }
      })
      if (!finished || sessionId !== expectedSessionId) return false
    }
    return sessionId === expectedSessionId
  }

  const playAudioUrl = (url, expectedSessionId) => {
    if (!isSafeAudioUrl(url) || !createAudio) return Promise.resolve(false)
    return new Promise(resolve => {
      const audio = createAudio(url)
      if (!audio) {
        resolve(false)
        return
      }
      activeAudio = audio
      let settled = false
      const done = ok => {
        if (settled) return
        settled = true
        if (activeAudio === audio) activeAudio = null
        audio.onended = null
        audio.onerror = null
        resolve(ok && sessionId === expectedSessionId)
      }
      audio.onended = () => done(true)
      audio.onerror = () => done(false)
      try {
        const playPromise = audio.play?.()
        if (playPromise && typeof playPromise.then === 'function') {
          playPromise.catch(() => done(false))
        }
      } catch {
        done(false)
      }
    })
  }

  const waitDelay = (ms, expectedSessionId) => new Promise(resolve => {
    clearPendingTimer()
    pendingTimer = setTimeoutFn(() => {
      pendingTimer = null
      resolve(sessionId === expectedSessionId)
    }, ms)
  })

  const runPageLoop = async ({ pages, startPage, readingLevel }, expectedSessionId) => {
    const rate = rateForReadingLevel(readingLevel)
    let idx = startPage

    while (idx < pages.length && sessionId === expectedSessionId) {
      emitState(true, idx)
      const pageObj = pages[idx]
      let pageOk = false

      // Phase-2 hook: prefer pre-generated MP3/audioUrl if provided on the page object
      if (pageObj?.audioUrl && isSafeAudioUrl(pageObj.audioUrl)) {
        emitSentence(null)
        pageOk = await playAudioUrl(pageObj.audioUrl, expectedSessionId)
        if (sessionId !== expectedSessionId) return
      }

      // Seamless fallback to sentence-synchronized Neural/Enhanced SpeechSynthesis
      // Always read body text directly (skip headline on Page 1 and skip image captions)
      if (!pageOk) {
        const sentences = splitPageIntoSentences(pageObj?.text || '')
        for (let sIdx = 0; sIdx < sentences.length; sIdx += 1) {
          if (sessionId !== expectedSessionId) return
          const spokenText = sentences[sIdx].replace(/\s+/g, ' ').trim()
          if (!spokenText) continue
          emitSentence(sIdx)
          const subChunks = spokenText.length > MAX_CHUNK_CHARS
            ? splitOverlongSentence(spokenText, MAX_CHUNK_CHARS)
            : [spokenText]
          const sentenceOk = await speakUtteranceQueue(subChunks, rate, expectedSessionId)
          if (!sentenceOk || sessionId !== expectedSessionId) {
            if (sessionId === expectedSessionId) {
              emitSentence(null)
              emitState(false, idx)
            }
            return
          }
        }
      }

      // Clear active sentence highlight before transitioning or finishing
      emitSentence(null)

      // Natural pause & auto-page-turn if more pages remain; otherwise stop cleanly at story end
      if (idx + 1 < pages.length) {
        const proceed = await waitDelay(pageTurnPauseMs, expectedSessionId)
        if (!proceed || sessionId !== expectedSessionId) return
        idx += 1
        onAdvancePage(idx)
      } else {
        if (sessionId === expectedSessionId) {
          emitState(false, idx)
        }
        return
      }
    }

    if (sessionId === expectedSessionId) {
      emitSentence(null)
      emitState(false, Math.min(idx, Math.max(0, pages.length - 1)))
    }
  }

  const start = ({ pages = [], startPage = 0, readingLevel = 'B1-B2' } = {}) => {
    stop()
    if (!Array.isArray(pages) || startPage < 0 || startPage >= pages.length) return false
    const expectedSessionId = ++sessionId
    currentPageIndex = startPage
    emitState(true, startPage)
    runPageLoop({ pages, startPage, readingLevel }, expectedSessionId)
    return true
  }

  const playWordPronunciation = async (word) => {
    const cleanWord = String(word || '').trim()
    if (!cleanWord) return false
    // Immediately stop any active article narration so two voices never overlap
    stop()
    const expectedSessionId = ++sessionId

    const humanUrl = await lookupWikimediaWordAudio(cleanWord, {
      fetchImpl,
      timeoutMs: wordTimeoutMs,
    })
    if (sessionId !== expectedSessionId) return false

    if (humanUrl) {
      const played = await playAudioUrl(humanUrl, expectedSessionId)
      if (played || sessionId !== expectedSessionId) return played
    }

    // Immediate fallback to best Neural/Enhanced English voice at calm learner speed
    return speakUtteranceQueue([cleanWord], 0.92, expectedSessionId)
  }

  return {
    start,
    stop,
    playWordPronunciation,
    isPlaying: () => playing,
    getPageIndex: () => currentPageIndex,
    getSentenceIndex: () => activeSentenceIndex,
  }
}

// Standalone helper for single-word playback when invoked outside a controller instance
export async function playWordPronunciation(word, deps = {}) {
  const controller = createArticleReaderController(deps)
  return controller.playWordPronunciation(word)
}
