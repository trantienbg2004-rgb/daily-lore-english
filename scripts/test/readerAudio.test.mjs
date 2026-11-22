import test from 'node:test'
import assert from 'node:assert/strict'
import {
  selectBestEnglishVoice,
  splitPageIntoSentences,
  chunkSpeechText,
  rateForReadingLevel,
  createArticleReaderController,
  clearWordAudioCache,
  PAGE_TURN_PAUSE_MS,
} from '../../src/lib/readerAudio.js'

function createMockSynth(voices = [], { autoFinish = true } = {}) {
  const spoken = []
  let cancelCount = 0
  let pendingUtterance = null

  const synth = {
    getVoices: () => voices,
    addEventListener: () => {},
    removeEventListener: () => {},
    cancel: () => {
      cancelCount += 1
      pendingUtterance = null
    },
    speak: (utterance) => {
      spoken.push({
        text: utterance.text,
        rate: utterance.rate,
        pitch: utterance.pitch,
        voice: utterance.voice?.name || null,
        lang: utterance.lang,
      })
      pendingUtterance = utterance
      if (autoFinish) {
        queueMicrotask(() => {
          if (pendingUtterance === utterance) {
            pendingUtterance = null
            utterance.onend?.()
          }
        })
      }
    },
  }

  return {
    synth,
    spoken,
    getCancelCount: () => cancelCount,
    finishCurrent: () => {
      const current = pendingUtterance
      pendingUtterance = null
      current?.onend?.()
    },
  }
}

class MockUtterance {
  constructor(text) {
    this.text = text
    this.lang = 'en-US'
    this.voice = null
    this.rate = 1
    this.pitch = 1
    this.onend = null
    this.onerror = null
  }
}

test('selectBestEnglishVoice ranks Natural/Enhanced/Google voices above defaults and skips novelty voices', () => {
  const noveltyAndDefault = [
    { name: 'Zarvox', lang: 'en-US' },
    { name: 'Trinoids', lang: 'en-US' },
    { name: 'Bells', lang: 'en-US' },
    { name: 'Albert', lang: 'en-US' },
    { name: 'Fred', lang: 'en-US' },
    { name: 'eSpeak English', lang: 'en-GB' },
    { name: 'System English', lang: 'en-US' },
  ]
  assert.equal(selectBestEnglishVoice(noveltyAndDefault)?.name, 'System English')

  const mixedStack = [
    { name: 'Zarvox', lang: 'en-US' },
    { name: 'Google US English', lang: 'en-US' },
    { name: 'Samantha (Enhanced)', lang: 'en-US' },
    { name: 'Microsoft Aria Online (Natural) - English (United States)', lang: 'en-US' },
    { name: 'French Voice', lang: 'fr-FR' },
  ]
  assert.equal(
    selectBestEnglishVoice(mixedStack)?.name,
    'Microsoft Aria Online (Natural) - English (United States)'
  )

  const appleAndGoogle = [
    { name: 'Google US English', lang: 'en-US' },
    { name: 'Ava (Premium)', lang: 'en-US' },
    { name: 'Samantha', lang: 'en-US' },
  ]
  assert.equal(selectBestEnglishVoice(appleAndGoogle)?.name, 'Ava (Premium)')

  const googleFallback = [
    { name: 'Fred', lang: 'en-US' },
    { name: 'Google UK English Female', lang: 'en-GB' },
    { name: 'Google US English', lang: 'en-US' },
  ]
  assert.equal(selectBestEnglishVoice(googleFallback)?.name, 'Google US English')

  assert.equal(selectBestEnglishVoice([{ name: 'Zarvox', lang: 'en-US' }]), null)
})

