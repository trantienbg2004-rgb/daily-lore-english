import { useEffect, useRef, useState } from 'react'
import './App.css'
import initialStories from './stories.json'


// Stable IDs let this device remember read stories across new deployments.
const storyId = item => item.sourceUrl || item.sourceTitle || `${item.category}:${item.title}`
const readHistory = () => {
  try { const value = JSON.parse(localStorage.getItem('dailyLoreSeenV1') || '[]'); return new Set(Array.isArray(value) ? value : []) }
  catch { return new Set() }
}
const validStories = data => Array.isArray(data) && data.every(item => item && typeof item.title === 'string' && Array.isArray(item.pages) && item.pages.length > 0 && item.pages.every(p => typeof p.text === 'string' && typeof p.image === 'string'))

// Keep the original text. Pagination below uses the actual rendered reading area.
const paginateStory = item => ({ ...item, _sourcePages: item._sourcePages || item.pages })

// Source paragraphs remain intact in storage. Layout is calculated on the device.
const sentenceUnits = pages => {
  const segmenter = new Intl.Segmenter('en', { granularity: 'sentence' })
  return pages.flatMap((source, sourceIndex) => [...segmenter.segment(source.text)].map(part => ({
    text: part.segment.trim(), sourceIndex, image: source.image, caption: source.caption,
  })).filter(part => part.text))
}

// Measure the same font and width as the actual reading pane. No internal scrolling.
const layoutPages = (item, reader) => {
  const originals = item._sourcePages || item.pages
  const units = sentenceUnits(originals)
  if (!units.length) return originals
  const textEl = reader.querySelector('.article-text')
  const card = reader.querySelector('.reading-card')
  const top = reader.querySelector('.reading-topline')
  const heading = reader.querySelector('.article-heading')
  const bar = reader.querySelector('.topbar')
  const dots = reader.querySelector('.page-control')
  const media = reader.querySelector('.article-media')
  if (!textEl || !card || !top || !heading || !bar || !dots || !media) return item.pages
  const css = getComputedStyle(textEl)
  const probe = document.createElement('p')
  probe.className = 'article-text'
  Object.assign(probe.style, {
    position:'fixed', left:'-9999px', top:'0', visibility:'hidden', pointerEvents:'none',
    width:`${textEl.getBoundingClientRect().width}px`, height:'auto', maxHeight:'none',
    minHeight:'0', overflow:'visible', margin:'0', padding:'0',
    font:css.font, lineHeight:css.lineHeight, letterSpacing:css.letterSpacing,
    overflowWrap:css.overflowWrap,
  })
  document.body.appendChild(probe)
  const available = reader.clientHeight - bar.offsetHeight - heading.offsetHeight - dots.offsetHeight
    - top.offsetHeight - parseFloat(css.marginTop || 0) - parseFloat(css.marginBottom || 0) - 28
  // A page containing a photograph has less room for text.
  const imageHeight = Math.max(media.offsetHeight, Math.min(160, Math.max(85, reader.clientHeight * 0.19)) + 19)
  const withImage = Math.max(45, available - imageHeight - 10)
  const withoutImage = Math.max(45, available)
  const measure = list => { probe.textContent = list.map(x => x.text).join(' '); return probe.getBoundingClientRect().height }
  const pages = []
  let pending = []
  let pendingSource = 0
  const flush = () => {
    if (!pending.length) return
    const source = originals[pendingSource]
    const showImage = pendingSource === 0 || (source.image && source.image !== originals[0].image)
    pages.push({ image:showImage ? source.image : '', caption:showImage ? source.caption : '', text:pending.map(x=>x.text).join(' ') })
    pending = []
  }
  for (const unit of units) {
    if (pending.length && unit.sourceIndex !== pendingSource) flush()
    if (!pending.length) pendingSource = unit.sourceIndex
    const source = originals[pendingSource]
    const image = pendingSource === 0 || (source.image && source.image !== originals[0].image)
    // Show each source image once, at its first resulting page.
    const firstInSource = !pages.some(p => p.image && p.image === source.image)
    const limit = image && firstInSource ? withImage : withoutImage
    if (pending.length && measure([...pending,unit]) > limit) {
      flush()
      pendingSource = unit.sourceIndex
    }
    pending.push(unit)
  }
  flush()
  // Ensure an image is shown only on the first page of its source section.
  const used = new Set()
  for (const page of pages) {
    if (page.image && used.has(page.image)) { page.image = ''; page.caption = '' }
    if (page.image) used.add(page.image)
  }
  probe.remove()
  return pages
}

