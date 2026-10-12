import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import './App.css'
import { initializeSeenHistory, persistReadMarker, readLegacyHistory } from './lib/seenHistory.js'
import { storyId, readableStory, validStories, shuffle, chunkOrder, fetchManifest, scanFeed } from './lib/feedQueue.js'
import { createEdgeNavigation } from './lib/edgeNavigation.js'
import { photoLabel, photoSourceLink } from './lib/photoPresentation.js'
import { resolvePhoto, photoResult } from './lib/photoLoad.js'
import { displayHeadline, readerSection, orderEditorial } from './lib/editorial.js'
import initialStories from './stories.json'


// Store original articles untouched: the phone decides how many reading pages fit.
const paginateStory = item => ({ ...item, _sourcePages: item._sourcePages || item.pages })

// Photo frames use their true intrinsic aspect ratio. Fit within both the
// reader width and the viewport's responsive photo height, without cropping.
function fitPhoto(img) {
  if (!img?.naturalWidth || !img?.naturalHeight || !img.parentElement) return
  const maxHeight = parseFloat(getComputedStyle(img).maxHeight) || 148
  const maxWidth = Math.min(img.parentElement.clientWidth, img.parentElement.parentElement?.clientWidth || Infinity)
  const ratio = img.naturalWidth / img.naturalHeight
  if (!maxWidth || !Number.isFinite(ratio) || ratio <= 0) return
  const width = Math.min(maxWidth, maxHeight * ratio)
  img.style.width = `${width}px`
  img.style.height = `${width / ratio}px`
}

// V20: NEVER mount an <img> until pixels have loaded. A broken thumbnail
// cannot leave a native broken-image icon or steal reading space.
function ArticlePhoto({ image, label, onBroken, onReady }) {
  const [asset, setAsset] = useState(() => photoResult(image))
  useEffect(() => {
    let active = true
    const known = photoResult(image)
    setAsset(known)
    if (!image) return () => { active = false }
    if (known?.failed) { onBroken(image); return () => { active = false } }
    if (!known) resolvePhoto(image).then(result => {
      if (!active) return
      setAsset(result)
      if (!result?.url) onBroken(image)
      else onReady()
    })
    return () => { active = false }
  }, [image])
  if (!asset?.url) return null
  return <figure className="photo-figure">
    <img src={asset.url} alt={label} decoding="async" loading="eager"
      width={asset.width} height={asset.height}
      onLoad={event => fitPhoto(event.currentTarget)}
      onError={() => onBroken(image)} />
    {label && <figcaption className="photo-caption" title={label}>{label}</figcaption>}
  </figure>
}

function safeStoryUrl(url) {
  try {
    const parsed = new URL(url)
    return ['https:','http:'].includes(parsed.protocol) ? parsed.href : ''
  } catch { return '' }
}