test('splitPageIntoSentences preserves exact reconstruction, abbreviations, decimals, and punctuation', () => {
  const samples = [
    'Dr. Elena Vance studied U.S. coastal winds at 3.14 meters. Mr. Brooks compared U.K. charts! Did costs rise by $4.5 million? Yes, they did.',
    '  Leading space stays intact.  Double space too!  ',
    'Wait... really?! "Yes," she replied. Then John F. Kennedy spoke.',
    'A single sentence without terminal punctuation',
    'Version 2.0. Next release arrived quickly.',
  ]

  for (const sample of samples) {
    const parts = splitPageIntoSentences(sample)
    assert.equal(parts.join(''), sample, `Exact text reconstruction failed for: ${sample}`)
  }

  const firstParts = splitPageIntoSentences(samples[0])
  assert.equal(firstParts.length, 4)
  assert.equal(firstParts[0], 'Dr. Elena Vance studied U.S. coastal winds at 3.14 meters. ')
  assert.equal(firstParts[1], 'Mr. Brooks compared U.K. charts! ')
  assert.equal(firstParts[2], 'Did costs rise by $4.5 million? ')
  assert.equal(firstParts[3], 'Yes, they did.')

  assert.deepEqual(splitPageIntoSentences(''), [])
})

test('chunkSpeechText splits cleanly into sentences, preserves punctuation, and caps long sentences', () => {
  const paragraph = 'Dr. Elena Vance studied U.S. coastal winds for years. Her team built light sensors along the reef! Could small cities prepare faster? Yes, early readings already saved entire harbors during severe autumn storms that swept across the northern peninsula and damaged three older shipping terminals.'
  const chunks = chunkSpeechText(paragraph, 180)

  assert.ok(chunks.length >= 4, `Expected >= 4 chunks, got ${chunks.length}`)
  assert.ok(chunks[0].startsWith('Dr. Elena Vance studied U.S. coastal winds'), 'Should not break on Dr. or U.S. abbreviations')
  for (const chunk of chunks) {
    assert.ok(chunk.length <= 180, `Chunk exceeded 180 chars (${chunk.length}): "${chunk}"`)
  }
  assert.match(chunks.join(' '), /reef!/, 'Preserves exclamation punctuation')
  assert.match(chunks.join(' '), /faster\?/, 'Preserves question punctuation')
  assert.match(chunks[chunks.length - 1], /\.$/, 'Preserves terminal period')
})

test('rateForReadingLevel applies gentle CEFR-aware pacing', () => {
  assert.equal(rateForReadingLevel('A1-A2'), 0.92)
  assert.equal(rateForReadingLevel('B1-B2'), 0.97)
  assert.equal(rateForReadingLevel('C1-C2'), 1.0)
})

test('Page 1 skips headline, emits 1:1 sentence indices across auto-page-turn, and resets to null at end', async () => {
  const { synth, spoken } = createMockSynth([
    { name: 'Microsoft Jenny Online (Natural)', lang: 'en-US' },
  ])
  const states = []
  const sentenceEvents = []
  const advancedPages = []
  const delays = []

  const page0Text = 'Dr. Lin mapped the ancient fort. Stone walls guarded the river valley.'
  const page1Text = 'Merchants traveled safely along the road. Markets grew quickly!'

  const controller = createArticleReaderController({
    synth,
    UtteranceCtor: MockUtterance,
    setTimeoutFn: (fn, ms) => {
      delays.push(ms)
      return setTimeout(fn, 1)
    },
    clearTimeoutFn: id => clearTimeout(id),
    onStateChange: state => states.push({ ...state }),
    onSentenceChange: idx => sentenceEvents.push(idx),
    onAdvancePage: nextIdx => advancedPages.push(nextIdx),
  })

  controller.start({
    title: 'Headline That Must Be Skipped On Page One',
    pages: [
      { text: page0Text, caption: 'Do not read caption' },
      { text: page1Text, caption: 'Also skipped' },
    ],
    startPage: 0,
    readingLevel: 'A1-A2',
  })

  await new Promise(resolve => setTimeout(resolve, 60))

  // Must NEVER read the headline; spoken chunks match splitPageIntoSentences 1:1
  const expectedPage0 = splitPageIntoSentences(page0Text).map(s => s.trim())
  const expectedPage1 = splitPageIntoSentences(page1Text).map(s => s.trim())
  assert.deepEqual(
    spoken.map(item => item.text),
    [...expectedPage0, ...expectedPage1]
  )
  assert.ok(!spoken.some(item => item.text.includes('Headline That Must Be Skipped')))
  assert.ok(spoken.every(item => item.rate === 0.92), 'A1-A2 rate applied to all chunks')
  assert.ok(spoken.every(item => item.voice === 'Microsoft Jenny Online (Natural)'))

  // Only the page-turn pause (550ms) runs — no 350ms headline pause
  assert.deepEqual(delays, [PAGE_TURN_PAUSE_MS])
  assert.deepEqual(advancedPages, [1])

  // Sentence events: page 0 (0 -> 1 -> null during turn) -> page 1 (0 -> 1 -> null at end)
  assert.deepEqual(sentenceEvents, [0, 1, null, 0, 1, null])
  assert.equal(controller.getSentenceIndex(), null)
  assert.equal(controller.isPlaying(), false)
  assert.equal(states[0].playing, true)
  assert.equal(states[states.length - 1].playing, false)
  assert.equal(states[states.length - 1].pageIndex, 1)
})