const dictionary = {
  coincidence: 'Two events happening together by chance.', rotates: 'Turns around a central point or axis.',
  gravity: 'The force that attracts objects towards each other.', gradually: 'Slowly, over a period of time.',
  synchronized: 'Happening or moving at the same time or speed.', remarkable: 'Unusual or surprising in a way that deserves attention.',
  misleading: 'Giving someone the wrong idea or impression.', celestial: 'Related to the sky or outer space.',
  neighbour: 'Someone or something that is nearby.', secrets: 'Things that are not yet known or understood.',
  exploring: 'Trying to discover more about something.', memories: 'Things you remember from the past.',
  emotions: 'Feelings such as happiness, fear, or sadness.', recall: 'To remember something.',
  surroundings: 'The things and conditions around a person or place.', fungi: 'Living organisms such as mushrooms and moulds.',
  nutrients: 'Substances that living things need to grow and stay healthy.', underground: 'Below the surface of the ground.',
  ecosystems: 'Communities of living things interacting with their environment.',
}

// Offline definitions for common words in the included stories.
// They remain available when a network dictionary cannot be reached.
const offlineDictionary = {
  ...dictionary,
  noticed: 'Saw, observed, or became aware of something.',
  notice: 'To see or become aware of something.',
  earth: 'The planet on which we live.',
  moon: 'The natural object that moves around Earth and is visible in the sky.',
  seems: 'Appears to be true or to have a particular quality.',
  face: 'The visible front or surface of something.',
  night: 'The part of each day when it is dark.',
  travels: 'Moves from one place to another.',
  rate: 'The speed at which something happens.',
  axis: 'An imaginary line around which something turns.',
  rotates: 'Turns around a central point or axis.',
  coincidence: 'Two events happening together by chance.',
  synchronized: 'Happening or moving at the same time or speed.',
  remarkable: 'Unusual or surprising in a way that deserves attention.',
  gravity: 'The force that attracts objects towards each other.',
  gradually: 'Slowly, over a period of time.',
  billions: 'Groups of one thousand million.',
  slowed: 'Made something move or happen less quickly.',
  pattern: 'A regular or repeated way in which something happens.',
  misleading: 'Giving someone the wrong idea or impression.',
  phrase: 'A group of words that has a particular meaning.',
  receives: 'Gets something that is given, sent, or provided.',
  sunlight: 'Light that comes from the Sun.',
  discoveries: 'Things found or learned for the first time.',
  scientists: 'People who study the natural world through research.',
  missions: 'Important tasks or journeys carried out for a purpose.',
  surface: 'The outside or top layer of something.',
  dreams: 'Images, thoughts, and feelings experienced during sleep.',
  dream: 'A series of images or experiences in the mind during sleep.',
  sleep: 'A natural state of rest in which you are not conscious.',
  surprisingly: 'In a way that is unexpected.',
  disappear: 'To stop being visible or present.',
  memories: 'Things you remember from the past.',
  emotions: 'Feelings such as happiness, fear, or sadness.',
  experiences: 'Events that happen to someone and affect them.',
  recall: 'To remember something.',
  notebook: 'A book of blank pages used for writing notes.',
  forest: 'A large area of land covered mainly with trees.',
  trees: 'Tall plants with a wooden trunk and branches.',
  roots: 'Parts of a plant that grow underground and absorb water.',
  fungi: 'Organisms such as mushrooms and moulds.',
  nutrients: 'Substances that living things need to grow and stay healthy.',
  chemical: 'Related to substances and the way they react.',
  signals: 'Actions or signs used to communicate information.',
  underground: 'Below the surface of the ground.',
  resources: 'Useful materials or supplies.',
  networks: 'Systems of connected people or things.',
  ecosystems: 'Communities of living things interacting with their environment.',
  surroundings: 'The things and conditions around a person or place.',
}

const wordCandidates = word => {
  const candidates = [word]
  if (word.endsWith('ied') && word.length > 4) candidates.push(word.slice(0, -3) + 'y')
  if (word.endsWith('ed') && word.length > 3) candidates.push(word.slice(0, -1), word.slice(0, -2))
  if (word.endsWith('ies') && word.length > 4) candidates.push(word.slice(0, -3) + 'y')
  if (word.endsWith('ing') && word.length > 5) candidates.push(word.slice(0, -3), word.slice(0, -3) + 'e')
  if (word.endsWith('s') && word.length > 3) candidates.push(word.slice(0, -1))
  return [...new Set(candidates)]
}

