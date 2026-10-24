import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import './App.css'
import { initializeSeenHistory, persistReadMarker, readLegacyHistory } from './lib/seenHistory.js'
import { storyId } from './lib/feedQueue.js'
import { planReadingPages, rebalanceTextPages } from './lib/readerPagination.js'
import { shortNewsPages } from './lib/shortNewsPages.js'
import { sanitizeReadingArticle } from './lib/articleCleanup.js'
import { refreshCatalog, refillCatalog, REFRESH_INTERVAL_MS } from './lib/continuousReader.js'
import { QUEUE_TARGET, queuedUnread, lowOnStories, refreshDue } from './lib/loreStockPolicy.js'
import { createEdgeNavigation } from './lib/edgeNavigation.js'
import { photoLabel, photoSourceLink } from './lib/photoPresentation.js'
import { resolvePhoto, photoResult } from './lib/photoLoad.js'
import { displayHeadline, readerSection } from './lib/editorial.js'
import { loadRecommendationProfile, rememberReading, rankRecommendations } from './lib/recommendationEngine.js'
import { handleReaderArrowKey } from './lib/readerKeyboard.js'
import {NEWS_LEVELS, NEWS_LEVEL_KEY, isNewsLevel, loadNewsLevel, applyNewsLevel} from './lib/newsLevels.js'
import { parseFreeDictionaryEntries, rankMeaningOptions } from './lib/contextualDictionary.js'


// Keep the complete adaptation for attribution while Read shows short pages.
const paginateStory = original => {
  const item = sanitizeReadingArticle(original)
  return { ...item, pages: item.contentType === 'news' ? shortNewsPages(item.pages) : item.pages, _sourcePages: item.pages }
}

// Photo frames use their true intrinsic aspect ratio. Fit within both the
// reader width and the viewport's responsive photo height, without cropping.
function photoFrameSize(mediaWidth,maxHeight,ratio) {
  const imageWidth=Math.max(1,Math.min(mediaWidth*.94-10,420,maxHeight*ratio))
  return {imageWidth,frameWidth:Math.min(mediaWidth,imageWidth+10)}
}
function fitPhoto(img) {
  if (!img?.naturalWidth || !img?.naturalHeight) return
  const frame = img.closest('.lore-photo-figure')
  const media = img.closest('.article-media')
  if (!frame || !media || !media.clientWidth) return
  const maxHeight = parseFloat(getComputedStyle(img).maxHeight) || 148
  const ratio = img.naturalWidth / img.naturalHeight
  if (!Number.isFinite(ratio) || ratio <= 0) return
  const {imageWidth,frameWidth}=photoFrameSize(media.clientWidth,maxHeight,ratio)
  frame.style.width = `${Math.ceil(frameWidth)}px`
  img.style.width = `${Math.ceil(imageWidth)}px`
  img.style.height = 'auto'
}

// V20: NEVER mount an <img> until pixels have loaded. A broken thumbnail
// cannot leave a native broken-image icon or steal reading space.
// DAILY LORE READ V5: original-photo fit + accessible full-screen preview.
function ArticlePhoto({ image, label, fullCaption, onBroken, onReady }) {
  const [asset, setAsset] = useState(() => photoResult(image))
  const [zoomed, setZoomed] = useState(false)
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
  useEffect(() => {
    if (!zoomed) return
    const closeOnEscape = event => { if (event.key === 'Escape') setZoomed(false) }
    window.addEventListener('keydown', closeOnEscape)
    return () => window.removeEventListener('keydown', closeOnEscape)
  }, [zoomed])
  if (!asset?.url) return null
  return <><figure className="photo-figure lore-photo-figure">
    <img src={asset.url} alt={label} decoding="async" loading="eager"
      width={asset.width} height={asset.height} role="button" tabIndex={0}
      aria-label={`Enlarge image: ${label || 'article photo'}`}
      onClick={() => setZoomed(true)}
      onKeyDown={event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); setZoomed(true) } }}
      onLoad={event => { fitPhoto(event.currentTarget); onReady() }}
      onError={() => onBroken(image)} />
    <button type="button" className="lore-photo-zoom-trigger" aria-label="Enlarge photo" title="Read full image caption" onClick={() => setZoomed(true)}><span aria-hidden="true">⛶</span></button>
    {zoomed && createPortal(<div className="lore-lightbox" role="dialog" aria-modal="true" aria-label="Enlarged article photograph" onClick={event => { event.stopPropagation(); setZoomed(false) }}>
      <button type="button" className="lore-lightbox-close" aria-label="Close enlarged photograph" onClick={event => { event.stopPropagation(); setZoomed(false) }}>×</button>
      <img src={asset.url} alt={label} onClick={event => event.stopPropagation()} />
      {fullCaption && <p className="lore-lightbox-caption" onClick={event => event.stopPropagation()}>{fullCaption}</p>}
    </div>, document.body)}
  </figure>{label && label !== 'Article photograph' && <p className="lore-photo-caption">{label}</p>}</>
}