test('stop, manual page turn, or level switch immediately clears activeSentenceIndex to null and prevents ghost page turns', async () => {
  const { synth, getCancelCount, finishCurrent } = createMockSynth(
    [{ name: 'Google US English', lang: 'en-US' }],
    { autoFinish: false }
  )
  const advancedPages = []
  const sentenceEvents = []
  const scheduled = new Map()
  let nextTimerId = 1

  const controller = createArticleReaderController({
    synth,
    UtteranceCtor: MockUtterance,
    setTimeoutFn: (fn) => {
      const id = nextTimerId++
      scheduled.set(id, fn)
      return id
    },
    clearTimeoutFn: (id) => {
      scheduled.delete(id)
    },
    onSentenceChange: idx => sentenceEvents.push(idx),
    onAdvancePage: idx => advancedPages.push(idx),
  })

  controller.start({
    pages: [
      { text: 'First sentence on page one. Second sentence on page one.' },
      { text: 'Page two body text.' },
    ],
    startPage: 0,
    readingLevel: 'B1-B2',
  })

  await new Promise(resolve => setTimeout(resolve, 10))
  assert.equal(controller.isPlaying(), true)
  assert.equal(controller.getSentenceIndex(), 0, 'Sentence 0 should be active immediately on Page 1')

  // Advance to sentence 1
  finishCurrent()
  await new Promise(resolve => setTimeout(resolve, 10))
  assert.equal(controller.getSentenceIndex(), 1, 'Sentence 1 should be active after sentence 0 finishes')

  // Stop mid-sentence (simulating stop button, manual page turn, or CEFR level switch)
  controller.stop()
  assert.equal(controller.isPlaying(), false)
  assert.equal(controller.getSentenceIndex(), null, 'activeSentenceIndex must reset to null immediately on stop')
  assert.deepEqual(sentenceEvents, [0, 1, null])
  assert.ok(getCancelCount() >= 2)
  assert.deepEqual(advancedPages, [], 'No ghost page turn may fire after stop')

  // Also verify stopping during the 550ms page-turn pause clears timer & keeps sentenceIndex null
  controller.start({
    pages: [
      { text: 'Only sentence on page one.' },
      { text: 'Page two body text.' },
    ],
    startPage: 0,
    readingLevel: 'B1-B2',
  })
  await new Promise(resolve => setTimeout(resolve, 10))
  assert.equal(controller.getSentenceIndex(), 0)
  finishCurrent()
  await new Promise(resolve => setTimeout(resolve, 10))
  assert.equal(scheduled.size, 1, 'Pending 550ms page-turn timer should be scheduled')
  assert.equal(controller.getSentenceIndex(), null, 'Highlight clears before page turn')

  controller.stop()
  assert.equal(scheduled.size, 0, 'Pending timer must be cleared immediately on stop')
  assert.equal(controller.getSentenceIndex(), null)
  assert.deepEqual(advancedPages, [], 'No ghost page turn after cancelling during pause')
})