const offlineMeaning = word => {
  for (const candidate of wordCandidates(word)) {
    if (offlineDictionary[candidate]) return offlineDictionary[candidate]
  }
  return ''
}

// Datamuse is the primary service (confirmed accessible in the user's browser).
// Free Dictionary is a secondary fallback, never a blocking prerequisite.
const dictionaryCache = new Map()
const fetchJSON = async (url, signal, timeoutMs = 4500) => {
  const controller = new AbortController()
  const abort = () => controller.abort()
  signal?.addEventListener('abort', abort, { once: true })
  const timer = setTimeout(abort, timeoutMs)
  try {
    if (signal?.aborted) throw new DOMException('Cancelled', 'AbortError')
    const response = await fetch(url, { signal: controller.signal, headers: { Accept: 'application/json' } })
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    return await response.json()
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener('abort', abort)
  }
}
const parseDatamuse = (data, candidate) => {
  if (!Array.isArray(data)) return []
  const exact = data.find(item => item.word?.toLowerCase() === candidate && item.defs?.length)
  if (!exact) return []
  const labels = { n: 'noun', v: 'verb', adj: 'adjective', adv: 'adverb', det: 'determiner', prep: 'preposition', pron: 'pronoun', conj: 'conjunction', interj: 'interjection' }
  return exact.defs.map(raw => {
    const separator = raw.indexOf('\t')
    const tag = separator < 0 ? '' : raw.slice(0, separator)
    return { definition: (separator < 0 ? raw : raw.slice(separator + 1)).trim(), partOfSpeech: labels[tag] || tag, phonetic: '', source: 'Datamuse' }
  }).filter(item => item.definition).slice(0, 5)
}
const lookupWord = async (word, signal) => {
  if (dictionaryCache.has(word)) return dictionaryCache.get(word)
  const candidates = wordCandidates(word)
  for (const candidate of candidates) {
    if (signal.aborted) throw new DOMException('Cancelled', 'AbortError')
    try {
      const data = await fetchJSON(`https://api.datamuse.com/words?sp=${encodeURIComponent(candidate)}&md=d&max=10`, signal, 3500)
      const options = parseDatamuse(data, candidate)
      if (options.length) {
        const result = { options, source: 'Datamuse' }
        dictionaryCache.set(word, result)
        return result
      }
    } catch (error) { if (signal.aborted) throw error }
  }
  for (const candidate of candidates.slice(0, 2)) {
    if (signal.aborted) throw new DOMException('Cancelled', 'AbortError')
    try {
      const entries = await fetchJSON(`https://api.dictionaryapi.dev/api/v2/entries/en/${encodeURIComponent(candidate)}`, signal, 2200)
      const entry = entries?.[0]
      const options = (entry?.meanings || []).flatMap(item => (item.definitions || []).slice(0, 2).map(d => ({
        definition: d.definition, partOfSpeech: item.partOfSpeech || '',
        phonetic: entry.phonetic || entry.phonetics?.find(p => p.text)?.text || '', source: 'Free Dictionary'
      }))).filter(item => item.definition).slice(0, 5)
      if (options.length) {
        const result = { options, source: 'Free Dictionary' }
        dictionaryCache.set(word, result)
        return result
      }
    } catch (error) { if (signal.aborted) throw error }
  }
  throw new Error('No definition available')
}

const initialWords = () => {
  try {
    const saved = JSON.parse(localStorage.getItem('dailyLoreWords') || '[]')
    return Array.isArray(saved) ? saved.map(item => ({ ...item, definition: item.definition && !/^(Definition not available|Look up this word|Definition unavailable)/i.test(item.definition) ? (item.sentence && item.definition.trim() === item.sentence.trim() ? offlineMeaning(item.word) : item.definition) : offlineMeaning(item.word) })) : []
  } catch { return [] }
}