// Actual DOM measurements preserve readable type and avoid cutting paragraphs on iPhone.
// The source article text is never discarded: long source pages become multiple screen pages.
function layoutPages(item, reader, badImages = new Set()) {
  const originals = item._sourcePages || item.pages
  const bounds = reader.getBoundingClientRect()
  if (bounds.width < 100 || bounds.height < 220) return item.pages

  // The actual reader layout is our measuring instrument. Unlike estimated
  // heights, this accounts for multiline photo credits, safe areas, fonts,
  // word buttons, the title and page dots on the CURRENT device.
  const fixture = reader.cloneNode(true)
  fixture.setAttribute('aria-hidden', 'true')
  fixture.classList.add('layout-measure-fixture')
  Object.assign(fixture.style, {
    position: 'fixed', left: '-20000px', top: '0',
    width: `${bounds.width}px`, height: `${bounds.height}px`,
    minHeight: '0', visibility: 'hidden', pointerEvents: 'none',
    zIndex: '-1', transform: 'none',
  })
  const heading = fixture.querySelector('.article-heading')
  const media = fixture.querySelector('.article-media')
  // The live reader deliberately has no image DOM until the bytes load.
  // Create measuring-only photo nodes in the invisible fixture.
  const figure = fixture.querySelector('.photo-figure') || document.createElement('figure')
  figure.className = 'photo-figure'
  const caption = fixture.querySelector('.photo-caption') || document.createElement('figcaption')
  caption.className = 'photo-caption'
  const photo = fixture.querySelector('.article-media img') || document.createElement('img')
  if (!figure.contains(photo)) figure.appendChild(photo)
  if (!figure.contains(caption)) figure.appendChild(caption)
  if (!media.contains(figure)) media.appendChild(figure)
  const card = fixture.querySelector('.reading-card')
  const paragraph = fixture.querySelector('.article-text')
  // Measure pages from a stable baseline. Only the final page reserves
  // the source footer; otherwise its existing DOM state double-counts.
  const existingFooter = fixture.querySelector('.source-footer')
  if (existingFooter) existingFooter.style.display = 'none'
  if (!heading || !media || !card || !paragraph) return item.pages

  const allWords = originals.flatMap(p => (p.text || '').match(/\S+/g) || [])
  const images = originals.filter(p => p.image && !badImages.has(p.image)).filter((p, i, list) =>
    list.findIndex(other => other.image === p.image) === i)
  if (!allWords.length) return originals

  // Measure real interactive word buttons, not plain text. Their inline box
  // metrics can differ from regular text (notably on iOS Safari).
  const measureWords = (offset, length) => {
    const content = document.createDocumentFragment()
    for (let i = offset; i < offset + length; i++) {
      if (i > offset) content.appendChild(document.createTextNode(' '))
      const token = allWords[i]
      if (!token.toLowerCase().replace(/^[^a-z]+|[^a-z]+$/g, '')) {
        content.appendChild(document.createTextNode(token))
      } else {
        const button = document.createElement('button')
        button.className = 'word-token'
        button.type = 'button'
        button.textContent = token
        content.appendChild(button)
      }
    }
    paragraph.replaceChildren(content)
    return paragraph.getBoundingClientRect().height
  }

  // Respect the available space inside the flex reading card, including
  // bottom navigation, pagination dots, paragraphs margins and photo captions.
  const configurePage = (isCover, image) => {
    heading.classList.toggle('article-heading-continued', !isCover)
    media.classList.toggle('article-media-empty', !image)
    media.style.display = image ? 'flex' : 'none'
    caption.textContent = photoLabel(image)
    // V19: reserve the maximum responsive image height when measuring. Actual
    // images may be shorter according to their aspect ratio, never taller.
    // This avoids cutting a word off even before the photo finishes loading.
    photo.style.height = getComputedStyle(photo).maxHeight
    photo.style.width = '100%'
    photo.removeAttribute('src')
    paragraph.textContent = ''
    const r = card.getBoundingClientRect()
    const p = paragraph.getBoundingClientRect()
    const marginBottom = parseFloat(getComputedStyle(paragraph).marginBottom) || 0
    // Conservative inset handles fractional Safari line rounding.
    return Math.max(0, r.bottom - p.top - marginBottom - 32)
  }

  reader.parentElement.appendChild(fixture)
  try {
    const result = []
    let offset = 0
    while (offset < allWords.length) {
      const first = result.length === 0
      // Preserve cover photo; occasional further photos from the source.
      const index = first ? 0 : (result.length % 4 === 0 ? Math.floor(result.length / 4) : -1)
      const image = images[index] || null
      const room = configurePage(first, image)
      let low = 1, high = allWords.length - offset, best = 0
      while (low <= high) {
        const mid = Math.floor((low + high) / 2)
        if (measureWords(offset, mid) <= room) {
          best = mid
          low = mid + 1
        } else high = mid - 1
      }
      // The last page has an original-article button and a credit link.
      // Reserve that measured footer space so it never covers vocabulary text.
      if (offset + best >= allWords.length && room > 96) {
        const safeRoom = Math.max(0, room - 82)
        while (best > 1 && measureWords(offset,best) > safeRoom) best--
      }
      // Exceptionally small windows cannot fit even a line: retain one token.
      // The regular mobile viewport styles are sized to avoid this case.
      best = Math.max(1, best)
      const remaining = allWords.length - offset
      // Avoid pages with a tiny last sentence when both halves fit.
      if (remaining > best && remaining - best < Math.min(35, Math.floor(best * 0.42))) {
        const balanced = Math.ceil(remaining / 2)
        if (balanced <= best) best = balanced
      }
      result.push({
        image: image?.image || '',
        caption: image?.caption || '',
        text: allWords.slice(offset, offset + best).join(' '),
      })
      offset += best
    }
    return result
  } finally {
    fixture.remove()
  }
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
  const [feedRetrying, setFeedRetrying] = useState(false)
  const [waitingForNext, setWaitingForNext] = useState(false)
  const edgeActionsRef = useRef(null)
  const edgeControllerRef = useRef(null)
  if (!edgeControllerRef.current) {
    edgeControllerRef.current = createEdgeNavigation({
      advance: direction => edgeActionsRef.current?.advance(direction),
      requestMore: () => edgeActionsRef.current?.requestMore(),
      onWaitingChange: value => setWaitingForNext(value),
    })
  }
  const feedBusy = useRef(false)
  const seenRef = useRef(readLegacyHistory())
  const loadedRef = useRef(new Set())
  const historyDbRef = useRef(null)
  const historyReadyRef = useRef(false)
  const [page, setPage] = useState(0)
  const [pageMotion, setPageMotion] = useState(null)
  const [brokenImages, setBrokenImages] = useState(() => new Set())
  const [photoVersion, setPhotoVersion] = useState(0)
  const [showCredits, setShowCredits] = useState(false)
  const markBrokenImage = image => {
    if (!image) return
    setBrokenImages(previous => {
      if (previous.has(image)) return previous
      const next = new Set(previous)
      next.add(image)
      return next
    })
  }
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
  const pointerGesture = useRef(null)
  const lastNavigationGesture = useRef(0)
  const [slide, setSlide] = useState(null)
  const slideTimer = useRef(null)
  const story = stories[storyIndex] || null
  const currentPage = story?.pages?.[page] || null

  // Recalculate before paint when dimensions change; avoid flashing truncated text.
  useLayoutEffect(() => {
    if (tab !== 'read' || !story) return
    let frame = 0
    let observer
    let cancelled = false
    const recalculate = () => {
      cancelAnimationFrame(frame)
      frame = requestAnimationFrame(() => {
        if (cancelled) return
        const reader = document.querySelector('.story-layer:not(.outgoing) .reader-gesture')
        if (!reader) return
        fitPhoto(reader.querySelector('.article-media img'))
        const next = layoutPages(story, reader, brokenImages)
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
    window.visualViewport?.addEventListener('resize', recalculate)
    document.fonts?.ready.then(recalculate).catch(() => {})
    return () => { cancelled = true; cancelAnimationFrame(frame); observer?.disconnect(); window.removeEventListener('resize', recalculate); window.visualViewport?.removeEventListener('resize', recalculate) }
  }, [tab, storyIndex, stories.length, story?._sourcePages, brokenImages, photoVersion])


  // Keep a large, ready-to-swipe queue. Background scans never replace the
  // visible article, and a failed request never advances past a missing chunk.
  const BUFFER_TARGET = 30
  const BUFFER_REFILL_AT = 16
  const chunkOrderRef = useRef([])
  const feedVersionRef = useRef('')
  const cursorRef = useRef(0)
  const doneRef = useRef(false)
  const lastManifestCheckRef = useRef(0)
  const retryAttemptRef = useRef(0)
  const retryTimerRef = useRef(null)
  const afterBusyRef = useRef(false)
  const boundaryProbeRef = useRef({key: '', time: 0})
  const storiesRef = useRef(stories)
  const storyIndexRef = useRef(storyIndex)
  storiesRef.current = stories
  storyIndexRef.current = storyIndex

  const scheduleRetry = () => {
    clearTimeout(retryTimerRef.current)
    const delay = Math.min(60000, 4000 * 2 ** Math.min(retryAttemptRef.current++, 4))
    retryTimerRef.current = setTimeout(() => loadFeed({forceCheck: true}), delay)
  }

  const loadFeed = async ({forceCheck = false, forceScan = false, urgent = false} = {}) => {
    // Avoid selecting articles before IndexedDB read history has been hydrated.
    if (!historyReadyRef.current) return
    if (feedBusy.current) {
      // The edge swipe must not be dropped just because prefetch is in flight.
      if (urgent) afterBusyRef.current = true
      return
    }
    const remaining = Math.max(0, storiesRef.current.length - storyIndexRef.current)
    const checkDue = forceCheck || Date.now() - lastManifestCheckRef.current >= 60000
    if (remaining >= BUFFER_TARGET && !checkDue && !forceScan && !urgent) return
    feedBusy.current = true
    if (remaining === 0 || urgent) setFeedLoading(true)
    setFeedRetrying(false)
    let appended = 0
    try {
      let manifest = manifestRef.current
      if (checkDue || !manifest) {
        manifest = await fetchManifest(fetch, import.meta.env.BASE_URL)
        manifestRef.current = manifest
        lastManifestCheckRef.current = Date.now()
      }
      if (manifest.version !== feedVersionRef.current || chunkOrderRef.current.length !== manifest.count) {
        chunkOrderRef.current = chunkOrder(manifest.count)
        cursorRef.current = 0
        doneRef.current = false
        setFeedDone(false)
        setFeedCursor(0)
        feedVersionRef.current = manifest.version
      } else if (forceScan) {
        cursorRef.current = 0
        doneRef.current = false
        setFeedDone(false)
        setFeedCursor(0)
      }

      if (remaining < BUFFER_TARGET && !doneRef.current) {
        // An urgent boundary swipe scans past chunks containing only seen articles.
        // V17 sometimes stopped after one empty batch and never resumed until
        // the user navigated backward and forward again.
        do {
          const result = await scanFeed({
            fetchImpl: fetch, baseUrl: import.meta.env.BASE_URL,
            order: chunkOrderRef.current, cursor: cursorRef.current,
            updatedAt: manifest.updatedAt, seen: seenRef.current,
            loaded: loadedRef.current, target: urgent ? 1 : BUFFER_TARGET - remaining - appended,
            // Urgent reads return after the FIRST unread story, not after 30.
            // Otherwise the reader can appear stuck while a 36-chunk scan runs.
            maxChunks: 9, concurrency: 3,
          })
          result.ids.forEach(id => loadedRef.current.add(id))
          cursorRef.current = result.cursor
          doneRef.current = result.done
          setFeedCursor(result.cursor)
          setFeedDone(result.done)
          if (result.items.length) {
            appended += result.items.length
            setStories(old => [...old, ...orderEditorial(result.items).map(paginateStory)])
          }
          if (result.error) throw result.error
          if (!result.scanned) break
          // Normal background refills remain bounded. An explicit end swipe
          // can search the rest of the archive until it finds unread content.
          // As soon as one unread article arrives, release the reader; the
          // ordinary prefetch effect can fill the remaining buffer afterward.
          if (!urgent || appended > 0) break
        } while (!doneRef.current && remaining + appended < BUFFER_TARGET)
      } else {
        setFeedDone(doneRef.current)
      }
      // A retry can also exhaust the archive; do not leave the reader waiting
      // indefinitely. A queued edge request still gets its follow-up attempt.
      if (!appended && doneRef.current && !afterBusyRef.current && edgeControllerRef.current.isWaiting()) {
        edgeControllerRef.current.noMore()
      }
      retryAttemptRef.current = 0
      clearTimeout(retryTimerRef.current)
    } catch (error) {
      console.warn('Feed temporarily unavailable:', error?.message || error)
      setFeedRetrying(true)
      if (!storiesRef.current.length && loadedRef.current.size === 0) {
        try {
          const fallback = await fetch(`${import.meta.env.BASE_URL}stories.json`, {cache: 'no-store'})
          if (!fallback.ok) throw new Error('Fallback unavailable')
          const data = await fallback.json()
          if (validStories(data)) {
            const unseen = orderEditorial(shuffle(data.filter(item => readableStory(item) && !seenRef.current.has(storyId(item)))))
            unseen.forEach(item => loadedRef.current.add(storyId(item)))
            if (unseen.length) setStories(unseen.map(paginateStory))
          }
        } catch { /* Retry automatically; never discard reading history. */ }
      }
      scheduleRetry()
    } finally {
      feedBusy.current = false
      setFeedLoading(false)
      if (afterBusyRef.current) {
        afterBusyRef.current = false
        // Complete a forward swipe queued during a background scan, even
        // if that scan contained no eligible articles.
        if (edgeControllerRef.current.isWaiting()) {
          queueMicrotask(() => loadFeed({forceCheck: doneRef.current, urgent: true}))
        }
      }
    }
  }

  const manifestRef = useRef(null)
  const refreshFeed = () => loadFeed({forceCheck: true, forceScan: true})
  useEffect(() => {
    let stopped = false
    initializeSeenHistory().then(({seen, db}) => {
      if (stopped) { db?.close(); return }
      seenRef.current = new Set([...seenRef.current, ...seen])
      historyDbRef.current = db
      historyReadyRef.current = true
      loadFeed({forceCheck: true})
    })
    return () => {
      stopped = true
      clearTimeout(retryTimerRef.current)
      edgeControllerRef.current.cancel()
      historyDbRef.current?.close()
    }
  }, [])
  useEffect(() => {
    if (!story) return
    const id = storyId(story)
    if (seenRef.current.has(id)) return
    seenRef.current.add(id)
    persistReadMarker(historyDbRef.current, id, seenRef.current)
  }, [storyIndex, story])
  useEffect(() => {
    if (tab !== 'read' || !historyReadyRef.current) return
    const remaining = stories.length - storyIndex
    // Keep replenishing ahead of the reader, including when the cursor reached
    // an older manifest. A changed online manifest is checked separately.
    if (!feedLoading && !feedBusy.current && !feedDone && remaining < BUFFER_REFILL_AT) {
      loadFeed()
    }
  }, [tab, storyIndex, stories.length, feedCursor, feedDone, feedLoading])
  useEffect(() => {
    if (tab !== 'read' || !historyReadyRef.current || !stories.length) return
    // Reaching the last ready story starts an urgent scan immediately — NOT
    // only after navigating backward and forward or repeating the swipe.
    // The key and cooldown prevent tight request loops on a finished archive.
    if (storyIndex < stories.length - 1) return
    const key = `${storyIndex}:${stories.length}:${feedVersionRef.current}:${cursorRef.current}`
    const now = Date.now()
    if (boundaryProbeRef.current.key === key && now - boundaryProbeRef.current.time < 15000) return
    if (doneRef.current && now - lastManifestCheckRef.current < 60000) return
    boundaryProbeRef.current = {key, time: now}
    loadFeed({urgent: true, forceCheck: doneRef.current})
  }, [tab, storyIndex, stories.length, feedLoading, feedCursor, feedDone])
  // A forward swipe at the edge is completed as soon as its next item arrives.
  useEffect(() => {
    if (tab !== 'read') { edgeControllerRef.current.cancel(); return }
    edgeControllerRef.current.onQueueChanged(storyIndex, stories.length)
  }, [tab, storyIndex, stories.length])
  // Check for published content while the reader is open or regains focus.
  // A missing connection is retried automatically with bounded backoff.
  useEffect(() => {
    const check = () => {
      if (document.visibilityState === 'visible') loadFeed({forceCheck: true})
    }
    const timer = setInterval(check, 60000)
    document.addEventListener('visibilitychange', check)
    window.addEventListener('focus', check)
    window.addEventListener('online', check)
    return () => {
      clearInterval(timer)
      document.removeEventListener('visibilitychange', check)
      window.removeEventListener('focus', check)
      window.removeEventListener('online', check)
    }
  }, [])

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
  const changePage = direction => {
    if (!story) return
    const next = Math.max(0, Math.min(story.pages.length - 1, page + direction))
    if (next === page) return
    setPageMotion(direction)
    setPage(next)
  }
  const navigateStory = direction => {
    const from = storyIndexRef.current
    const next = from + direction
    if (next < 0 || next >= storiesRef.current.length) return
    clearTimeout(slideTimer.current)
    setSlide({ from, fromPage: page, direction, stamp: Date.now() })
    storyIndexRef.current = next
    setStoryIndex(next)
    setPage(0)
    setPageMotion(null)
    slideTimer.current = setTimeout(() => setSlide(null), 560)
  }
  edgeActionsRef.current = {
    advance: navigateStory,
    requestMore: () => loadFeed({urgent: true, forceCheck: doneRef.current}),
  }
  const changeStory = direction => {
    if (direction > 0) edgeControllerRef.current.forward(storyIndexRef.current, storiesRef.current.length)
    else if (direction < 0) edgeControllerRef.current.backward(storyIndexRef.current)
  }
  // Horizontal reading is finger-driven. Only the page surface moves;
  // the masthead and bottom navigation remain anchored like a newspaper.
  const movePageSurface = (dx, dy) => {
    if (typeof document === 'undefined') return
    if (Math.abs(dx) < 8 || Math.abs(dx) < Math.abs(dy) * 1.2) return
    const surface = document.querySelector('.story-layer:not(.outgoing) .page-surface')
    if (!surface) return
    const distance = Math.max(-72, Math.min(72, dx * 0.4))
    surface.style.transition = 'none'
    surface.style.transform = `translate3d(${distance}px, 0, 0)`
    surface.style.opacity = String(1 - Math.abs(distance) / 450)
  }
  const releasePageSurface = () => {
    if (typeof document === 'undefined') return
    const surface = document.querySelector('.story-layer:not(.outgoing) .page-surface')
    if (!surface) return
    surface.style.transition = 'transform 220ms cubic-bezier(.2,.75,.25,1), opacity 220ms ease'
    surface.style.transform = 'translate3d(0,0,0)'
    surface.style.opacity = '1'
  }
  const handleNavigationGesture = (dx, dy) => {
    if (Math.max(Math.abs(dx), Math.abs(dy)) < 48) return
    // iOS can emit both pointerup and touchend. One gesture = one article.
    const now = Date.now()
    if (now - lastNavigationGesture.current < 280) return
    if (Math.abs(dx) > Math.abs(dy) * 1.15) changePage(dx < 0 ? 1 : -1)
    else if (Math.abs(dy) > Math.abs(dx) * 1.15) changeStory(dy < 0 ? 1 : -1)
    else return
    lastNavigationGesture.current = now
  }
  // Pointer events catch edge gestures missed by touchend after late image
  // loads or a mobile browser cancel. The touch fallback is deduplicated.
  const startPointer = event => {
    if (event.pointerType !== 'touch' || selected || event.target.closest('button, a, summary')) return
    pointerGesture.current = {id: event.pointerId, x: event.clientX, y: event.clientY}
  }
  const movePointer = event => {
    if (!pointerGesture.current || pointerGesture.current.id !== event.pointerId) return
    movePageSurface(event.clientX - pointerGesture.current.x, event.clientY - pointerGesture.current.y)
  }
  const endPointer = event => {
    if (!pointerGesture.current || pointerGesture.current.id !== event.pointerId) return
    const {x, y} = pointerGesture.current
    pointerGesture.current = null
    releasePageSurface()
    handleNavigationGesture(event.clientX - x, event.clientY - y)
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
    if ((control && !control.classList.contains('word-token')) || event.target.closest('a, summary')) { gesture.current = null; return }
    suppressWordClick.current = false
    gesture.current = { x: event.touches[0].clientX, y: event.touches[0].clientY, moved: false }
  }
  const moveGesture = event => {
    if (!gesture.current || event.touches.length !== 1) return
    const dx = event.touches[0].clientX - gesture.current.x
    const dy = event.touches[0].clientY - gesture.current.y
    movePageSurface(dx, dy)
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
    releasePageSurface()
    handleNavigationGesture(dx, dy)
  }
  const cancelGesture = () => { gesture.current = null; releasePageSurface(); suppressWordClick.current = false }
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
    const urls = [story?.pages?.[page + 1]?.image, stories[storyIndex + 1]?.pages?.[0]?.image, stories[storyIndex + 2]?.pages?.[0]?.image]
    const images = urls.filter(url => url && !brokenImages.has(url)).map(url => {
      const img = new Image()
      img.src = url
      return img
    })
    return () => { images.forEach(img => { img.onload = null; img.onerror = null }) }
  }, [tab, storyIndex, page, stories, brokenImages])
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
    return <div className="reader-gesture" aria-hidden={!interactive} onTouchStart={interactive ? startGesture : undefined} onTouchMove={interactive ? moveGesture : undefined} onTouchEnd={interactive ? endGesture : undefined} onTouchCancel={interactive ? cancelGesture : undefined} onPointerDown={interactive ? startPointer : undefined} onPointerMove={interactive ? movePointer : undefined} onPointerUp={interactive ? endPointer : undefined} onPointerCancel={interactive ? () => {pointerGesture.current = null; releasePageSurface()} : undefined}>
      <header className="topbar"><span className="brand">DAILY NEWS</span>{interactive && index === stories.length - 1 && <span className="reader-edge-status" role="status" aria-live="polite">{waitingForNext ? (feedRetrying ? 'Reconnecting…' : 'Finding next…') : feedDone ? 'Up to date' : feedLoading ? 'Loading…' : 'Swipe up · Next ↓'}</span>}</header>
      <div key={`${index}:${pageNumber}`} className={'page-surface ' + (interactive && pageMotion ? (pageMotion > 0 ? 'page-enter-left' : 'page-enter-right') : '')}>
      <div className={'article-heading ' + (pageNumber > 0 ? 'article-heading-continued' : '')}><div className="eyebrow">{readerSection(item)}</div><h1>{displayHeadline(item)}</h1><p className="deck">{item.subtitle}</p></div>
      <div className={"article-media " + (!itemPage.image || brokenImages.has(itemPage.image) ? "article-media-empty" : "")}>
        <ArticlePhoto key={itemPage.image || 'no-photo'} image={brokenImages.has(itemPage.image) ? '' : itemPage.image}
          label={photoLabel(itemPage)} onBroken={markBrokenImage}
          onReady={() => setPhotoVersion(n => n + 1)} />
      </div>
      <section className="reading-card"><div className="reading-topline"><span>{item.contentType === 'news' ? 'THE REPORT' : 'THE SHORT STORY'} · {pageNumber + 1}/{item.pages.length}</span><button className="icon-button" disabled={!interactive} onClick={() => speak(itemPage.text)} aria-label="Read aloud"><Icon name="volume" size={21}/></button></div>
        <p className="article-text">{tokens.map((token, i) => { const word = clean(token); return /^\s+$/.test(token) || !word ? token : <button key={i} type="button" disabled={!interactive} className={'word-token ' + (words.some(w => w.word === word) ? 'known' : '')} onClick={event => onWordClick(event, word)}>{token}</button> })}</p>
      </section>
      {pageNumber === item.pages.length - 1 && <div className="source-footer">
        {safeStoryUrl(item.sourceUrl) && <a className="original-link" href={safeStoryUrl(item.sourceUrl)} target="_blank" rel="noopener noreferrer">Read original article <span aria-hidden="true">↗</span></a>}
        <button className="credits-link" disabled={!interactive} onClick={() => setShowCredits(true)}>Sources &amp; licenses</button>
      </div>}
      <div className="page-control" aria-label={`Page ${pageNumber + 1} of ${item.pages.length}`}>
        <div className="dots" aria-hidden="true">{(() => {
          // A moving set of dots; each dot corresponds to a real nearby page.
          // Keep the total bounded on narrow phones, never change to a bar.
          const count = item.pages.length
          const visible = Math.min(count, 11)
          const first = Math.max(0, Math.min(pageNumber - Math.floor(visible / 2), count - visible))
          return Array.from({ length: visible }, (_, i) => first + i).map(i =>
            <span key={i} className={pageNumber === i ? 'active' : ''}/>)
        })()}</div>
      </div>
      </div>
    </div>
  }
  return (
    <div className={"app-shell " + (tab === "read" ? "reading-mode" : "")}>
      <main className="app-content">
        {tab === 'read' && <div className="story-viewport" onWheel={onReaderWheel}>
          {slide && stories[slide.from] && <div key={'old-'+slide.stamp} className={'story-layer outgoing '+(slide.direction>0?'slide-up':'slide-down')}>{renderStory(stories[slide.from], slide.from, slide.fromPage, false)}</div>}
          {story && <div key={'active-'+storyIndex} className={'story-layer '+(slide?(slide.direction>0?'enter-from-bottom':'enter-from-top'):'')}>{renderStory(story, storyIndex, page, true)}</div>}
          {!story && <div className="feed-empty"><h2>{feedLoading ? 'Finding your next story…' : feedDone ? 'You’re all caught up.' : 'Stories are temporarily unavailable.'}</h2><p>{feedDone ? 'You have read every available story on this device. New stories will appear when published.' : 'Check your connection or try again.'}</p><button className="primary" onClick={refreshFeed} disabled={feedLoading}>{feedLoading ? 'Loading…' : 'Check for new stories'}</button></div>}
        </div>}
        {tab === 'words' && <><header className="section-header"><span className="eyebrow">YOUR PERSONAL COLLECTION</span><h1>Saved words<span className="period">.</span></h1><p>Small discoveries, remembered.</p></header><div className="count-line">{words.length} {words.length === 1 ? 'WORD' : 'WORDS'} COLLECTED</div>{words.length === 0 ? <div className="empty"><Icon name="bookmark" size={40}/><h2>Your collection begins here.</h2><p>Read a story, tap a word, and save it to keep learning.</p><button className="primary" onClick={() => setTab('read')}>Start reading →</button></div> : <div className="saved-list">{words.map(item => <div className="saved-item" key={item.word}><div><h2><button className="saved-word-open" onClick={() => setSelected(item.word)}>{item.word}</button></h2>{item.partOfSpeech && <span className="word-meta">{item.partOfSpeech}</span>}{item.phonetic && <span className="word-meta">{item.phonetic}</span>}<p>{item.definition || offlineMeaning(item.word) || 'No definition yet. See the example sentence below.'}</p>{item.sentence && <p className="word-context">“{item.sentence}”</p>}</div><button onClick={() => { setWords(current => current.filter(w => w.word !== item.word)); setReviewIndex(0); setFinished(false) }} aria-label={`Remove ${item.word}`}><Icon name="close" size={19}/></button></div>)}</div>}</>}
        {tab === 'review' && <><header className="section-header"><span className="eyebrow">A MOMENT TO REMEMBER</span><h1>Daily review<span className="period">.</span></h1><p>Learn a little. Remember a lot.</p></header>{words.length === 0 ? <div className="empty"><Icon name="layers" size={42}/><h2>Nothing to review yet.</h2><p>Save a few words while reading. They will appear here.</p><button className="primary" onClick={() => setTab('read')}>Explore a story →</button></div> : finished ? <div className="empty"><Icon name="check" size={44}/><h2>Beautiful work.</h2><p>You have reviewed all {words.length} saved words.</p><button className="primary" onClick={() => { setFinished(false); setReviewIndex(0); setRevealed(false) }}>Review again →</button></div> : <><div className="review-count">CARD {Math.min(reviewIndex + 1, words.length)} OF {words.length}</div><button className="flashcard" onClick={() => setRevealed(r => !r)}><span>{revealed ? 'THE MEANING' : 'DO YOU REMEMBER?'}</span><strong>{revealed ? (words[Math.min(reviewIndex, words.length - 1)].definition || offlineMeaning(words[Math.min(reviewIndex, words.length - 1)].word) || 'No definition yet. Open this word in Words to retry.') : words[Math.min(reviewIndex, words.length - 1)].word}</strong><small>{revealed ? 'Tap to see the word' : 'Tap to reveal meaning'}</small></button><button className="primary review-next" onClick={nextReview}>{reviewIndex + 1 >= words.length ? 'Finish review' : 'Next word'} →</button></>}</>}
      </main>
      <nav className="bottom-nav" aria-label="Main navigation">{[['read', 'book', 'Read'], ['words', 'bookmark', 'Words'], ['review', 'layers', 'Review']].map(([key, icon, label]) => <button key={key} className={tab === key ? 'current' : ''} onClick={() => { if (key === 'read' && tab === 'read' && story && storyIndex === stories.length - 1) changeStory(1); else { setTab(key); setSelected('') } }}><Icon name={icon} size={25}/><span>{key === 'read' && tab === 'read' && story && storyIndex === stories.length - 1 ? waitingForNext ? 'Finding…' : feedDone ? 'Check again' : 'Next ↓' : label}</span></button>)}</nav>
      {showCredits && story && <div className="overlay" onClick={() => setShowCredits(false)}>
        <section className="definition-sheet sources-sheet" role="dialog" aria-label="Sources and licenses" onClick={event => event.stopPropagation()}>
          <div className="sheet-header"><span>ABOUT THIS ARTICLE</span><button aria-label="Close sources" onClick={() => setShowCredits(false)}>×</button></div>
          <h2>Sources &amp; credits</h2>
          <p><strong>Article:</strong> {story.attribution || story.sourceTitle || story.title}</p>
          <p><strong>Text license:</strong> {story.license || 'See original article for terms'}</p>
          {safeStoryUrl(story.sourceUrl) && <a href={safeStoryUrl(story.sourceUrl)} target="_blank" rel="noopener noreferrer">Original article ↗</a>}
          <div className="source-credit-list"><strong>Image attributions</strong>{(() => {
            const pages = story._sourcePages || story.pages
            const distinct = [...new Map(pages.filter(p => p.image).map(p => [p.image,p])).values()]
            return distinct.length ? distinct.map((p,i) => <p key={i}>{p.caption || photoLabel(p)} {photoSourceLink(p) && <a href={photoSourceLink(p)} target="_blank" rel="noopener noreferrer">Photo license ↗</a>}</p>) : <p>No article photos.</p>
          })()}</div>
          <button className="primary" onClick={() => setShowCredits(false)}>Back to reading</button>
        </section>
      </div>}
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