test('page.audioUrl plays via HTMLAudioElement first and falls back seamlessly to TTS on error', async () => {
  const { synth, spoken } = createMockSynth([{ name: 'Google US English', lang: 'en-US' }])
  const playedUrls = []
  const advancedPages = []

  const controller = createArticleReaderController({
    synth,
    UtteranceCtor: MockUtterance,
    createAudio: (url) => {
      playedUrls.push(url)
      const audio = {
        onended: null,
        onerror: null,
        pause: () => {},
        play: () => {
          queueMicrotask(() => {
            if (url.includes('broken')) audio.onerror?.()
            else audio.onended?.()
          })
          return Promise.resolve()
        },
      }
      return audio
    },
    setTimeoutFn: (fn) => setTimeout(fn, 1),
    clearTimeoutFn: id => clearTimeout(id),
    onAdvancePage: idx => advancedPages.push(idx),
  })

  controller.start({
    pages: [
      { text: 'Should be spoken by MP3.', audioUrl: 'https://cdn.example.com/p1.mp3' },
      { text: 'Fallback TTS reads this page.', audioUrl: 'https://cdn.example.com/broken.mp3' },
    ],
    startPage: 0,
    readingLevel: 'C1-C2',
  })

  await new Promise(resolve => setTimeout(resolve, 60))

  assert.deepEqual(playedUrls, ['https://cdn.example.com/p1.mp3', 'https://cdn.example.com/broken.mp3'])
  assert.deepEqual(spoken.map(s => s.text), ['Fallback TTS reads this page.'])
  assert.equal(spoken[0].rate, 1.0)
  assert.deepEqual(advancedPages, [1])
  assert.equal(controller.isPlaying(), false)
  assert.equal(controller.getSentenceIndex(), null)
})

test('playWordPronunciation stops active article narration, clears activeSentenceIndex, and prefers Wikimedia audio with TTS fallback', async () => {
  clearWordAudioCache()
  const { synth, spoken } = createMockSynth([{ name: 'Samantha (Enhanced)', lang: 'en-US' }])
  const playedUrls = []

  const controller = createArticleReaderController({
    synth,
    UtteranceCtor: MockUtterance,
    fetchImpl: async (url) => {
      if (url.includes('bastion')) {
        return {
          ok: true,
          json: async () => ({
            query: {
              pages: {
                1: {
                  title: 'File:En-us-bastion.ogg',
                  imageinfo: [{ url: 'https://upload.wikimedia.org/wikipedia/commons/En-us-bastion.ogg', mime: 'audio/ogg' }],
                },
              },
            },
          }),
        }
      }
      return { ok: true, json: async () => ({ query: { pages: {} } }) }
    },
    createAudio: (url) => {
      playedUrls.push(url)
      const audio = {
        onended: null,
        onerror: null,
        pause: () => {},
        play: () => {
          queueMicrotask(() => audio.onended?.())
          return Promise.resolve()
        },
      }
      return audio
    },
  })

  controller.start({
    pages: [{ text: 'First page.' }, { text: 'Second page.' }],
    startPage: 0,
  })
  const playedHuman = await controller.playWordPronunciation('bastion')
  assert.equal(playedHuman, true)
  assert.equal(controller.isPlaying(), false, 'Article narration must stop when word pronunciation plays')
  assert.equal(controller.getSentenceIndex(), null, 'Sentence highlight must clear when dictionary speaks')
  assert.deepEqual(playedUrls, ['https://upload.wikimedia.org/wikipedia/commons/En-us-bastion.ogg'])

  // Missing Wikimedia file falls back immediately to Neural/Enhanced TTS at rate 0.92
  spoken.length = 0
  const playedFallback = await controller.playWordPronunciation('unrecordedword')
  assert.equal(playedFallback, true)
  assert.equal(spoken.length, 1)
  assert.equal(spoken[0].text, 'unrecordedword')
  assert.equal(spoken[0].rate, 0.92)
  assert.equal(spoken[0].voice, 'Samantha (Enhanced)')
})