function Icon({ name, size = 24 }) {
  const paths = {
    book: <><path d="M12 6.5C9.5 4.6 6.5 4.2 3 5v14c3.5-.8 6.5-.4 9 1.5 2.5-1.9 5.5-2.3 9-1.5V5c-3.5-.8-6.5-.4-9 1.5Z"/><path d="M12 6.5v14"/></>,
    bookmark: <path d="M6 3.5h12v17l-6-4-6 4v-17Z"/>,
    layers: <><rect x="4" y="5" width="16" height="14" rx="2"/><path d="M8 9h8M8 13h5"/></>,
    left: <path d="m14 5-7 7 7 7"/>, right: <path d="m10 5 7 7-7 7"/>,
    close: <path d="M5 5l14 14M19 5 5 19"/>, check: <path d="m5 12 4 4L19 6"/>,
    volume: <><path d="M4 9v6h4l5 4V5L8 9H4Z"/><path d="M17 9a5 5 0 0 1 0 6"/></>,
    up: <path d="m5 14 7-7 7 7"/>, down: <path d="m5 10 7 7 7-7"/>,
  }
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{paths[name]}</svg>
}

function App() {
  const [tab, setTab] = useState('read')
  const [storyIndex, setStoryIndex] = useState(0)
  const [stories, setStories] = useState([])
  const [feedCursor, setFeedCursor] = useState(0)
  const [feedDone, setFeedDone] = useState(false)
  const [feedLoading, setFeedLoading] = useState(true)
  const feedBusy = useRef(false)
  const seenRef = useRef(readHistory())
  const loadedRef = useRef(new Set())
  const [page, setPage] = useState(0)
  const [selected, setSelected] = useState('')
  const [lookup, setLookup] = useState({ status: 'idle', options: [] })
  const [meaningIndex, setMeaningIndex] = useState(0)
  const [retryCount, setRetryCount] = useState(0)
  const [words, setWords] = useState(initialWords)
  const [reviewIndex, setReviewIndex] = useState(0)
  const [revealed, setRevealed] = useState(false)
  const [finished, setFinished] = useState(false)
  const gesture = useRef(null)
  const suppressWordClick = useRef(false)
  const wheelLock = useRef(0)
  const wheelAccum = useRef(0)
  const [slide, setSlide] = useState(null)
  const slideTimer = useRef(null)
  const story = stories[storyIndex] || null
  const currentPage = story?.pages?.[page] || null

  // Recalculate when the actual screen dimensions change. No cut sentences or empty pages.
  useEffect(() => {
    if (tab !== 'read' || !story) return
    let frame = 0
    let observer
    const recalculate = () => {
      cancelAnimationFrame(frame)
      frame = requestAnimationFrame(() => {
        const reader = document.querySelector('.story-layer:not(.outgoing) .reader-gesture')
        if (!reader) return
        const next = layoutPages(story, reader)
        const before = story.pages.map(p => `${p.image}|${p.text}`).join('\u0000')
        const after = next.map(p => `${p.image}|${p.text}`).join('\u0000')
        if (before !== after) {
          setStories(old => old.map((item, i) => i === storyIndex ? { ...item, pages: next } : item))
          setPage(p => Math.min(p, next.length - 1))
        }
      })
    }
    recalculate()
    const viewport = document.querySelector('.story-viewport')
    if (viewport && typeof ResizeObserver !== 'undefined') {
      observer = new ResizeObserver(recalculate)
      observer.observe(viewport)
    }
    window.addEventListener('resize', recalculate)
    return () => { cancelAnimationFrame(frame); observer?.disconnect(); window.removeEventListener('resize', recalculate) }
  }, [tab, storyIndex, stories.length, story?._sourcePages])


  // Read paginated static feed, skipping previously read IDs on this device.
  // A finite feed ends explicitly: it never replays seen stories as if new.
  const loadFeed = async (cursor = 0) => {
    if (feedBusy.current) return
    feedBusy.current = true
    setFeedLoading(true)
    try {
      const manifestResponse = await fetch(`${import.meta.env.BASE_URL}feed/manifest.json?t=${Date.now()}`, { cache: 'no-store' })
      if (!manifestResponse.ok) throw new Error('Feed not published yet')
      const manifest = await manifestResponse.json()
      const count = Number(manifest.chunks) || 0
      const added = []
      let next = cursor
      // Read at most 8 chunks per request, or stop once 8 unseen stories are available.
      while (next < count && next < cursor + 8 && added.length < 8) {
        const response = await fetch(`${import.meta.env.BASE_URL}feed/${String(next).padStart(4, '0')}.json?v=${encodeURIComponent(manifest.updatedAt || Date.now())}`, { cache: 'no-store' })
        if (!response.ok) throw new Error(`Feed chunk ${next} unavailable`)
        const batch = await response.json()
        if (!validStories(batch)) throw new Error('Invalid feed data')
        for (const item of batch) {
          const id = storyId(item)
          if (!seenRef.current.has(id) && !loadedRef.current.has(id)) {
            loadedRef.current.add(id)
            added.push(item)
          }
        }
        next++
      }
      if (added.length) setStories(old => [...old, ...added.map(paginateStory)])
      setFeedCursor(next)
      setFeedDone(next >= count)
    } catch (error) {
      console.warn('Feed unavailable:', error.message)
      // First-time migration fallback, not an infinite loop.
      if (cursor === 0 && loadedRef.current.size === 0) {
        try {
          const response = await fetch(`${import.meta.env.BASE_URL}stories.json`, { cache: 'no-store' })
          const data = await response.json()
          if (validStories(data)) {
            const unseen = data.filter(item => !seenRef.current.has(storyId(item)))
            unseen.forEach(item => loadedRef.current.add(storyId(item)))
            setStories(unseen.map(paginateStory))
          }
        } catch { /* Display retry below */ }
      }
    } finally {
      feedBusy.current = false
      setFeedLoading(false)
    }
  }

  // A manual refresh must rescan from chunk zero: existing chunks can be republished.
  const refreshFeed = () => loadFeed(0)

  useEffect(() => { loadFeed(0) }, [])
  useEffect(() => {
    if (!story) return
    const id = storyId(story)
    if (seenRef.current.has(id)) return
    seenRef.current.add(id)
    try { localStorage.setItem('dailyLoreSeenV1', JSON.stringify([...seenRef.current])) }
    catch (error) { console.warn('Reading history could not be saved:', error) }
  }, [storyIndex, story])
  useEffect(() => {
    if (stories.length && stories.length - storyIndex <= 4 && !feedDone && !feedLoading) loadFeed(feedCursor)
  }, [storyIndex, stories.length, feedCursor, feedDone, feedLoading])

  useEffect(() => {
    try { localStorage.setItem('dailyLoreWords', JSON.stringify(words)) }
    catch (error) { console.warn('Saved words could not be stored on this device:', error) }
  }, [words])
  useEffect(() => { setWords(current => current.map(item => !item.definition && offlineMeaning(item.word) ? { ...item, definition: offlineMeaning(item.word) } : item)) }, [])
  const clean = value => value.toLowerCase().replace(/^[^a-z]+|[^a-z]+$/g, '')
  const selectedSaved = words.find(w => w.word === selected)
  const isSaved = Boolean(selectedSaved)
  const activeMeaning = lookup.options?.[meaningIndex] || null
  // Avoid lookbehind regex: Safari on iOS 15 cannot parse it and may show a blank screen.
  const sentenceParts = (currentPage?.text || '').match(/[^.!?]+[.!?]*|[^.!?]+$/g) || [currentPage?.text || '']
  const selectedSentence = selectedSaved?.sentence || sentenceParts.find(sentence =>
    sentence.toLowerCase().split(/[^a-z]+/).includes(selected)
  )?.trim() || currentPage?.text || ''

  useEffect(() => {
    if (!selected) return
    const controller = new AbortController()
    let active = true
    setMeaningIndex(0)
    setLookup({ status: 'loading', options: [] })
    const timeout = setTimeout(() => {
      controller.abort()
      if (active) setLookup({ status: 'error', options: [] })
    }, 11000)
    lookupWord(selected, controller.signal)
      .then(result => { if (active && !controller.signal.aborted) setLookup({ status: 'success', ...result }) })
      .catch(() => { if (active && !controller.signal.aborted) setLookup({ status: 'error', options: [] }) })
      .finally(() => clearTimeout(timeout))
    return () => { active = false; clearTimeout(timeout); controller.abort() }
  }, [selected, retryCount])

  const saveWord = () => {
    if (!selected || isSaved) return
    const meaning = activeMeaning
    const item = {
      word: selected,
      definition: meaning?.definition || offlineMeaning(selected) || '',
      phonetic: meaning?.phonetic || '',
      partOfSpeech: meaning?.partOfSpeech || '',
      sentence: selectedSentence,
      added: Date.now(),
    }
    setWords(current => current.some(w => w.word === selected) ? current : [...current, item])
  }

  // A user's chosen meaning must never be overwritten by later API responses.
  // Only fill a previously blank definition, preserving existing vocabulary.
  useEffect(() => {
    if (!selected || lookup.status !== 'success' || !lookup.options?.length) return
    setWords(current => {
      if (!current.some(item => item.word === selected && !item.definition)) return current
      return current.map(item => item.word === selected && !item.definition
        ? { ...item, definition: lookup.options[0].definition, phonetic: lookup.options[0].phonetic, partOfSpeech: lookup.options[0].partOfSpeech }
        : item)
    })
  }, [selected, lookup])

  const speak = value => {
    if (!('speechSynthesis' in window)) return
    window.speechSynthesis.cancel()
    const utterance = new SpeechSynthesisUtterance(value)
    utterance.lang = 'en-US'
    utterance.rate = 0.85
    window.speechSynthesis.speak(utterance)
  }
  const changePage = direction => { if (story) setPage(p => Math.max(0, Math.min(story.pages.length - 1, p + direction))) }
  const changeStory = direction => {
    const next = storyIndex + direction
    if (next < 0 || next >= stories.length) return
    clearTimeout(slideTimer.current)
    setSlide({ from: storyIndex, fromPage: page, direction, stamp: Date.now() })
    setStoryIndex(next)
    setPage(0)
    slideTimer.current = setTimeout(() => setSlide(null), 560)
  }
  const nextReview = () => {
    if (reviewIndex + 1 >= words.length) setFinished(true)
    else { setReviewIndex(i => i + 1); setRevealed(false) }
  }
  // Treat word buttons as part of the reading surface, not as navigation controls.
  // This makes swiping across the paragraph work on touch screens.
  const startGesture = event => {
    if (event.touches.length !== 1 || selected) { gesture.current = null; return }
    const control = event.target.closest('button')
    if (control && !control.classList.contains('word-token')) { gesture.current = null; return }
    suppressWordClick.current = false
    gesture.current = { x: event.touches[0].clientX, y: event.touches[0].clientY, moved: false }
  }
  const moveGesture = event => {
    if (!gesture.current || event.touches.length !== 1) return
    const dx = event.touches[0].clientX - gesture.current.x
    const dy = event.touches[0].clientY - gesture.current.y
    if (Math.max(Math.abs(dx), Math.abs(dy)) > 12) {
      gesture.current.moved = true
      suppressWordClick.current = true
    }
  }
  const endGesture = event => {
    if (!gesture.current || selected) return
    const dx = event.changedTouches[0].clientX - gesture.current.x
    const dy = event.changedTouches[0].clientY - gesture.current.y
    gesture.current = null
    if (Math.max(Math.abs(dx), Math.abs(dy)) < 48) return
    if (Math.abs(dx) > Math.abs(dy) * 1.15) changePage(dx < 0 ? 1 : -1)
    else if (Math.abs(dy) > Math.abs(dx) * 1.15) changeStory(dy < 0 ? 1 : -1)
  }
  const cancelGesture = () => { gesture.current = null; suppressWordClick.current = false }
  const onWordClick = (event, word) => {
    if (suppressWordClick.current) {
      event.preventDefault()
      suppressWordClick.current = false
      return
    }
    setSelected(word)
  }
  // Warm up just the next page and the next article, without downloading the whole library.
  useEffect(() => {
    if (tab !== 'read' || !story) return
    const urls = [story?.pages?.[page + 1]?.image, stories[storyIndex + 1]?.pages?.[0]?.image]
    const images = urls.filter(Boolean).map(url => {
      const img = new Image()
      img.src = url
      return img
    })
    return () => { images.forEach(img => { img.onload = null; img.onerror = null }) }
  }, [tab, storyIndex, page, stories])
  useEffect(() => {
    if (tab !== 'read' || selected) return
    const onKey = event => {
      if (event.key === 'ArrowRight') { event.preventDefault(); changePage(1) }
      if (event.key === 'ArrowLeft') { event.preventDefault(); changePage(-1) }
      if (event.key === 'ArrowDown') { event.preventDefault(); changeStory(1) }
      if (event.key === 'ArrowUp') { event.preventDefault(); changeStory(-1) }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [tab, selected, storyIndex, story?.pages?.length])

  // Desktop: wheel navigates stories instead of scrolling the reading screen.
  const onReaderWheel = event => {
    if (selected || event.ctrlKey) return
    event.preventDefault()
    const now = Date.now()
    if (now < wheelLock.current) return
    if (wheelAccum.current && Math.sign(wheelAccum.current) !== Math.sign(event.deltaY)) wheelAccum.current = 0
    wheelAccum.current += event.deltaY
    if (Math.abs(wheelAccum.current) < 65) return
    const direction = wheelAccum.current > 0 ? 1 : -1
    wheelAccum.current = 0
    wheelLock.current = now + 650
    changeStory(direction)
  }

  // Each story has its own vertical screen; horizontal pages are independent.
  const renderStory = (item, index, pageNumber, interactive) => {
    const itemPage = item.pages[pageNumber] || item.pages[0]
    const tokens = itemPage.text.split(/(\s+)/)
    return <div className="reader-gesture" aria-hidden={!interactive} onTouchStart={interactive ? startGesture : undefined} onTouchMove={interactive ? moveGesture : undefined} onTouchEnd={interactive ? endGesture : undefined} onTouchCancel={interactive ? cancelGesture : undefined}>
      <header className="topbar"><span className="brand">DAILY NEWS</span></header>
      <div className="article-heading"><div className="eyebrow">{item.category}</div><h1>{item.title}</h1><p className="deck">{item.subtitle}</p></div>
      <div className={"article-media " + (!itemPage.image ? "article-media-empty" : "")}><img src={itemPage.image || undefined} alt={itemPage.caption} decoding="async" loading={interactive ? "eager" : "lazy"} onError={e => { e.currentTarget.style.opacity = '.35' }}/><div className="photo-caption">{itemPage.caption}</div></div>
      <section className="reading-card"><div className="reading-topline"><span>THE SHORT STORY · {pageNumber + 1}/{item.pages.length}</span><button className="icon-button" disabled={!interactive} onClick={() => speak(itemPage.text)} aria-label="Read aloud"><Icon name="volume" size={21}/></button></div>
        <p className="article-text">{tokens.map((token, i) => { const word = clean(token); return /^\s+$/.test(token) || !word ? token : <button key={i} type="button" disabled={!interactive} className={'word-token ' + (words.some(w => w.word === word) ? 'known' : '')} onClick={event => onWordClick(event, word)}>{token}</button> })}</p>
      </section>
      <div className="page-control" aria-label={`Page ${pageNumber + 1} of ${item.pages.length}`}><div className="dots" aria-hidden="true">{item.pages.map((_, i) => <span key={i} className={pageNumber === i ? 'active' : ''}/>)}</div></div>
    </div>
  }
  return (
    <div className={"app-shell " + (tab === "read" ? "reading-mode" : "")}>
      <main className="app-content">
        {tab === 'read' && <div className="story-viewport" onWheel={onReaderWheel}>
          {slide && stories[slide.from] && <div key={'old-'+slide.stamp} className={'story-layer outgoing '+(slide.direction>0?'slide-up':'slide-down')}>{renderStory(stories[slide.from], slide.from, slide.fromPage, false)}</div>}
          {story && <div key={'active-'+storyIndex} className={'story-layer '+(slide?(slide.direction>0?'enter-from-bottom':'enter-from-top'):'')}>{renderStory(story, storyIndex, page, true)}</div>}
          {story && storyIndex === stories.length - 1 && !feedLoading && <div className="feed-end-indicator">{feedDone ? 'All stories read · New articles coming soon' : 'Loading next stories…'} <button onClick={refreshFeed} disabled={feedLoading}>Refresh</button></div>}
          {!story && <div className="feed-empty"><h2>{feedLoading ? 'Finding your next story…' : feedDone ? 'You’re all caught up.' : 'Stories are temporarily unavailable.'}</h2><p>{feedDone ? 'You have read every available story on this device. New stories will appear when published.' : 'Check your connection or try again.'}</p><button className="primary" onClick={refreshFeed} disabled={feedLoading}>{feedLoading ? 'Loading…' : 'Check for new stories'}</button></div>}
        </div>}
        {tab === 'words' && <><header className="section-header"><span className="eyebrow">YOUR PERSONAL COLLECTION</span><h1>Saved words<span className="period">.</span></h1><p>Small discoveries, remembered.</p></header><div className="count-line">{words.length} {words.length === 1 ? 'WORD' : 'WORDS'} COLLECTED</div>{words.length === 0 ? <div className="empty"><Icon name="bookmark" size={40}/><h2>Your collection begins here.</h2><p>Read a story, tap a word, and save it to keep learning.</p><button className="primary" onClick={() => setTab('read')}>Start reading →</button></div> : <div className="saved-list">{words.map(item => <div className="saved-item" key={item.word}><div><h2><button className="saved-word-open" onClick={() => setSelected(item.word)}>{item.word}</button></h2>{item.partOfSpeech && <span className="word-meta">{item.partOfSpeech}</span>}{item.phonetic && <span className="word-meta">{item.phonetic}</span>}<p>{item.definition || offlineMeaning(item.word) || 'No definition yet. See the example sentence below.'}</p>{item.sentence && <p className="word-context">“{item.sentence}”</p>}</div><button onClick={() => { setWords(current => current.filter(w => w.word !== item.word)); setReviewIndex(0); setFinished(false) }} aria-label={`Remove ${item.word}`}><Icon name="close" size={19}/></button></div>)}</div>}</>}
        {tab === 'review' && <><header className="section-header"><span className="eyebrow">A MOMENT TO REMEMBER</span><h1>Daily review<span className="period">.</span></h1><p>Learn a little. Remember a lot.</p></header>{words.length === 0 ? <div className="empty"><Icon name="layers" size={42}/><h2>Nothing to review yet.</h2><p>Save a few words while reading. They will appear here.</p><button className="primary" onClick={() => setTab('read')}>Explore a story →</button></div> : finished ? <div className="empty"><Icon name="check" size={44}/><h2>Beautiful work.</h2><p>You have reviewed all {words.length} saved words.</p><button className="primary" onClick={() => { setFinished(false); setReviewIndex(0); setRevealed(false) }}>Review again →</button></div> : <><div className="review-count">CARD {Math.min(reviewIndex + 1, words.length)} OF {words.length}</div><button className="flashcard" onClick={() => setRevealed(r => !r)}><span>{revealed ? 'THE MEANING' : 'DO YOU REMEMBER?'}</span><strong>{revealed ? (words[Math.min(reviewIndex, words.length - 1)].definition || offlineMeaning(words[Math.min(reviewIndex, words.length - 1)].word) || 'No definition yet. Open this word in Words to retry.') : words[Math.min(reviewIndex, words.length - 1)].word}</strong><small>{revealed ? 'Tap to see the word' : 'Tap to reveal meaning'}</small></button><button className="primary review-next" onClick={nextReview}>{reviewIndex + 1 >= words.length ? 'Finish review' : 'Next word'} →</button></>}</>}
      </main>
      <nav className="bottom-nav" aria-label="Main navigation">{[['read', 'book', 'Read'], ['words', 'bookmark', 'Words'], ['review', 'layers', 'Review']].map(([key, icon, label]) => <button key={key} className={tab === key ? 'current' : ''} onClick={() => { setTab(key); setSelected('') }}><Icon name={icon} size={25}/><span>{label}</span></button>)}</nav>
      {selected && <div className="overlay" onClick={() => setSelected('')}>
        <div className="definition-sheet" onClick={e => e.stopPropagation()}>
          <div className="sheet-header"><span>WORD NOTES</span><button onClick={() => setSelected('')} aria-label="Close"><Icon name="close" size={22}/></button></div>
          <h2>{selected}</h2>
          <div className="lookup-details">
            {lookup.status === 'loading' && <p>Looking up the word...</p>}
            {lookup.status === 'success' && <>
              <p className="meaning-label">CHOOSE A MEANING</p>
              <div className="meaning-options" role="radiogroup" aria-label="Choose a definition">
                {lookup.options.slice(0, 3).map((item, i) => <button type="button" key={i} role="radio" aria-checked={meaningIndex === i} className={'meaning-option ' + (meaningIndex === i ? 'chosen' : '')} onClick={() => setMeaningIndex(i)}>
                  <span className="meaning-radio" aria-hidden="true"/>
                  <span><small>{item.partOfSpeech || 'definition'} · {item.source}</small><span>{item.definition}</span></span>
                </button>)}
              </div>
            </>}
            {lookup.status === 'error' && <><p>{offlineMeaning(selected) || 'Dictionary unavailable. You can save this word and retry later.'}</p><button className="retry-link" onClick={() => setRetryCount(n => n + 1)}>Try again</button></>}
            {isSaved && <p className="saved-definition-note">Saved meaning: {selectedSaved.definition || 'Not available yet'}</p>}
          </div>
          <p className="word-context">“{selectedSentence}”</p>
          <div className="sheet-actions"><button className="outline" onClick={() => speak(selected)}><Icon name="volume" size={18}/> Listen</button><button className="primary" onClick={saveWord} disabled={isSaved}>{isSaved ? '✓ Saved' : '+ Save word'}</button></div>
        </div>
      </div>}
    </div>
  )
}

export default App