// DAILY LORE READ V5: a teaser is useful only when it adds context.
function editorialDeck(article) {
  const deck = String(article?.subtitle || '').trim()
  if (!deck) return ''
  const original = String((article?._sourcePages || article?.pages || [])[0]?.text || '').trim()
  const normalized = value => value.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()
  if (original && normalized(original).startsWith(normalized(deck).slice(0, 65))) return ''
  return deck
}

function safeStoryUrl(url) {
  try {
    const parsed = new URL(url)
    return ['https:','http:'].includes(parsed.protocol) ? parsed.href : ''
  } catch { return '' }
}

// Wiki and older archive items use viewport pagination; published news uses
// its explicitly abridged four-to-six-page reading version.
function layoutPages(item, reader, badImages = new Set()) {
  if (item?.contentType === 'news') return item.pages
  // Editorial pages are source units, not guaranteed screen-sized. Measure
  // every level against the actual phone viewport and the anchored pager.
  const bounds = reader.getBoundingClientRect()
  if (bounds.width < 100 || bounds.height < 220) return item.pages
  const fixture = reader.cloneNode(true)
  fixture.setAttribute('aria-hidden', 'true')
  fixture.classList.add('layout-measure-fixture')
  Object.assign(fixture.style, {
    position:'fixed', left:'-20000px', top:'0', width:`${bounds.width}px`,
    height:`${bounds.height}px`, minHeight:'0', visibility:'hidden',
    pointerEvents:'none', zIndex:'-1', transform:'none',
  })
  const heading = fixture.querySelector('.article-heading')
  const media = fixture.querySelector('.article-media')
  const paragraph = fixture.querySelector('.article-text')
  const card = fixture.querySelector('.reading-card')
  const pager = fixture.querySelector('.page-control')
  const figure = document.createElement('figure')
  figure.className = 'photo-figure lore-photo-figure'
  const photo = document.createElement('img')
  const measuredCaption = document.createElement('p')
  measuredCaption.className = 'lore-photo-caption'
  figure.append(photo)
  media?.replaceChildren(figure, measuredCaption)
  const footer = fixture.querySelector('.source-footer')
  if (footer) footer.style.display = 'none'
  if (!heading || !media || !paragraph || !card || !pager) return item.pages
  reader.parentElement.appendChild(fixture)
  try {
    const fits = ({text, cover:isCover, image}) => {
      heading.classList.toggle('article-heading-continued', !isCover)
      media.classList.toggle('article-media-empty', !image)
      media.style.display = image ? 'flex' : 'none'
      measuredCaption.textContent = image ? photoLabel(image) : ''
      measuredCaption.style.display = measuredCaption.textContent && measuredCaption.textContent !== 'Article photograph' ? 'block' : 'none'
      if (image) {
        // Use the verified intrinsic image geometry whenever available.
        // Match the live photo width during pagination.
        const asset = photoResult(image.image)
        const maxHeight = parseFloat(getComputedStyle(photo).maxHeight) || 140
        const ratio = asset?.width && asset?.height ? asset.width / asset.height : 1.3
        const {imageWidth,frameWidth}=photoFrameSize(media.clientWidth,maxHeight,ratio)
        figure.style.width = `${Math.ceil(frameWidth)}px`
        photo.style.width = `${Math.ceil(imageWidth)}px`
        photo.style.height = `${imageWidth / ratio}px`
      } else {
        figure.style.width = ''
      }
      const fragment = document.createDocumentFragment()
      const tokens = String(text || '').split(/(\s+)/u)
      for (const token of tokens) {
        if (!token || /^\s+$/u.test(token) || !/[a-z]/i.test(token)) fragment.appendChild(document.createTextNode(token))
        else { const span = document.createElement('button'); span.type = 'button'; span.className = 'word-token'; span.textContent = token; fragment.appendChild(span) }
      }
      paragraph.replaceChildren(fragment)
      // Read V8: the pager has a fixed bottom position. Measure the text
      // against its TOP edge, not the pager's bottom (which no longer moves).
      // Reject overflow instead of silently hiding words behind navigation.
      const textBounds = paragraph.getBoundingClientRect()
      const mediaBounds = media.getBoundingClientRect()
      const pagerBounds = pager.getBoundingClientRect()
      const viewportBottom = fixture.getBoundingClientRect().bottom
      // The flex pager ends exactly at the reader's bottom; allow subpixel
      // rounding while keeping the entire paragraph above the pager.
      return textBounds.height > 0 && textBounds.bottom <= pagerBounds.top - 8
        && (!image || mediaBounds.bottom <= pagerBounds.top - 8)
        && pagerBounds.bottom <= viewportBottom + 1
    }
    // Failed/corrupt thumbnails may not reserve visual space. Reflow their
    // article text immediately, without altering the original source pages.
    const sourcePages = item?.contentType === 'news' ? item.pages : (item._sourcePages || item.pages)
    const cleanSources = sourcePages.map(p =>
      badImages.has(p.image) ? {...p,image:'',caption:''} : p)
    const next = item?.contentType === 'news'
      ? cleanSources
      : planReadingPages({...item,_sourcePages:cleanSources}, fits)
    if (!next.length) return item.pages
    return rebalanceTextPages(next, fits)
  } catch (error) {
    console.warn('Screen pagination deferred:', error?.message || error)
    return item.pages
  } finally {fixture.remove()}
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

// Prefer the already-integrated Free Dictionary API because its definitions
// include example sentences. Datamuse remains the fallback.
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
const withContextRanking = (result, word, context) => ({
  ...result,
  options: rankMeaningOptions(result.options, context, word).slice(0, 8),
})
const lookupWord = async (word, context, signal) => {
  if (dictionaryCache.has(word)) return withContextRanking(dictionaryCache.get(word), word, context)
  const candidates = wordCandidates(word)
  for (const candidate of candidates) {
    if (signal.aborted) throw new DOMException('Cancelled', 'AbortError')
    try {
      const entries = await fetchJSON(`https://api.dictionaryapi.dev/api/v2/entries/en/${encodeURIComponent(candidate)}`, signal, 2200)
      const options = parseFreeDictionaryEntries(entries)
      if (options.length) {
        const result = { options, source: 'Free Dictionary' }
        dictionaryCache.set(word, result)
        return withContextRanking(result, word, context)
      }
    } catch (error) { if (signal.aborted) throw error }
  }
  for (const candidate of candidates) {
    if (signal.aborted) throw new DOMException('Cancelled', 'AbortError')
    try {
      const data = await fetchJSON(`https://api.datamuse.com/words?sp=${encodeURIComponent(candidate)}&md=d&max=10`, signal, 3500)
      const options = parseDatamuse(data, candidate)
      if (options.length) {
        const result = { options, source: 'Datamuse' }
        dictionaryCache.set(word, result)
        return withContextRanking(result, word, context)
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
  const [readingLevel, setReadingLevel] = useState(() => loadNewsLevel(typeof localStorage === 'undefined' ? null : localStorage))
  const readingLevelRef = useRef(readingLevel)
  readingLevelRef.current = readingLevel
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
  const seenAtRef = useRef(new Map())
  const historyDbRef = useRef(null)
  const historyReadyRef = useRef(false)
  const [page, setPage] = useState(0)
  const [pageMotion, setPageMotion] = useState(null)
  useEffect(() => {
    if (pageMotion === null) return
    // Image measurements can rerender a page during its entrance animation.
    // Always clear the motion class so later pages cannot remain shifted.
    const timer = setTimeout(() => setPageMotion(null), 320)
    return () => clearTimeout(timer)
  }, [page, pageMotion, storyIndex])
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
  const changeReadingLevel = level => {
    if (!isNewsLevel(level) || level === readingLevel) return
    setReadingLevel(level)
    try { localStorage.setItem(NEWS_LEVEL_KEY, level) } catch { /* private mode */ }
    setStories(items => items.map(item => item.levelVariants ? paginateStory(applyNewsLevel(item, level)) : item))
    setPage(0)
    setPageMotion(null)
  }
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
          setPage(p => Math.min(p, next.length))
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
  }, [tab, storyIndex, stories.length, story?._sourcePages, story?.pages, brokenImages, photoVersion])


  // D12: search BOTH verified reader pools rather than selecting a single
  // 58-image feed and pretending those 58 stories are infinite.
  // Newly published chunks are checked automatically while the app is open.
  const BUFFER_TARGET = QUEUE_TARGET
  const recommendationProfileRef = useRef(loadRecommendationProfile(typeof localStorage === 'undefined' ? null : localStorage))
  const poolsRef = useRef([])
  const cursorRef = useRef(0)
  const doneRef = useRef(false)
  const lastManifestCheckRef = useRef(0)
  const wasLowOnStoriesRef = useRef(false)
  const wasCriticalOnStoriesRef = useRef(false)
  const retryAttemptRef = useRef(0)
  const retryTimerRef = useRef(null)
  const afterBusyRef = useRef(false)
  const checkAfterBusyRef = useRef(false)
  const boundaryProbeRef = useRef({key:'',time:0})
  const storiesRef = useRef(stories)
  const storyIndexRef = useRef(storyIndex)
  storiesRef.current = stories
  storyIndexRef.current = storyIndex

  const scheduleRetry = () => {
    clearTimeout(retryTimerRef.current)
    const delay = Math.min(60000, 4000 * 2 ** Math.min(retryAttemptRef.current++, 4))
    retryTimerRef.current = setTimeout(() => loadFeed({forceCheck:true}), delay)
  }

  const loadFeed = async ({forceCheck=false, forceScan=false, urgent=false}={}) => {
    if (!historyReadyRef.current) return
    if (feedBusy.current) {
      if (urgent) afterBusyRef.current = true
      if (forceCheck) checkAfterBusyRef.current = true
      return
    }
    const remaining = queuedUnread(storiesRef.current.length, storyIndexRef.current)
    const checkDue = forceCheck || refreshDue({
      remaining, checkedAt:lastManifestCheckRef.current,
      noCatalog:!poolsRef.current.length,
    })
    if (remaining>=BUFFER_TARGET && !checkDue && !forceScan && !urgent) return
    feedBusy.current = true
    if (!storiesRef.current.length || urgent) setFeedLoading(true)
    setFeedRetrying(false)
    let appended = 0
    let newIds = []
    try {
      if (checkDue) {
        const catalog = await refreshCatalog({fetchImpl:fetch,baseUrl:import.meta.env.BASE_URL,pools:poolsRef.current})
        if (!catalog.hasAvailable) throw Error(`No curated DAILY LORE release yet: ${catalog.failures.join('; ')}`)
        poolsRef.current = catalog.pools
        newIds = catalog.newIds || []
        lastManifestCheckRef.current = catalog.checkedAt
        // An updated manifest rewinds only THAT pool, not the current article.
        doneRef.current = poolsRef.current.every(p=>p.done)
      }
      if (forceScan) poolsRef.current = poolsRef.current.map(p=>({...p,cursor:0,done:false}))
      if (remaining<BUFFER_TARGET || urgent || forceScan || newIds.length) {
        const result = await refillCatalog({fetchImpl:fetch,baseUrl:import.meta.env.BASE_URL,
          pools:poolsRef.current,seen:seenRef.current,loaded:loadedRef.current,seenAt:seenAtRef.current,
          profile:recommendationProfileRef.current,recent:storiesRef.current.slice(Math.max(0,storyIndexRef.current-5),storyIndexRef.current+1),
          target:Math.max(newIds.length,urgent?1:Math.max(1,BUFFER_TARGET-remaining)),urgent,
          newsOnly:false,
          priorityIds:new Set(newIds)})
        poolsRef.current = result.pools
        doneRef.current = result.done
        cursorRef.current = result.pools.reduce((total,p)=>total+p.cursor,0)
        setFeedCursor(cursorRef.current)
        setFeedDone(doneRef.current)
        appended = result.items.length
        if (result.items.length) {
          const recommended = poolsRef.current.some(p=>Array.isArray(p.index)) ? result.items : rankRecommendations(result.items,{profile:recommendationProfileRef.current,
            seen:seenRef.current,recent:storiesRef.current.slice(Math.max(0,storyIndexRef.current-5),storyIndexRef.current+1)})
          const prepared = recommended.filter(item=>item.contentType==='wiki').map(item => paginateStory(applyNewsLevel(item, readingLevelRef.current)))
          const freshIds = new Set(newIds)
          setStories(old => {
            if (!old.length || !freshIds.size) return [...old,...prepared]
            const immediate = prepared.filter(item=>freshIds.has(storyId(item)))
            const later = prepared.filter(item=>!freshIds.has(storyId(item)))
            const next = Math.min(storyIndexRef.current+1,old.length)
            return [...old.slice(0,next),...immediate,...old.slice(next),...later]
          })
        }
        if (result.errors.length) {
          console.warn('Some reader sources temporarily unavailable:',result.errors)
          if (!appended) {setFeedRetrying(true);scheduleRetry()}
        } else {
          retryAttemptRef.current = 0
          clearTimeout(retryTimerRef.current)
        }
      } else setFeedDone(doneRef.current)
      if (!appended && doneRef.current && edgeControllerRef.current.isWaiting()) {
        edgeControllerRef.current.noMore()
      }
    } catch (error) {
      console.warn('Feed temporarily unavailable:',error?.message||error)
      setFeedRetrying(true)
      scheduleRetry()
    } finally {
      feedBusy.current = false
      setFeedLoading(false)
      if (checkAfterBusyRef.current) {
        checkAfterBusyRef.current = false
        afterBusyRef.current = false
        queueMicrotask(()=>loadFeed({forceCheck:true,urgent:edgeControllerRef.current.isWaiting()}))
      } else if (afterBusyRef.current) {
        afterBusyRef.current = false
        if (edgeControllerRef.current.isWaiting()) {
          if (doneRef.current) edgeControllerRef.current.noMore()
          else queueMicrotask(()=>loadFeed({forceCheck:false,urgent:true}))
        }
      }
    }
  }
  const refreshFeed = () => loadFeed({forceCheck:true,forceScan:true})
  useEffect(() => {
    let stopped = false
    initializeSeenHistory().then(({seen, db, seenAt}) => {
      if (stopped) { db?.close(); return }
      seenRef.current = new Set([...seenRef.current, ...seen])
      historyDbRef.current = db
      seenAtRef.current = seenAt || new Map()
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
    persistReadMarker(historyDbRef.current, id, seenRef.current, localStorage, seenAtRef.current)
    recommendationProfileRef.current = rememberReading(recommendationProfileRef.current, story, localStorage)
  }, [storyIndex, story])
  useEffect(() => {
    if (tab !== 'read' || !historyReadyRef.current) return
    const remaining = queuedUnread(stories.length,storyIndex)
    const low = lowOnStories(remaining)
    const enteredLow = low && !wasLowOnStoriesRef.current
    const critical = remaining < 3
    const enteredCritical = critical && !wasCriticalOnStoriesRef.current
    wasLowOnStoriesRef.current = low
    wasCriticalOnStoriesRef.current = critical
    if (feedBusy.current && (enteredLow || enteredCritical)) checkAfterBusyRef.current = true
    // At exactly 30 queued unread stories, check for a NEW publication now,
    // not only when the archive is exhausted. When no new publication exists,
    // the separate timer keeps checking without a request storm.
    if (!feedLoading && !feedBusy.current && low &&
        (enteredLow || enteredCritical || refreshDue({remaining,checkedAt:lastManifestCheckRef.current}))) {
      loadFeed({forceCheck:true})
    } else if (!feedLoading && !feedBusy.current && !feedDone && remaining < BUFFER_TARGET) {
      loadFeed()
    }
  }, [tab, storyIndex, stories.length, feedCursor, feedDone, feedLoading])
  useEffect(() => {
    if (tab !== 'read' || !historyReadyRef.current || !stories.length) return
    // Reaching the last ready story starts an urgent scan immediately — NOT
    // only after navigating backward and forward or repeating the swipe.
    // The key and cooldown prevent tight request loops on a finished archive.
    if (storyIndex < stories.length - 1) return
    const key = `${storyIndex}:${stories.length}:${poolsRef.current.map(p=>p.version + p.cursor).join('|')}`
    const now = Date.now()
    if (boundaryProbeRef.current.key === key && now - boundaryProbeRef.current.time < 15000) return
    if (doneRef.current && !storiesRef.current.length && now - lastManifestCheckRef.current < REFRESH_INTERVAL_MS) return
    boundaryProbeRef.current = {key, time: now}
    loadFeed({urgent: true, forceCheck: doneRef.current})
  }, [tab, storyIndex, stories.length, feedLoading, feedCursor, feedDone])
  // Limit mounted article data while preserving 40 previous stories for backwards
  // navigation. Seen IDs remain in IndexedDB; saved words stay untouched.
  useEffect(() => {
    if (slide || storyIndex < 100 || tab !== 'read') return
    const remove = storyIndex - 40
    storyIndexRef.current = 40
    setStories(old => {
      const retained=old.slice(remove)
      loadedRef.current=new Set(retained.map(storyId))
      return retained
    })
    setStoryIndex(40)
  }, [storyIndex, slide, tab])
  // A forward swipe at the edge is completed as soon as its next item arrives.
  useEffect(() => {
    if (tab !== 'read') { edgeControllerRef.current.cancel(); return }
    edgeControllerRef.current.onQueueChanged(storyIndex, stories.length)
  }, [tab, storyIndex, stories.length])
  // Probe the uncached manifest and catalog index every three minutes, and
  // immediately when the reader returns to the foreground.
  // Browser readers do not contain GitHub credentials or run a scraper.
  useEffect(() => {
    const check = () => {
      if (document.visibilityState === 'visible') loadFeed({forceCheck:true})
    }
    const timer = setInterval(check, REFRESH_INTERVAL_MS)
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
  const selectedSentence = (tab === 'words' && selectedSaved?.sentence) || sentenceParts.find(sentence =>
    sentence.toLowerCase().split(/[^a-z]+/).includes(selected)
  )?.trim() || (tab !== 'read' && selectedSaved?.sentence) || currentPage?.text || ''

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
    lookupWord(selected, selectedSentence, controller.signal)
      .then(result => { if (active && !controller.signal.aborted) setLookup({ status: 'success', ...result }) })
      .catch(() => { if (active && !controller.signal.aborted) setLookup({ status: 'error', options: [] }) })
      .finally(() => clearTimeout(timeout))
    return () => { active = false; clearTimeout(timeout); controller.abort() }
  }, [selected, selectedSentence, retryCount])

  const saveWord = () => {
    if (!selected || isSaved) return
    const meaning = activeMeaning
    const item = {
      word: selected,
      definition: meaning?.definition || offlineMeaning(selected) || '',
      phonetic: meaning?.phonetic || '',
      partOfSpeech: meaning?.partOfSpeech || '',
      example: meaning?.example || '',
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
        ? { ...item, definition: lookup.options[0].definition, phonetic: lookup.options[0].phonetic, partOfSpeech: lookup.options[0].partOfSpeech, example: lookup.options[0].example || '' }
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
    const next = Math.max(0, Math.min(story.pages.length, page + direction))
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
    if (event.pointerType !== 'touch' || selected || event.target.closest('button, a, summary, select, label')) return
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
    if ((control && !control.classList.contains('word-token')) || event.target.closest('a, summary, select, label')) { gesture.current = null; return }
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
  // V20.1: refresh the keyboard handler whenever the page changes. V20
  // omitted `page` from the dependencies, so ArrowRight kept reading a stale
  // page index (often page 0) and could not progress beyond page 2.
  useEffect(() => {
    const onKey = event => handleReaderArrowKey(event, {
      enabled: tab === 'read' && !selected && !showCredits && !!story,
      onNextPage: () => changePage(1),
      onPrevPage: () => changePage(-1),
      onNextStory: () => changeStory(1),
      onPrevStory: () => changeStory(-1),
    })
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [tab, selected, showCredits, page, storyIndex, story?.pages?.length, stories.length])

  // Desktop: wheel navigates stories instead of scrolling the reading screen.
  const onReaderWheel = event => {
    if (selected || event.ctrlKey) return
    if (event.cancelable) event.preventDefault()
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
    const closing = pageNumber === item.pages.length
    const itemPage = closing ? null : (item.pages[pageNumber] || item.pages[0])
    const tokens = closing ? [] : itemPage.text.split(/(\s+)/)
    const total = item.pages.length + 1 // always a distinct source / next-story page
    return <div className="reader-gesture" aria-hidden={!interactive} onTouchStart={interactive ? startGesture : undefined} onTouchMove={interactive ? moveGesture : undefined} onTouchEnd={interactive ? endGesture : undefined} onTouchCancel={interactive ? cancelGesture : undefined} onPointerDown={interactive ? startPointer : undefined} onPointerMove={interactive ? movePointer : undefined} onPointerUp={interactive ? endPointer : undefined} onPointerCancel={interactive ? () => {pointerGesture.current = null; releasePageSurface()} : undefined}>
      <header className="topbar lore-reader-topbar">
        <span className="saga-toolbar-story" title={readerSection(item)}>{readerSection(item)}</span>
        <div className="saga-toolbar-actions">
          {interactive && item.levelVariants && <label className="saga-news-level"><span className="saga-level-sr">Reading level</span><select aria-label="English reading level" value={readingLevel} onChange={event => changeReadingLevel(event.target.value)} onKeyDown={event => event.stopPropagation()}>{NEWS_LEVELS.map(level => <option key={level} value={level}>{level}</option>)}</select></label>}
          {interactive && !closing && <button type="button" className="icon-button saga-toolbar-audio" onClick={() => speak(itemPage.text)} aria-label="Read aloud"><Icon name="volume" size={20}/></button>}
        </div>
      </header>
      <div key={`${index}:${pageNumber}`} className={'page-surface ' + (interactive && pageMotion ? (pageMotion > 0 ? 'page-enter-left' : 'page-enter-right') : '')}>
      {closing ? <section className="story-end" aria-label="Article completed">
        <div className="story-end-center"><Icon name="book" size={56}/><h2>That's the short version.</h2>
          
          <button className="story-end-credits story-end-attribution" type="button" disabled={!interactive} onClick={() => setShowCredits(true)} aria-label="View article author, text license and individual image credits">Source</button>
          {safeStoryUrl(item.sourceUrl) && <a className="story-end-cta" href={safeStoryUrl(item.sourceUrl)} target="_blank" rel="noopener noreferrer">Read the full article</a>}
        </div><div className="story-end-next">Swipe up for the next story</div>
      </section> : <>
      <div className={'article-heading lore-article-heading ' + (pageNumber > 0 && item.contentType !== 'news' ? 'article-heading-continued' : '')}>
        <h1 className={displayHeadline(item).length > 45 ? 'lore-headline-long' : ''} title={displayHeadline(item)} aria-live={item.contentType === 'news' ? 'polite' : undefined}>{displayHeadline(item)}</h1>
        {pageNumber === 0 && editorialDeck(item) && <p className="deck lore-deck">{editorialDeck(item)}</p>}
      </div>
      <div className={"article-media " + (!itemPage.image || brokenImages.has(itemPage.image) ? "article-media-empty" : "")}>
        <ArticlePhoto key={itemPage.image || 'no-photo'} image={brokenImages.has(itemPage.image) ? '' : itemPage.image}
          label={photoLabel(itemPage)} fullCaption={itemPage.caption} onBroken={markBrokenImage}
          onReady={() => setPhotoVersion(n => n + 1)} />
      </div>
      <section className={'reading-card ' + (!itemPage.image || brokenImages.has(itemPage.image) ? 'reading-card-no-photo' : 'reading-card-with-photo')}><div className="reading-topline" aria-hidden="true" />
        <p className="article-text">{tokens.map((token, i) => { const word = clean(token); return /^\s+$/.test(token) || !word ? token : <button key={i} type="button" disabled={!interactive} className={'word-token ' + (words.some(w => w.word === word) ? 'known' : '')} onClick={event => onWordClick(event, word)}>{token}</button> })}</p>
      </section>
      </>}
      </div>
      <div className="page-control" aria-label={closing ? "Article completed" : `Page ${pageNumber + 1} of ${item.pages.length}`}>
        {!closing && <div className="lore-page-count" aria-label={`Page ${pageNumber + 1} of ${item.pages.length}`}>{pageNumber + 1}/{item.pages.length}</div>}
        <div className="lore-page-nav">
        <button type="button" className="page-arrow page-arrow-prev" aria-label="Previous page" title="Previous page (←)" disabled={!interactive || pageNumber === 0} onClick={() => changePage(-1)}><Icon name="left" size={17}/></button>
        <div className="dots" aria-hidden="true">{(() => {
          const visible = Math.min(total, 11)
          const first = Math.max(0, Math.min(pageNumber - Math.floor(visible / 2), total - visible))
          return Array.from({ length: visible }, (_, i) => first + i).map(i =>
            <span key={i} className={pageNumber === first + i ? 'active' : ''}/>)
        })()}</div>
        <button type="button" className="page-arrow page-arrow-next" aria-label="Next page" title="Next page (→)" disabled={!interactive || closing} onClick={() => changePage(1)}><Icon name="right" size={17}/></button>
        </div>
      </div>
    </div>
  }
  return (
    <div className={"app-shell " + (tab === "read" ? "reading-mode lore-editorial-v5" : "")}>
      <main className="app-content">
        {tab === 'read' && <div className="story-viewport" onWheel={onReaderWheel}>
          {slide && stories[slide.from] && <div key={'old-'+slide.stamp} className={'story-layer outgoing '+(slide.direction>0?'slide-up':'slide-down')}>{renderStory(stories[slide.from], slide.from, slide.fromPage, false)}</div>}
          {story && <div key={'active-'+storyIndex} className={'story-layer '+(slide?(slide.direction>0?'enter-from-bottom':'enter-from-top'):'')}>{renderStory(story, storyIndex, page, true)}</div>}
          {!story && <div className="feed-empty"><h2>{feedLoading ? 'Preparing your next discovery…' : feedDone ? 'You’re all caught up.' : 'Stories are temporarily unavailable.'}</h2><p>{feedDone ? 'You have read every available discovery today. More stories will appear as the shared collection grows.' : 'The new Wikipedia collection is being prepared. Please try again later.'}</p><button className="primary" onClick={refreshFeed} disabled={feedLoading}>{feedLoading ? 'Loading…' : 'Check for new stories'}</button></div>}
        </div>}
        {tab === 'words' && <><header className="section-header"><h1>Saved words<span className="period">.</span></h1></header>{words.length === 0 ? <div className="empty"><Icon name="bookmark" size={40}/><h2>Your collection begins here.</h2><p>Read a story, tap a word, and save it to keep learning.</p><button className="primary" onClick={() => setTab('read')}>Start reading →</button></div> : <div className="saved-list">{words.map(item => <div className="saved-item" key={item.word}><div><h2 className="saved-word-title"><button className="saved-word-open" onClick={() => setSelected(item.word)}>{item.word}</button></h2></div><button onClick={() => { setWords(current => current.filter(w => w.word !== item.word)); setReviewIndex(0); setFinished(false) }} aria-label={`Remove ${item.word}`}><Icon name="close" size={19}/></button></div>)}</div>}</>}
        {tab === 'review' && <><header className="section-header"><h1>Daily review<span className="period">.</span></h1></header>{words.length === 0 ? <div className="empty"><Icon name="layers" size={42}/><h2>Nothing to review yet.</h2><button className="primary" onClick={() => setTab('read')}>Start reading →</button></div> : finished ? <div className="empty"><Icon name="check" size={44}/><h2>Beautiful work.</h2><button className="primary" onClick={() => { setFinished(false); setReviewIndex(0); setRevealed(false) }}>Review again →</button></div> : <><button className="flashcard review-card" aria-label={revealed ? 'Show word' : 'Show meaning'} onClick={() => setRevealed(r => !r)}><strong className={revealed ? 'review-meaning' : 'review-word'}>{revealed ? (words[Math.min(reviewIndex, words.length - 1)].definition || offlineMeaning(words[Math.min(reviewIndex, words.length - 1)].word) || 'No definition yet. Open this word in Words to retry.') : words[Math.min(reviewIndex, words.length - 1)].word}</strong></button><button className="primary review-next" onClick={nextReview}>{reviewIndex + 1 >= words.length ? 'Finish review' : 'Next word'} →</button></>}</>}
      </main>
      <nav className="bottom-nav" aria-label="Main navigation">{[['read', 'book', 'Read'], ['words', 'bookmark', 'Words'], ['review', 'layers', 'Review']].map(([key, icon, label]) => <button key={key} className={tab === key ? 'current' : ''} onClick={() => { if (key === 'read' && tab === 'read' && story && storyIndex === stories.length - 1) changeStory(1); else { setTab(key); setSelected('') } }}><Icon name={icon} size={25}/><span>{key === 'read' && tab === 'read' && story && storyIndex === stories.length - 1 ? waitingForNext ? 'Finding…' : feedDone ? 'Check again' : 'Next ↓' : label}</span></button>)}</nav>
      {showCredits && story && <div className="overlay" onClick={() => setShowCredits(false)}>
        <section className="definition-sheet sources-sheet" role="dialog" aria-label="Sources and licenses" onClick={event => event.stopPropagation()}>
          <div className="sheet-header"><span>ABOUT THIS ARTICLE</span><button aria-label="Close sources" onClick={() => setShowCredits(false)}>×</button></div>
          <h2>Sources &amp; credits</h2>
          <p><strong>Article:</strong> {story.attribution || story.sourceTitle || story.title}</p>
          <p><strong>Text license:</strong> {story.license || 'See original article for terms'} {safeStoryUrl(story.licenseUrl) && <a href={safeStoryUrl(story.licenseUrl)} target="_blank" rel="noopener noreferrer">License terms ↗</a>}</p>
          {story.sourceMediaCredit && <p><strong>Original media attribution:</strong> {story.sourceMediaCredit}</p>}
          {safeStoryUrl(story.sourceUrl) && <a href={safeStoryUrl(story.sourceUrl)} target="_blank" rel="noopener noreferrer">Original article ↗</a>}
          {story.contentType==='wiki'&&safeStoryUrl(story.sourceRevisionUrl)&&<p><a href={safeStoryUrl(story.sourceRevisionUrl)} target="_blank" rel="noopener noreferrer">Pinned Wikipedia revision ↗</a></p>}
          <div className="source-credit-list"><strong>Image attributions</strong>{(() => {
            const pages = story._sourcePages || story.pages
            const distinct = [...new Map(pages.filter(p => p.image).map(p => [p.image,p])).values()]
            return distinct.length ? distinct.map((p,i) => <p key={i}>{p.imageProvenance?.credit || p.caption || photoLabel(p)} {p.imageProvenance?.license || ''} {safeStoryUrl(p.imageProvenance?.licenseUrl) && <a href={safeStoryUrl(p.imageProvenance.licenseUrl)} target="_blank" rel="noopener noreferrer">Image license ↗</a>} {safeStoryUrl(p.imageProvenance?.imagePageUrl) && <a href={safeStoryUrl(p.imageProvenance.imagePageUrl)} target="_blank" rel="noopener noreferrer">{p.imageProvenance?.originType === 'wikimedia-commons' ? 'Wikimedia Commons file ↗' : 'Original image ↗'}</a>} {p.imageProvenance?.originType !== 'wikimedia-commons' && safeStoryUrl(p.imageProvenance?.sourceImageUrl) && <a href={safeStoryUrl(p.imageProvenance.sourceImageUrl)} target="_blank" rel="noopener noreferrer">Image in original article ↗</a>}</p>) : <p>No verified reusable images in this article.</p>
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
                  <span><small>{i === 0 && item.contextScore > 0 ? 'Closest match to this sentence · ' : ''}{item.partOfSpeech || 'definition'} · {item.source}</small><span>{item.definition}</span>{item.example && <em className="meaning-example">Example: “{item.example}”</em>}</span>
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
