import { Fragment, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import './App.css'
import { initializeSeenHistory, persistReadMarker, readLegacyHistory } from './lib/seenHistory.js'
import { storyId } from './lib/feedQueue.js'
import { balancePhotoCoverPage, planAnchoredWikiPages, planReadingPages, rebalanceTextPages } from './lib/readerPagination.js'
import { shortNewsPages } from './lib/shortNewsPages.js'
import { sanitizeReadingArticle } from './lib/articleCleanup.js'
import { refreshCatalog, refillCatalog, REFRESH_INTERVAL_MS } from './lib/continuousReader.js'
import { QUEUE_TARGET, queuedUnread, lowOnStories, refreshDue } from './lib/loreStockPolicy.js'
import { createEdgeNavigation } from './lib/edgeNavigation.js'
import { photoCaption, photoLabel, photoSourceLink, photoSrcSet } from './lib/photoPresentation.js'
import { resolvePhoto, photoResult } from './lib/photoLoad.js'
import { displayHeadline, readerSection } from './lib/editorial.js'
import { loadRecommendationProfile, rememberReading, rankRecommendations } from './lib/recommendationEngine.js'
import { handleReaderArrowKey } from './lib/readerKeyboard.js'
import {NEWS_LEVELS, NEWS_LEVEL_KEY, isNewsLevel, loadNewsLevel, applyNewsLevel} from './lib/newsLevels.js'
import { selectContextualMeaning } from './lib/contextualDictionary.js'
import { tokenizeWithGlossary } from './utils/dictionaryTokenizer.js'
import { buildSavedTokenSet, isTokenSaved } from './lib/savedWordsMatch.js'
import { loadLemmaMap, loadPhraseMap, lookupDictionaryTerm, resolveStaticPhrase, resolveTier1Glossary } from './services/dictionaryService.js'
import { createArticleReaderController, splitPageIntoSentences } from './lib/readerAudio.js'
import {
  IOS_SHEET_EASING,
  SILK_EASING,
  SPRING_EASING,
  SHEET_OPEN_MS,
  SHEET_CLOSE_MS,
  SWIPE_SETTLE_MS,
  SNAPPY_MS,
  LIGHTBOX_CLOSE_MS,
  WORDS_REMOVE_MS,
  REVIEW_GLIDE_MS,
  applyRubberBand,
  applySheetUpwardRubberBand,
  measureUnderlineTransform,
  lockGestureAxis,
  shouldCompleteSwipe,
  shouldDismissSheet,
  sheetBackdropOpacity,
  prefersReducedMotion,
} from './lib/gesturePhysics.js'


const LEVEL_SEGMENTS = NEWS_LEVELS.map(level => {
  if (level === 'A1-A2') return { level, code: 'A', ariaLabel: 'Level A (A1-A2 Beginner)' }
  if (level === 'B1-B2') return { level, code: 'B', ariaLabel: 'Level B (B1-B2 Intermediate)' }
  return { level, code: 'C', ariaLabel: 'Level C (C1-C2 Advanced)' }
})

function LevelSegmentedControl({ readingLevel, onChange }) {
  const trackRef = useRef(null)
  const btnRefs = useRef([])
  const activeLevelIndex = Math.max(0, LEVEL_SEGMENTS.findIndex(seg => seg.level === readingLevel))
  const [underline, setUnderline] = useState(null)

  useLayoutEffect(() => {
    const measure = () => {
      const track = trackRef.current
      const btn = btnRefs.current[activeLevelIndex]
      if (!track || !btn) return
      const next = measureUnderlineTransform(btn.getBoundingClientRect(), track.getBoundingClientRect())
      if (next) {
        setUnderline(prev => (prev && prev.x === next.x && prev.scaleX === next.scaleX ? prev : next))
      }
    }
    measure()
    if (typeof ResizeObserver === 'undefined' || !trackRef.current) return undefined
    const observer = new ResizeObserver(measure)
    observer.observe(trackRef.current)
    return () => observer.disconnect()
  }, [activeLevelIndex])

  const onLevelKeyDown = event => {
    event.stopPropagation()
    if (event.key === 'ArrowRight' || event.key === 'ArrowDown') {
      event.preventDefault()
      onChange(LEVEL_SEGMENTS[(activeLevelIndex + 1) % LEVEL_SEGMENTS.length].level)
    } else if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') {
      event.preventDefault()
      onChange(LEVEL_SEGMENTS[(activeLevelIndex - 1 + LEVEL_SEGMENTS.length) % LEVEL_SEGMENTS.length].level)
    }
  }

  const sliderStyle = underline
    ? { transform: `translate3d(${underline.x}px, 0, 0) scaleX(${underline.scaleX})` }
    : undefined

  return (
    <div className="saga-news-level saga-level-group">
      <div
        ref={trackRef}
        className="saga-level-segmented"
        role="radiogroup"
        aria-label="Reading level"
        style={{ '--level-index': activeLevelIndex }}
        onKeyDown={onLevelKeyDown}
      >
        <span className={'saga-level-slider' + (underline ? ' is-measured' : '')} style={sliderStyle} aria-hidden="true" />
        {LEVEL_SEGMENTS.map((seg, segIdx) => {
          const active = readingLevel === seg.level
          return (
            <button
              key={seg.level}
              ref={el => { btnRefs.current[segIdx] = el }}
              type="button"
              role="radio"
              aria-checked={active}
              aria-label={seg.ariaLabel}
              title={seg.level}
              tabIndex={active ? 0 : -1}
              className={'saga-level-seg' + (active ? ' is-active' : '')}
              onClick={() => onChange(seg.level)}
            >
              {seg.code}
            </button>
          )
        })}
      </div>
    </div>
  )
}

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
  if (!img) return
  const frame = img.closest('.lore-photo-figure')
  if (frame) frame.style.width = ''
  img.style.width = ''
  img.style.height = ''
}

// V20: NEVER mount an <img> until pixels have loaded. A broken thumbnail
// cannot leave a native broken-image icon or steal reading space.
// DAILY LORE READ V5: original-photo fit + accessible full-screen preview.
function ArticlePhoto({ image, label: shortLabel, fullCaption, onBroken, onReady }) {
  const [asset, setAsset] = useState(() => photoResult(image))
  const [zoomed, setZoomed] = useState(false)
  const [lightboxClosing, setLightboxClosing] = useState(false)
  const lightboxTimerRef = useRef(null)
  const label = photoCaption({ image, caption: fullCaption }) || shortLabel
  const openLightbox = () => {
    clearTimeout(lightboxTimerRef.current)
    lightboxTimerRef.current = null
    setLightboxClosing(false)
    setZoomed(true)
  }
  const closeLightbox = () => {
    if (!zoomed) return
    if (prefersReducedMotion()) {
      clearTimeout(lightboxTimerRef.current)
      lightboxTimerRef.current = null
      setLightboxClosing(false)
      setZoomed(false)
      return
    }
    if (lightboxClosing) return
    setLightboxClosing(true)
    clearTimeout(lightboxTimerRef.current)
    lightboxTimerRef.current = setTimeout(() => {
      lightboxTimerRef.current = null
      setLightboxClosing(false)
      setZoomed(false)
    }, LIGHTBOX_CLOSE_MS)
  }
  useEffect(() => () => { clearTimeout(lightboxTimerRef.current) }, [])
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
    const closeOnEscape = event => { if (event.key === 'Escape') closeLightbox() }
    window.addEventListener('keydown', closeOnEscape)
    return () => window.removeEventListener('keydown', closeOnEscape)
  }, [zoomed, lightboxClosing])
  if (!image) return null
  if (!asset) return <figure className="photo-figure lore-photo-figure hero-media hero-media-loading" aria-hidden="true"><div className="hero-photo-skeleton" /></figure>
  if (!asset.url) return null
  const aspectStyle = asset.width && asset.height ? { '--photo-aspect': `${asset.width} / ${asset.height}` } : undefined
  const heroWidth = asset.width || 1600
  const heroHeight = asset.height || 900
  const srcSet = photoSrcSet(asset.url, asset.width)
  return <><figure className="photo-figure lore-photo-figure hero-media" style={aspectStyle}>
    <img className="hero-photo" src={asset.url} srcSet={srcSet} sizes="(max-width: 760px) calc(100vw - 2rem), 664px" alt={label} decoding="async" loading="lazy"
      width={heroWidth} height={heroHeight} role="button" tabIndex={0}
      aria-label={`Enlarge image: ${label || 'article photo'}`}
      onClick={openLightbox}
      onKeyDown={event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); openLightbox() } }}
      onLoad={event => { fitPhoto(event.currentTarget); onReady() }}
      onError={() => onBroken(image)} />
    <button type="button" className="lore-photo-zoom-trigger" aria-label="Enlarge photo" title="Read full image caption" onClick={openLightbox}>
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.1" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="M8 3H5a2 2 0 0 0-2 2v3"/>
        <path d="M21 8V5a2 2 0 0 0-2-2h-3"/>
        <path d="M3 16v3a2 2 0 0 0 2 2h3"/>
        <path d="M16 21h3a2 2 0 0 0 2-2v-3"/>
      </svg>
    </button>
    {zoomed && createPortal(<div className={'lore-lightbox' + (lightboxClosing ? ' is-closing' : '')} role="dialog" aria-modal="true" aria-label="Enlarged article photograph" onClick={event => { event.stopPropagation(); closeLightbox() }}>
      <button type="button" className="lore-lightbox-close" aria-label="Close enlarged photograph" onClick={event => { event.stopPropagation(); closeLightbox() }}>×</button>
      <img src={asset.url} srcSet={srcSet} sizes="(max-width: 768px) 96vw, 90vw" alt={label} decoding="async" loading="lazy" width={heroWidth} height={heroHeight} style={aspectStyle} onClick={event => event.stopPropagation()} />
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

// Measure every story against the actual viewport. News keeps its edited
// four-to-six-page structure while short photo covers can borrow text below.
function layoutPages(item, reader, badImages = new Set()) {
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
  const surface = fixture.querySelector('.page-surface')
  const heading = fixture.querySelector('.article-heading')
  const media = fixture.querySelector('.article-media')
  const paragraph = fixture.querySelector('.article-text')
  const card = fixture.querySelector('.reading-card')
  const pager = fixture.querySelector('.page-control')
  const figure = document.createElement('figure')
  figure.className = 'photo-figure lore-photo-figure hero-media'
  const photo = document.createElement('img')
  photo.className = 'hero-photo'
  const measuredCaption = document.createElement('p')
  measuredCaption.className = 'lore-photo-caption'
  figure.append(photo)
  media?.replaceChildren(figure, measuredCaption)
  const footer = fixture.querySelector('.source-footer')
  if (footer) footer.style.display = 'none'
  if (!heading || !media || !paragraph || !card || !pager) return item.pages
  reader.parentElement.appendChild(fixture)
  try {
    const sourcePages = item?.contentType === 'news' ? item.pages : (item._sourcePages || item.pages)
    const cleanSources = sourcePages.map(p =>
      badImages.has(p.image) ? {...p,image:'',caption:''} : p)
    const coverHasNoImage = item?.contentType === 'wiki'
      ? !cleanSources.some(p => p.image)
      : !cleanSources[0]?.image
    const fits = ({text, cover:isCover, image, density = ''}) => {
      heading.classList.add('post-head')
      heading.classList.toggle('post-head--no-image', !image)
      heading.classList.toggle('post-head--cover-no-image', coverHasNoImage)
      heading.classList.toggle('post-head--continued', !isCover)
      heading.classList.toggle('article-heading-continued', !isCover)
      card.classList.toggle('reading-card-no-photo', !image)
      card.classList.toggle('reading-card-with-photo', !!image)
      media.classList.toggle('article-media-empty', !image)
      surface?.classList.toggle('page-density-compact', density === 'compact')
      surface?.classList.toggle('saga-page--text-only', !image)
      media.style.display = image ? 'flex' : 'none'
      measuredCaption.textContent = image ? photoLabel(image) : ''
      measuredCaption.style.display = measuredCaption.textContent && measuredCaption.textContent !== 'Article photograph' ? '' : 'none'
      if (image) {
        const asset = photoResult(image.image)
        const computedMax = parseFloat(getComputedStyle(photo).maxHeight)
        const maxHeight = Number.isFinite(computedMax) && computedMax > 0
          ? computedMax
          : (window.innerHeight * (density === 'compact' ? (window.innerWidth <= 600 ? 0.22 : 0.3) : 0.4))
        const ratio = asset?.width && asset?.height ? asset.width / asset.height : 4 / 3
        const { frameWidth } = photoFrameSize(media.clientWidth, maxHeight, ratio)
        figure.style.width = `${Math.ceil(frameWidth)}px`
        figure.style.width = '100%'
        const measuredHeight = Math.min(maxHeight, media.clientWidth / ratio)
        const measuredWidth = Math.min(media.clientWidth, measuredHeight * ratio)
        photo.width = asset?.width || 1600
        photo.height = asset?.height || 900
        photo.style.width = `${Math.round(measuredWidth)}px`
        photo.style.height = `${Math.round(measuredHeight)}px`
      } else {
        figure.style.width = ''
        photo.style.width = ''
        photo.style.height = ''
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
    const next = item?.contentType === 'news'
      ? balancePhotoCoverPage(cleanSources, fits)
      : item?.contentType === 'wiki'
        ? planAnchoredWikiPages({...item,_sourcePages:cleanSources}, fits, {balanced: true})
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
  const [articlePlaying, setArticlePlaying] = useState(false)
  const [activeSentenceIndex, setActiveSentenceIndex] = useState(null)
  const articleReaderRef = useRef(null)
  if (!articleReaderRef.current) {
    articleReaderRef.current = createArticleReaderController({
      onStateChange: ({ playing }) => setArticlePlaying(playing),
      onSentenceChange: nextIdx => setActiveSentenceIndex(nextIdx),
      onAdvancePage: nextIdx => {
        setPageMotion(1)
        setPage(nextIdx)
      },
    })
  }
  const [levelSettleKey, setLevelSettleKey] = useState(0)
  const [tabSwitchedToRead, setTabSwitchedToRead] = useState(false)
  const [initialStoryReveal, setInitialStoryReveal] = useState(false)
  const hasRevealedStoryRef = useRef(false)
  useEffect(() => {
    if (pageMotion === null) return
    // Image measurements can rerender a page during its entrance animation.
    // Always clear the motion class so later pages cannot remain shifted.
    const timer = setTimeout(() => setPageMotion(null), SWIPE_SETTLE_MS + 20)
    return () => clearTimeout(timer)
  }, [page, pageMotion, storyIndex])
  useEffect(() => {
    if (!stories.length || hasRevealedStoryRef.current) return
    hasRevealedStoryRef.current = true
    setInitialStoryReveal(true)
    const timer = setTimeout(() => setInitialStoryReveal(false), SWIPE_SETTLE_MS + 40)
    return () => clearTimeout(timer)
  }, [stories.length])
  useEffect(() => {
    if (!tabSwitchedToRead) return
    const timer = setTimeout(() => setTabSwitchedToRead(false), prefersReducedMotion() ? 20 : SNAPPY_MS + 40)
    return () => clearTimeout(timer)
  }, [tabSwitchedToRead])
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
  const [selectedSurface, setSelectedSurface] = useState('')
  const [selectedGlossaryEntry, setSelectedGlossaryEntry] = useState(null)
  const [sheetClosing, setSheetClosing] = useState(false)
  const [justSavedWord, setJustSavedWord] = useState('')
  const justSavedTimerRef = useRef(null)
  const sheetOverlayRef = useRef(null)
  const sheetRef = useRef(null)
  const sheetScrollRef = useRef(null)
  const sheetDragRef = useRef(null)
  const sheetCloseTimerRef = useRef(null)
  const [staticPhrases, setStaticPhrases] = useState(null)
  const [lemmaMap, setLemmaMap] = useState(null)
  const [lookup, setLookup] = useState({ status: 'idle', options: [] })
  const [retryCount, setRetryCount] = useState(0)
  const [words, setWords] = useState(initialWords)
  const [removingWords, setRemovingWords] = useState(() => new Set())
  const removeTimersRef = useRef(new Map())
  const savedTokenSet = useMemo(() => buildSavedTokenSet(words, lemmaMap), [words, lemmaMap])
  const [reviewIndex, setReviewIndex] = useState(0)
  const [revealed, setRevealed] = useState(false)
  const [finished, setFinished] = useState(false)
  const [reviewMotion, setReviewMotion] = useState('idle')
  const reviewTimerRef = useRef(null)
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
    stopSpeech()
    setReadingLevel(level)
    try { localStorage.setItem(NEWS_LEVEL_KEY, level) } catch { /* private mode */ }
    setStories(items => items.map(item => item.levelVariants ? paginateStory(applyNewsLevel(item, level)) : item))
    setPage(0)
    setPageMotion(null)
    setLevelSettleKey(k => k + 1)
  }
  const removeSavedWord = word => {
    if (!word || removingWords.has(word)) return
    const finalize = () => {
      removeTimersRef.current.delete(word)
      setRemovingWords(prev => {
        if (!prev.has(word)) return prev
        const next = new Set(prev)
        next.delete(word)
        return next
      })
      setWords(current => current.filter(w => w.word !== word))
      setReviewIndex(0)
      setFinished(false)
      setRevealed(false)
    }
    if (prefersReducedMotion()) {
      finalize()
      return
    }
    setRemovingWords(prev => {
      const next = new Set(prev)
      next.add(word)
      return next
    })
    const timer = setTimeout(finalize, WORDS_REMOVE_MS)
    removeTimersRef.current.set(word, timer)
  }
  useEffect(() => () => {
    articleReaderRef.current?.stop()
    clearTimeout(justSavedTimerRef.current)
    clearTimeout(reviewTimerRef.current)
    clearTimeout(slideTimer.current)
    removeTimersRef.current.forEach(timer => clearTimeout(timer))
    removeTimersRef.current.clear()
  }, [])
  useEffect(() => {
    if (tab !== 'read') articleReaderRef.current?.stop()
  }, [tab])
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
        const before = story.pages.map(p => `${p.image}|${p.density || ''}|${p.text}`).join('\u0000')
        const after = next.map(p => `${p.image}|${p.density || ''}|${p.text}`).join('\u0000')
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
  useLayoutEffect(() => {
    if (tab !== 'read' || !story) return
    const img = document.querySelector('.story-layer:not(.outgoing) .reader-gesture .article-media img')
    if (img) fitPhoto(img)
  }, [tab, storyIndex, page, story?.pages])


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
  const feedFailedRef = useRef(false)
  const afterBusyRef = useRef(false)
  const checkAfterBusyRef = useRef(false)
  const boundaryProbeRef = useRef({key:'',time:0})
  const storiesRef = useRef(stories)
  const storyIndexRef = useRef(storyIndex)
  storiesRef.current = stories
  storyIndexRef.current = storyIndex

  const scheduleRetry = () => {
    clearTimeout(retryTimerRef.current)
    // Only auto-retry in the background when the reader already has stories on screen.
    // When empty, stop cleanly so the screen never flickers between loading and error states.
    if (!storiesRef.current.length) return
    const delay = Math.min(60000, 4000 * 2 ** Math.min(retryAttemptRef.current++, 4))
    retryTimerRef.current = setTimeout(() => loadFeed({forceCheck:true}), delay)
  }

  const loadFeed = async ({forceCheck=false, forceScan=false, urgent=false, manual=false}={}) => {
    if (!historyReadyRef.current) return
    if (manual) {
      feedFailedRef.current = false
      retryAttemptRef.current = 0
      clearTimeout(retryTimerRef.current)
    }
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
          feedFailedRef.current = false
        }
        if (result.errors.length) {
          console.warn('Some reader sources temporarily unavailable:',result.errors)
          if (!appended) {
            feedFailedRef.current = true
            setFeedRetrying(true)
            scheduleRetry()
          }
        } else if (!appended && !storiesRef.current.length) {
          // Stop cleanly if the catalog returned zero readable items rather than looping.
          feedFailedRef.current = true
        } else {
          feedFailedRef.current = false
          retryAttemptRef.current = 0
          clearTimeout(retryTimerRef.current)
        }
      } else setFeedDone(doneRef.current)
      if (!appended && doneRef.current && edgeControllerRef.current.isWaiting()) {
        edgeControllerRef.current.noMore()
      }
    } catch (error) {
      console.warn('Feed temporarily unavailable:',error?.message||error)
      feedFailedRef.current = true
      setFeedRetrying(true)
      scheduleRetry()
    } finally {
      feedBusy.current = false
      setFeedLoading(false)
      if (checkAfterBusyRef.current && !feedFailedRef.current) {
        checkAfterBusyRef.current = false
        afterBusyRef.current = false
        queueMicrotask(()=>loadFeed({forceCheck:true,urgent:edgeControllerRef.current.isWaiting()}))
      } else if (afterBusyRef.current && !feedFailedRef.current) {
        afterBusyRef.current = false
        if (edgeControllerRef.current.isWaiting()) {
          if (doneRef.current) edgeControllerRef.current.noMore()
          else queueMicrotask(()=>loadFeed({forceCheck:false,urgent:true}))
        }
      } else {
        checkAfterBusyRef.current = false
        afterBusyRef.current = false
      }
    }
  }
  const refreshFeed = () => loadFeed({forceCheck:true,forceScan:true,manual:true})
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
    if (tab !== 'read' || !historyReadyRef.current || !stories.length || feedFailedRef.current || feedRetrying) return
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
  }, [tab, storyIndex, stories.length, feedCursor, feedDone, feedLoading, feedRetrying])
  useEffect(() => {
    if (tab !== 'read' || !historyReadyRef.current || !stories.length || feedFailedRef.current) return
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
      if (document.visibilityState === 'visible' && !feedFailedRef.current) loadFeed({forceCheck:true})
    }
    const onOnline = () => {
      if (document.visibilityState === 'visible') loadFeed({forceCheck:true,manual:true})
    }
    const timer = setInterval(check, REFRESH_INTERVAL_MS)
    document.addEventListener('visibilitychange', check)
    window.addEventListener('focus', check)
    window.addEventListener('online', onOnline)
    return () => {
      clearInterval(timer)
      document.removeEventListener('visibilitychange', check)
      window.removeEventListener('focus', check)
      window.removeEventListener('online', onOnline)
    }
  }, [])

  useEffect(() => {
    try { localStorage.setItem('dailyLoreWords', JSON.stringify(words)) }
    catch (error) { console.warn('Saved words could not be stored on this device:', error) }
  }, [words])
  useEffect(() => { setWords(current => current.map(item => !item.definition && offlineMeaning(item.word) ? { ...item, definition: offlineMeaning(item.word) } : item)) }, [])
  const selectedSaved = words.find(w => w.word === selected)
  const isSaved = Boolean(selectedSaved)
  const activeMeaning = selectContextualMeaning(lookup.options || [])
  const activeGlossary = Array.isArray(story?.glossary) ? story.glossary : null
  const highlightTarget = selectedSurface || selected
  // Avoid lookbehind regex: Safari on iOS 15 cannot parse it and may show a blank screen.
  const sentenceParts = (currentPage?.text || '').match(/[^.!?]+[.!?]*|[^.!?]+$/g) || [currentPage?.text || '']
  const selectedSentence = (tab === 'words' && selectedSaved?.sentence) || sentenceParts.find(sentence => {
    const low = sentence.toLowerCase()
    const targetLow = (highlightTarget || '').toLowerCase()
    if (targetLow && targetLow.includes(' ')) return low.includes(targetLow)
    return low.split(/[^a-z'’-]+/).includes(targetLow || selected) || low.split(/[^a-z]+/).includes(targetLow || selected)
  })?.trim() || (tab !== 'read' && selectedSaved?.sentence) || currentPage?.text || ''

  const stopSpeech = () => {
    articleReaderRef.current?.stop()
    if (typeof window !== 'undefined' && 'speechSynthesis' in window) {
      window.speechSynthesis.cancel()
    }
  }

  const clearDictionaryNow = () => {
    clearTimeout(sheetCloseTimerRef.current)
    sheetCloseTimerRef.current = null
    sheetDragRef.current = null
    setSheetClosing(false)
    setSelected('')
    setSelectedSurface('')
    setSelectedGlossaryEntry(null)
  }

  const closeDictionary = ({ immediate = false } = {}) => {
    stopSpeech()
    if (!selected) return
    if (immediate || prefersReducedMotion()) {
      clearDictionaryNow()
      return
    }
    if (sheetClosing) return
    setSheetClosing(true)
    clearTimeout(sheetCloseTimerRef.current)
    sheetCloseTimerRef.current = setTimeout(clearDictionaryNow, SHEET_CLOSE_MS)
  }

  useEffect(() => () => { clearTimeout(sheetCloseTimerRef.current) }, [])

  useEffect(() => {
    if (!selected) return
    const onEscape = event => { if (event.key === 'Escape') closeDictionary() }
    window.addEventListener('keydown', onEscape)
    return () => window.removeEventListener('keydown', onEscape)
  }, [selected, sheetClosing])

  useEffect(() => {
    let active = true
    Promise.all([loadPhraseMap(), loadLemmaMap()])
      .then(([phrases, lemmas]) => {
        if (!active) return
        if (phrases && Object.keys(phrases).length) setStaticPhrases(phrases)
        if (lemmas && Object.keys(lemmas).length) setLemmaMap(lemmas)
      })
      .catch(() => {})
    return () => { active = false }
  }, [])

  useEffect(() => {
    if (!selected) return
    // Tier 1 (0ms synchronous): article glossary match
    const tier1 = resolveTier1Glossary(selectedSurface || selected, activeGlossary, selectedGlossaryEntry)
    if (tier1) {
      setLookup({ status: 'success', ...tier1 })
      return
    }
    // Tier 1.5 (0ms synchronous): static multi-word phrase match
    const tier15 = resolveStaticPhrase(
      selectedSurface || selected,
      staticPhrases,
      lemmaMap,
      selectedGlossaryEntry,
      selectedSentence
    )
    if (tier15) {
      setLookup({ status: 'success', ...tier15 })
      return
    }
    let active = true
    setLookup({ status: 'loading', options: [] })
    lookupDictionaryTerm(selectedSurface || selected, {
      sentence: selectedSentence,
      glossary: activeGlossary,
      glossaryEntry: selectedGlossaryEntry,
      phraseMap: staticPhrases,
      offlineFallback: offlineMeaning,
    })
      .then(result => { if (active) setLookup({ status: 'success', ...result }) })
      .catch(() => { if (active) setLookup({ status: 'error', options: [] }) })
    return () => { active = false }
  }, [selected, selectedSurface, selectedGlossaryEntry, selectedSentence, activeGlossary, staticPhrases, lemmaMap, retryCount])

  const toggleSaveMeaning = meaning => {
    if (!selected) return
    const def = String(meaning?.definition || offlineMeaning(selected) || '').trim()
    if (!def) return
    const willSave = !(selectedSaved && String(selectedSaved.definition || '').trim() === def)
    setWords(current => {
      const existing = current.find(w => w.word === selected)
      if (existing && String(existing.definition || '').trim() === def) {
        return current.filter(w => w.word !== selected)
      }
      const nextItem = {
        word: selected,
        definition: def,
        phonetic: meaning?.phonetic || lookup.ipa || '',
        partOfSpeech: meaning?.partOfSpeech || lookup.pos || '',
        example: meaning?.example || '',
        sentence: selectedSentence,
        added: existing?.added || Date.now(),
      }
      if (existing) {
        return current.map(w => w.word === selected ? nextItem : w)
      }
      return [...current, nextItem]
    })
    if (willSave) {
      setJustSavedWord(selected.toLowerCase())
      clearTimeout(justSavedTimerRef.current)
      justSavedTimerRef.current = setTimeout(() => setJustSavedWord(''), 420)
    }
  }

  const onSheetTouchStart = event => {
    if (event.touches.length !== 1 || sheetClosing) { sheetDragRef.current = null; return }
    const scrollEl = sheetScrollRef.current
    const startedInScroll = Boolean(scrollEl && scrollEl.contains(event.target))
    const canDragDown = !startedInScroll || scrollEl.scrollTop <= 0
    const canRubberUp = !startedInScroll
    const y = event.touches[0].clientY
    const now = performance.now()
    sheetDragRef.current = {
      startY: y,
      lastY: y,
      lastTime: now,
      velocity: 0,
      dy: 0,
      dragging: false,
      canDragDown,
      canRubberUp,
      startedInScroll,
    }
  }

  const onSheetTouchMove = event => {
    const drag = sheetDragRef.current
    if (!drag || event.touches.length !== 1 || sheetClosing) return
    const y = event.touches[0].clientY
    const rawDy = y - drag.startY
    if (!drag.dragging) {
      if (rawDy > 6) {
        if (!drag.canDragDown) {
          const scrollEl = sheetScrollRef.current
          if (drag.startedInScroll && scrollEl && scrollEl.scrollTop > 0) return
        }
        drag.dragging = true
      } else if (rawDy < -6 && drag.canRubberUp) {
        drag.dragging = true
      } else {
        if (rawDy < -4 && !drag.canRubberUp) drag.canDragDown = false
        return
      }
    }
    const visualDy = rawDy < 0 ? applySheetUpwardRubberBand(rawDy) : rawDy
    const now = performance.now()
    const dt = Math.max(1, now - drag.lastTime)
    const instantV = (y - drag.lastY) / dt
    drag.velocity = drag.velocity * 0.4 + instantV * 0.6
    drag.lastY = y
    drag.lastTime = now
    drag.dy = rawDy
    if (event.cancelable) event.preventDefault()
    const sheetEl = sheetRef.current
    const overlayEl = sheetOverlayRef.current
    const sheetHeight = sheetEl?.getBoundingClientRect().height || 360
    if (sheetEl) {
      sheetEl.style.transition = 'none'
      sheetEl.style.transform = `translate3d(0, ${visualDy}px, 0)`
    }
    if (overlayEl) {
      overlayEl.style.transition = 'none'
      overlayEl.style.opacity = String(sheetBackdropOpacity(Math.max(0, rawDy), sheetHeight))
    }
  }

  const onSheetTouchEnd = () => {
    const drag = sheetDragRef.current
    sheetDragRef.current = null
    if (!drag || !drag.dragging) return
    const sheetEl = sheetRef.current
    const overlayEl = sheetOverlayRef.current
    const sheetHeight = sheetEl?.getBoundingClientRect().height || 360
    if (shouldDismissSheet(drag.dy, sheetHeight, drag.velocity)) {
      stopSpeech()
      if (prefersReducedMotion()) {
        clearDictionaryNow()
        return
      }
      if (sheetEl) {
        sheetEl.style.transition = `transform ${SHEET_CLOSE_MS}ms ${IOS_SHEET_EASING}`
        sheetEl.style.transform = 'translate3d(0, 100%, 0)'
      }
      if (overlayEl) {
        overlayEl.style.transition = `opacity ${SHEET_CLOSE_MS}ms ${IOS_SHEET_EASING}`
        overlayEl.style.opacity = '0'
      }
      setSheetClosing(true)
      clearTimeout(sheetCloseTimerRef.current)
      sheetCloseTimerRef.current = setTimeout(clearDictionaryNow, SHEET_CLOSE_MS)
    } else {
      const springMs = prefersReducedMotion() ? 0 : SHEET_OPEN_MS
      if (sheetEl) {
        sheetEl.style.transition = springMs ? `transform ${springMs}ms ${SPRING_EASING}` : 'none'
        sheetEl.style.transform = 'translate3d(0, 0, 0)'
      }
      if (overlayEl) {
        overlayEl.style.transition = springMs ? `opacity ${springMs}ms ${SILK_EASING}` : 'none'
        overlayEl.style.opacity = '1'
      }
      setTimeout(() => {
        if (sheetRef.current && !sheetDragRef.current) {
          sheetRef.current.style.transition = ''
          sheetRef.current.style.transform = ''
        }
        if (sheetOverlayRef.current && !sheetDragRef.current) {
          sheetOverlayRef.current.style.transition = ''
          sheetOverlayRef.current.style.opacity = ''
        }
      }, springMs + 20)
    }
  }

  // A user's chosen meaning must never be overwritten by later API responses.
  // Only fill a previously blank definition, preserving existing vocabulary.
  useEffect(() => {
    if (!selected || lookup.status !== 'success' || !activeMeaning) return
    setWords(current => {
      if (!current.some(item => item.word === selected && !item.definition)) return current
      return current.map(item => item.word === selected && !item.definition
        ? { ...item, definition: activeMeaning.definition, phonetic: activeMeaning.phonetic, partOfSpeech: activeMeaning.partOfSpeech, example: activeMeaning.example || '' }
        : item)
    })
  }, [selected, lookup])

  const speak = value => {
    articleReaderRef.current?.playWordPronunciation(value)
  }
  const toggleArticleAudio = () => {
    if (articlePlaying) {
      stopSpeech()
      return
    }
    if (!story || !Array.isArray(story.pages) || page >= story.pages.length) return
    articleReaderRef.current?.start({
      pages: story.pages,
      startPage: page,
      readingLevel: readingLevelRef.current,
    })
  }
  const changePage = direction => {
    if (!story) return
    const next = Math.max(0, Math.min(story.pages.length, page + direction))
    if (next === page) return
    stopSpeech()
    setPageMotion(direction)
    setPage(next)
  }
  const navigateStory = direction => {
    const from = storyIndexRef.current
    const next = from + direction
    if (next < 0 || next >= storiesRef.current.length) return
    stopSpeech()
    clearTimeout(slideTimer.current)
    setSlide({ from, fromPage: page, direction, stamp: Date.now() })
    storyIndexRef.current = next
    setStoryIndex(next)
    setPage(0)
    setPageMotion(null)
    slideTimer.current = setTimeout(() => setSlide(null), prefersReducedMotion() ? 20 : SWIPE_SETTLE_MS + 20)
  }
  edgeActionsRef.current = {
    advance: navigateStory,
    requestMore: () => loadFeed({urgent: true, forceCheck: doneRef.current}),
  }
  const changeStory = direction => {
    if (direction > 0) edgeControllerRef.current.forward(storyIndexRef.current, storiesRef.current.length)
    else if (direction < 0) edgeControllerRef.current.backward(storyIndexRef.current)
  }
  // Interruptible 60fps iOS-grade touch tracking: GPU translate3d only, 0.25x boundary rubber-banding.
  const interruptActiveMotion = () => {
    if (typeof document === 'undefined') return
    setPageMotion(null)
    const surface = document.querySelector('.story-layer:not(.outgoing) .page-surface')
    if (surface) {
      surface.style.transition = 'none'
      surface.classList.remove('is-dragging')
    }
    const layer = document.querySelector('.story-layer:not(.outgoing)')
    if (layer) {
      layer.style.transition = 'none'
      layer.classList.remove('is-dragging')
    }
  }
  const applySwipeTransform = (axis, dx, dy) => {
    if (typeof document === 'undefined' || !axis) return
    if (axis === 'x') {
      const surface = document.querySelector('.story-layer:not(.outgoing) .page-surface')
      if (!surface) return
      const atBoundary = (dx > 0 && page === 0) || (dx < 0 && page >= (story?.pages?.length ?? 0))
      const tx = applyRubberBand(dx, atBoundary)
      surface.classList.add('is-dragging')
      surface.style.transition = 'none'
      surface.style.transform = `translate3d(${tx}px, 0, 0)`
    } else if (axis === 'y') {
      const layer = document.querySelector('.story-layer:not(.outgoing)')
      if (!layer) return
      const atBoundary = (dy > 0 && storyIndex === 0) || (dy < 0 && storyIndex >= stories.length - 1 && feedDone)
      const ty = applyRubberBand(dy, atBoundary)
      layer.classList.add('is-dragging')
      layer.style.transition = 'none'
      layer.style.transform = `translate3d(0, ${ty}px, 0)`
    }
  }
  const releaseSwipeTransform = ({ spring = true } = {}) => {
    if (typeof document === 'undefined') return
    const reduced = prefersReducedMotion()
    const transitionVal = spring && !reduced ? `transform ${SWIPE_SETTLE_MS}ms ${SILK_EASING}` : 'none'
    const surface = document.querySelector('.story-layer:not(.outgoing) .page-surface')
    if (surface) {
      surface.classList.remove('is-dragging')
      if (surface.style.transform) {
        surface.style.transition = transitionVal
        surface.style.transform = spring ? 'translate3d(0, 0, 0)' : ''
        if (!spring) surface.style.transition = ''
      }
    }
    const layer = document.querySelector('.story-layer:not(.outgoing)')
    if (layer) {
      layer.classList.remove('is-dragging')
      if (layer.style.transform) {
        layer.style.transition = transitionVal
        layer.style.transform = spring ? 'translate3d(0, 0, 0)' : ''
        if (!spring) layer.style.transition = ''
      }
    }
  }
  const finishNavigationGesture = (state, endX, endY) => {
    const dx = endX - state.x
    const dy = endY - state.y
    const axis = state.axis || lockGestureAxis(dx, dy, 10)
    const now = Date.now()
    const viewportW = typeof window !== 'undefined' ? window.innerWidth : 390
    const viewportH = typeof window !== 'undefined' ? window.innerHeight : 844
    if (now - lastNavigationGesture.current < 140) {
      releaseSwipeTransform({ spring: true })
      return
    }
    if (axis === 'x' && shouldCompleteSwipe(dx, viewportW, state.vx)) {
      const dir = dx < 0 ? 1 : -1
      const canMove = (dir > 0 && page < (story?.pages?.length ?? 0)) || (dir < 0 && page > 0)
      if (canMove) {
        releaseSwipeTransform({ spring: false })
        lastNavigationGesture.current = now
        changePage(dir)
        return
      }
    } else if (axis === 'y' && shouldCompleteSwipe(dy, viewportH, state.vy)) {
      const dir = dy < 0 ? 1 : -1
      const canMove = dir > 0 || storyIndex > 0
      if (canMove) {
        releaseSwipeTransform({ spring: false })
        lastNavigationGesture.current = now
        changeStory(dir)
        return
      }
    }
    releaseSwipeTransform({ spring: true })
  }
  const trackGestureMove = (state, clientX, clientY) => {
    const dx = clientX - state.x
    const dy = clientY - state.y
    const now = performance.now()
    const dt = Math.max(1, now - state.lastTime)
    state.vx = state.vx * 0.4 + ((clientX - state.lastX) / dt) * 0.6
    state.vy = state.vy * 0.4 + ((clientY - state.lastY) / dt) * 0.6
    state.lastX = clientX
    state.lastY = clientY
    state.lastTime = now
    if (!state.axis) state.axis = lockGestureAxis(dx, dy, 10)
    if (state.axis) applySwipeTransform(state.axis, dx, dy)
    return { dx, dy }
  }
  // Pointer events catch edge gestures missed by touchend after late image
  // loads or a mobile browser cancel. The touch fallback is deduplicated.
  const startPointer = event => {
    if (event.pointerType !== 'touch' || selected || event.target.closest('button, a, summary, select, label')) return
    interruptActiveMotion()
    const now = performance.now()
    pointerGesture.current = {
      id: event.pointerId, x: event.clientX, y: event.clientY,
      lastX: event.clientX, lastY: event.clientY, lastTime: now,
      vx: 0, vy: 0, axis: null,
    }
  }
  const movePointer = event => {
    if (!pointerGesture.current || pointerGesture.current.id !== event.pointerId) return
    if (gesture.current) return // touch handlers already tracking this finger
    trackGestureMove(pointerGesture.current, event.clientX, event.clientY)
  }
  const endPointer = event => {
    if (!pointerGesture.current || pointerGesture.current.id !== event.pointerId) return
    const state = pointerGesture.current
    pointerGesture.current = null
    finishNavigationGesture(state, event.clientX, event.clientY)
  }
  const nextReview = () => {
    if (reviewMotion === 'leaving') return
    const advanceNow = () => {
      if (reviewIndex + 1 >= words.length) {
        setFinished(true)
        setReviewMotion('idle')
      } else {
        setReviewIndex(i => i + 1)
        setRevealed(false)
        setReviewMotion('entering')
        clearTimeout(reviewTimerRef.current)
        reviewTimerRef.current = setTimeout(() => setReviewMotion('idle'), SWIPE_SETTLE_MS)
      }
    }
    if (prefersReducedMotion()) {
      advanceNow()
      return
    }
    setReviewMotion('leaving')
    clearTimeout(reviewTimerRef.current)
    reviewTimerRef.current = setTimeout(advanceNow, REVIEW_GLIDE_MS)
  }
  // Treat word buttons as part of the reading surface, not as navigation controls.
  // This makes swiping across the paragraph work on touch screens.
  const startGesture = event => {
    if (event.touches.length !== 1 || selected) { gesture.current = null; return }
    const control = event.target.closest('button')
    if ((control && !control.classList.contains('word-token')) || event.target.closest('a, summary, select, label')) { gesture.current = null; return }
    interruptActiveMotion()
    suppressWordClick.current = false
    const t = event.touches[0]
    const now = performance.now()
    gesture.current = {
      x: t.clientX, y: t.clientY, lastX: t.clientX, lastY: t.clientY,
      lastTime: now, vx: 0, vy: 0, axis: null, moved: false,
    }
  }
  const moveGesture = event => {
    if (!gesture.current || event.touches.length !== 1) return
    const t = event.touches[0]
    const { dx, dy } = trackGestureMove(gesture.current, t.clientX, t.clientY)
    if (Math.max(Math.abs(dx), Math.abs(dy)) > 12) {
      gesture.current.moved = true
      suppressWordClick.current = true
    }
  }
  const endGesture = event => {
    if (!gesture.current || selected) return
    const state = gesture.current
    gesture.current = null
    const t = event.changedTouches[0]
    finishNavigationGesture(state, t.clientX, t.clientY)
  }
  const cancelGesture = () => { gesture.current = null; releaseSwipeTransform({ spring: true }); suppressWordClick.current = false }
  const onWordClick = (event, word, glossaryEntry = null, surfaceText = '') => {
    if (suppressWordClick.current) {
      event.preventDefault()
      suppressWordClick.current = false
      return
    }
    stopSpeech()
    clearTimeout(sheetCloseTimerRef.current)
    sheetCloseTimerRef.current = null
    setSheetClosing(false)
    setSelectedGlossaryEntry(glossaryEntry || null)
    setSelectedSurface(surfaceText || word)
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
    const sentences = closing ? [] : splitPageIntoSentences(itemPage.text)
    const highlightActive = Boolean(interactive && articlePlaying && activeSentenceIndex !== null)
    const pageHasPhoto = Boolean(!closing && itemPage?.image && !brokenImages.has(itemPage.image) && !photoResult(itemPage.image)?.failed)
    const dotTotal = item.pages.length
    const topicLabel = readerSection(item).replace(/^DISCOVER\s*·\s*/i, '').trim()
    return <div className="reader-gesture" aria-hidden={!interactive} onTouchStart={interactive ? startGesture : undefined} onTouchMove={interactive ? moveGesture : undefined} onTouchEnd={interactive ? endGesture : undefined} onTouchCancel={interactive ? cancelGesture : undefined} onPointerDown={interactive ? startPointer : undefined} onPointerMove={interactive ? movePointer : undefined} onPointerUp={interactive ? endPointer : undefined} onPointerCancel={interactive ? () => {pointerGesture.current = null; releaseSwipeTransform({ spring: true })} : undefined}>
      <header className="topbar lore-reader-topbar">
        <div className="saga-topbar-slot saga-topbar-left">
          {interactive && item.levelVariants && (
            <LevelSegmentedControl readingLevel={readingLevel} onChange={changeReadingLevel} />
          )}
        </div>
        <span className="saga-toolbar-story" title={topicLabel}>{topicLabel}</span>
        <div className="saga-topbar-slot saga-topbar-right">
          {interactive && !closing && <button type="button" className={'icon-button saga-toolbar-audio' + (articlePlaying ? ' is-speaking' : '')} onClick={toggleArticleAudio} aria-pressed={articlePlaying} aria-label={articlePlaying ? 'Stop reading aloud' : 'Read aloud'} title={articlePlaying ? 'Stop reading aloud' : 'Read aloud'}><Icon name="volume" size={20}/></button>}
        </div>
      </header>
      <div key={`${index}:${pageNumber}`} className={'page-surface ' + (!closing && !pageHasPhoto ? 'saga-page--text-only ' : '') + (itemPage?.density ? `page-density-${itemPage.density} ` : '') + (interactive && pageMotion ? (pageMotion > 0 ? 'page-enter-left' : 'page-enter-right') : '')}>
      {closing ? <section className="story-end" aria-label="Article completed">
        <div className="story-end-center"><Icon name="book" size={56}/><h2>That's the short version.</h2>
          
          <button className="story-end-credits story-end-attribution" type="button" disabled={!interactive} onClick={() => setShowCredits(true)} aria-label="View article author, text license and individual image credits">Source</button>
          {safeStoryUrl(item.sourceUrl) && <a className="story-end-cta" href={safeStoryUrl(item.sourceUrl)} target="_blank" rel="noopener noreferrer">Read the full article</a>}
        </div><div className="story-end-next">Swipe up for the next story</div>
      </section> : <>
      <div className={'post-head article-heading lore-article-heading ' + (!itemPage.image || brokenImages.has(itemPage.image) || photoResult(itemPage.image)?.failed ? 'post-head--no-image ' : '') + (!item.pages[0]?.image || brokenImages.has(item.pages[0].image) || photoResult(item.pages[0].image)?.failed ? 'post-head--cover-no-image ' : '') + (pageNumber > 0 ? 'post-head--continued ' : '') + (pageNumber > 0 && item.contentType !== 'news' ? 'article-heading-continued' : '')}>
        <h1 className={displayHeadline(item).length > 45 ? 'lore-headline-long' : ''} title={displayHeadline(item)} aria-live={item.contentType === 'news' ? 'polite' : undefined}>{displayHeadline(item)}</h1>
        {pageNumber === 0 && editorialDeck(item) && <p className="deck lore-deck">{editorialDeck(item)}</p>}
      </div>
      <div className={"article-media " + (!itemPage.image || brokenImages.has(itemPage.image) || photoResult(itemPage.image)?.failed ? "article-media-empty" : "")}>
        <ArticlePhoto key={itemPage.image || 'no-photo'} image={brokenImages.has(itemPage.image) || photoResult(itemPage.image)?.failed ? '' : itemPage.image}
          label={photoLabel(itemPage)} fullCaption={itemPage.caption} onBroken={markBrokenImage}
          onReady={() => setPhotoVersion(n => n + 1)} />
      </div>
      <section className={'reading-card ' + (!itemPage.image || brokenImages.has(itemPage.image) || photoResult(itemPage.image)?.failed ? 'reading-card-no-photo' : 'reading-card-with-photo')}><div className="reading-topline" aria-hidden="true" />
        <p key={levelSettleKey ? `lvl-${levelSettleKey}` : 'lvl-0'} className={'article-text' + (levelSettleKey > 0 ? ' saga-level-settle' : '')}>{sentences.map((seg, sIdx) => {
          const [, leading, core, trailing] = seg.match(/^(\s*)([\s\S]*?)(\s*)$/) || ['', '', seg, '']
          const tokens = core ? tokenizeWithGlossary(core, item.glossary, staticPhrases, lemmaMap) : []
          const isCurrentSentence = highlightActive && activeSentenceIndex === sIdx
          const isDimmedSentence = highlightActive && activeSentenceIndex !== sIdx
          const sentenceClass = 'saga-sentence' + (isCurrentSentence ? ' saga-sentence--active' : '') + (isDimmedSentence ? ' saga-sentence--dimmed' : '')
          return <Fragment key={sIdx}>{leading}{core && <span className={sentenceClass} data-sentence-index={sIdx}>{tokens.map((token, i) => {
            if (token.kind === 'text') return token.text
            const saved = isTokenSaved(token, savedTokenSet, lemmaMap)
            const newlySaved = Boolean(saved && justSavedWord && (String(token.lookupKey || '').toLowerCase() === justSavedWord || String(token.text || '').toLowerCase() === justSavedWord))
            return <button key={i} type="button" disabled={!interactive} className={'word-token ' + (token.kind === 'glossary' ? 'glossary-token ' : token.kind === 'phrase' ? 'phrase-token ' : '') + (saved ? 'known ' : '') + (newlySaved ? 'just-saved' : '')} onClick={event => onWordClick(event, token.lookupKey, token.entry, token.text)}>{token.text}</button>
          })}</span>}{trailing}</Fragment>
        })}</p>
      </section>
      </>}
      </div>
      <div className="page-control" aria-label={closing ? "Article completed" : `Page ${pageNumber + 1} of ${item.pages.length}`}>
        <div className="lore-page-row">
          {!closing && <div className="lore-page-count" aria-label={`Page ${pageNumber + 1} of ${item.pages.length}`}>{pageNumber + 1}/{item.pages.length}</div>}
          <div className="lore-page-nav">
            <button type="button" className="page-arrow page-arrow-prev" aria-label="Previous page" title="Previous page (←)" disabled={!interactive || pageNumber === 0} onClick={() => changePage(-1)}><Icon name="left" size={17}/></button>
            <div className="dots" aria-hidden="true">{(() => {
              const visible = Math.min(dotTotal, 11)
              const activeDot = closing ? dotTotal - 1 : pageNumber
              const first = Math.max(0, Math.min(activeDot - Math.floor(visible / 2), dotTotal - visible))
              return Array.from({ length: visible }, (_, i) => first + i).map(i =>
                <span key={i} className={!closing && pageNumber === i ? 'active' : ''}/>)
            })()}</div>
            <button type="button" className="page-arrow page-arrow-next" aria-label="Next page" title="Next page (→)" disabled={!interactive || closing} onClick={() => changePage(1)}><Icon name="right" size={17}/></button>
          </div>
        </div>
        {!closing && pageNumber === item.pages.length - 1 && <div className="saga-final-page-hint">Swipe up for next story</div>}
      </div>
    </div>
  }
  const activeReviewWord = words.length ? words[Math.min(reviewIndex, words.length - 1)] : null
  const activeReviewMeaning = activeReviewWord
    ? (activeReviewWord.definition || offlineMeaning(activeReviewWord.word) || 'No definition yet. Open this word in Words to retry.')
    : ''
  const sheetDepthActive = Boolean(tab === 'read' && selected && !sheetClosing)
  return (
    <div className={"app-shell " + (tab === "read" ? "reading-mode lore-editorial-v5" : "")}>
      <main className="app-content">
        {tab === 'read' && <div className={'story-viewport' + (sheetDepthActive ? ' is-depth-scaled' : '') + (tabSwitchedToRead ? ' saga-tab-enter' : '')} onWheel={onReaderWheel}>
          {slide && stories[slide.from] && <div key={'old-'+slide.stamp} className={'story-layer outgoing '+(slide.direction>0?'slide-up':'slide-down')}>{renderStory(stories[slide.from], slide.from, slide.fromPage, false)}</div>}
          {story && <div key={'active-'+storyIndex} className={'story-layer '+(slide?(slide.direction>0?'enter-from-bottom':'enter-from-top'):(initialStoryReveal?'story-layer--reveal':''))}>{renderStory(story, storyIndex, page, true)}</div>}
          {!story && (feedLoading ? (
            <div className="feed-skeleton" role="status" aria-live="polite" aria-label="Loading stories">
              <div className="feed-skeleton-bar feed-skeleton-eyebrow" aria-hidden="true" />
              <div className="feed-skeleton-head" aria-hidden="true">
                <div className="feed-skeleton-bar feed-skeleton-title" />
                <div className="feed-skeleton-bar feed-skeleton-title-short" />
              </div>
              <div className="feed-skeleton-photo" aria-hidden="true" />
              <div className="feed-skeleton-lines" aria-hidden="true">
                <div className="feed-skeleton-bar feed-skeleton-line" />
                <div className="feed-skeleton-bar feed-skeleton-line feed-skeleton-line-95" />
                <div className="feed-skeleton-bar feed-skeleton-line feed-skeleton-line-90" />
                <div className="feed-skeleton-bar feed-skeleton-line feed-skeleton-line-68" />
              </div>
              <p className="feed-skeleton-label">Loading stories...</p>
            </div>
          ) : (
            <div className="feed-empty">
              <h2>{feedDone ? 'You’re all caught up.' : 'Unable to load stories right now.'}</h2>
              <p>{feedDone ? 'You have read every available story for now. Check back soon for new editions.' : 'Please check your connection and try again.'}</p>
              <button className="primary" onClick={refreshFeed}>{feedDone ? 'Check for new stories' : 'Try again'}</button>
            </div>
          ))}
        </div>}
        {tab === 'words' && <div key="tab-words" className="saga-tab-panel saga-tab-panel--words"><header className="section-header"><h1>Saved words<span className="period">.</span></h1>{words.length > 0 && <p className="saga-tab-meta">{words.length} {words.length === 1 ? 'word' : 'words'} saved</p>}</header>{words.length === 0 ? <div className="empty"><Icon name="bookmark" size={40}/><h2>Your collection begins here.</h2><p>Read a story, tap a word, and save it to keep learning.</p><button className="primary" onClick={() => { setTabSwitchedToRead(true); setTab('read') }}>Start reading →</button></div> : <div className="saved-list">{words.map((item, idx) => <div className={'saved-item' + (removingWords.has(item.word) ? ' is-removing' : '')} style={{ '--stagger-idx': Math.min(idx, 7) }} key={item.word}><div><h2 className="saved-word-title"><button type="button" className="saved-word-open" onClick={() => { stopSpeech(); clearTimeout(sheetCloseTimerRef.current); setSheetClosing(false); setSelectedGlossaryEntry(null); setSelectedSurface(''); setSelected(item.word) }}>{item.word}</button></h2></div><button type="button" className="saved-item-remove" onClick={() => removeSavedWord(item.word)} aria-label={`Remove ${item.word}`}><Icon name="close" size={19}/></button></div>)}</div>}</div>}
        {tab === 'review' && <div key="tab-review" className="saga-tab-panel saga-tab-panel--review"><header className="section-header"><h1>Daily review<span className="period">.</span></h1></header>{words.length === 0 ? <div className="empty"><Icon name="layers" size={42}/><h2>Nothing to review yet.</h2><p>Save a few words while reading to start your daily deck.</p><button className="primary" onClick={() => { setTabSwitchedToRead(true); setTab('read') }}>Start reading →</button></div> : finished ? <div className="empty"><Icon name="check" size={44}/><h2>Beautiful work.</h2><p>You reviewed every word in your collection.</p><button className="primary" onClick={() => { setFinished(false); setReviewIndex(0); setRevealed(false); setReviewMotion('entering') }}>Review again →</button></div> : <div className="review-stage"><div className="review-progress" aria-label={`Card ${Math.min(reviewIndex + 1, words.length)} of ${words.length}`}><div className="review-progress-meta"><span>{Math.min(reviewIndex + 1, words.length)} / {words.length}</span></div><div className="review-progress-track" aria-hidden="true"><span className="review-progress-fill" style={{ transform: `scaleX(${Math.min(reviewIndex + 1, words.length) / words.length})` }} /></div></div><button type="button" className={'flashcard review-card' + (revealed ? ' is-flipped' : '') + (reviewMotion === 'leaving' ? ' is-gliding-out' : '') + (reviewMotion === 'entering' ? ' is-gliding-in' : '')} aria-label={revealed ? 'Show word' : 'Show meaning'} aria-pressed={revealed} onClick={() => setRevealed(r => !r)}><span className="review-card-inner"><span className="review-card-face review-card-front" aria-hidden={revealed}>{!revealed ? <strong className={revealed ? 'review-meaning' : 'review-word'}>{activeReviewWord.word}</strong> : <strong className="review-word-inert">{activeReviewWord.word}</strong>}</span><span className="review-card-face review-card-back" aria-hidden={!revealed}>{revealed ? <strong className={revealed ? 'review-meaning' : 'review-word'}>{activeReviewMeaning}</strong> : <strong className="review-meaning-inert">{activeReviewMeaning}</strong>}</span></span></button><button type="button" className="primary review-next" onClick={nextReview}>{reviewIndex + 1 >= words.length ? 'Finish review' : 'Next word'} →</button></div>}</div>}
      </main>
      <nav className="bottom-nav" aria-label="Main navigation">{[['read', 'book', 'Read'], ['words', 'bookmark', 'Words'], ['review', 'layers', 'Review']].map(([key, icon, label]) => <button key={key} className={tab === key ? 'current' : ''} onClick={() => { if (key === 'read' && tab === 'read' && story && storyIndex === stories.length - 1) changeStory(1); else { setTabSwitchedToRead(key === 'read' && tab !== 'read'); setTab(key); closeDictionary({ immediate: true }) } }}><Icon name={icon} size={25}/><span>{key === 'read' && tab === 'read' && story && storyIndex === stories.length - 1 ? waitingForNext ? 'Finding…' : feedDone ? 'Check again' : 'Next ↓' : label}</span></button>)}</nav>
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
      {selected && <div ref={sheetOverlayRef} className={'overlay dictionary-overlay' + (sheetClosing ? ' is-closing' : '')} onClick={() => closeDictionary()}>
        <div
          ref={sheetRef}
          className={'definition-sheet dictionary-sheet' + (sheetClosing ? ' is-closing' : '')}
          role="dialog"
          aria-modal="true"
          aria-label={`Meaning of ${selected} in context`}
          onClick={e => e.stopPropagation()}
          onTouchStart={onSheetTouchStart}
          onTouchMove={onSheetTouchMove}
          onTouchEnd={onSheetTouchEnd}
          onTouchCancel={onSheetTouchEnd}
        >
          <div className="dict-drag-handle" aria-hidden="true" />
          {(() => {
            const headingWord = (lookup.lemma || lookup.surface || selected) || selected
            const displayWord = headingWord ? headingWord.charAt(0).toUpperCase() + headingWord.slice(1) : ''
            const posBadge = lookup.pos || activeMeaning?.partOfSpeech || ''
            const cefrBadge = lookup.cefr || activeMeaning?.cefr || ''
            const ipaText = lookup.ipa || activeMeaning?.phonetic || ''
            const showFromNote = Boolean(selectedSurface && selectedSurface.toLowerCase() !== headingWord.toLowerCase())
            const metaParts = [
              posBadge && { key: 'pos', cls: 'dict-meta-pos', text: posBadge.toLowerCase() },
              cefrBadge && { key: 'cefr', cls: 'dict-meta-cefr', text: cefrBadge.toUpperCase() },
              ipaText && { key: 'ipa', cls: 'dict-ipa', text: ipaText },
              showFromNote && { key: 'from', cls: 'dict-surface-note', text: `from “${selectedSurface}”` },
            ].filter(Boolean)
            const allOptions = lookup.options || []
            const showNumbers = allOptions.length > 1
            const savedDef = String(selectedSaved?.definition || '').trim()
            const tier1Def = String(lookup.vi_context || lookup.en_def || activeMeaning?.definition || '').trim()
            const tier1Saved = Boolean(isSaved && tier1Def && (savedDef === tier1Def || savedDef === String(lookup.en_def || '').trim()))
            const hasMeanings = lookup.status === 'success' && (lookup.tier === 1 || allOptions.length > 0)
            const handleRowKeyDown = (event, meaningObj) => {
              if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault()
                toggleSaveMeaning(meaningObj)
              }
            }
            return <>
              <div className="dict-head-row">
                <h2>{displayWord}</h2>
                <button type="button" className="dict-close-btn" onClick={() => closeDictionary()} aria-label="Close">
                  <Icon name="close" size={20}/>
                </button>
              </div>
              <div className="dict-meta-row">
                {metaParts.map((part, idx) => (
                  <span key={part.key} className="dict-meta-item">
                    {idx > 0 && <span className="dict-meta-sep" aria-hidden="true">·</span>}
                    <span className={part.cls}>{part.text}</span>
                  </span>
                ))}
                <button type="button" className="dict-speak-btn" onClick={() => speak(headingWord)} aria-label={`Listen to ${headingWord}`} title="Listen">
                  <Icon name="volume" size={16}/>
                </button>
              </div>
              {hasMeanings && <p className="dict-tap-hint">Tap a meaning to save</p>}
              <div ref={sheetScrollRef} className="lookup-details">
                {lookup.status === 'loading' && <p className="dict-status-note">Looking up the word...</p>}
                {lookup.status === 'success' && <>
                  {lookup.tier === 1 ? (
                    <div
                      className={'contextual-meaning dict-tier1-meaning dict-sense-tappable' + (tier1Saved ? ' is-saved' : '')}
                      role="button"
                      tabIndex={0}
                      aria-pressed={tier1Saved}
                      onClick={() => toggleSaveMeaning({
                        definition: tier1Def,
                        phonetic: ipaText,
                        partOfSpeech: posBadge,
                        example: activeMeaning?.example || '',
                      })}
                      onKeyDown={event => handleRowKeyDown(event, {
                        definition: tier1Def,
                        phonetic: ipaText,
                        partOfSpeech: posBadge,
                        example: activeMeaning?.example || '',
                      })}
                    >
                      <div className="dict-sense-row-head">
                        <div className="dict-tier1-copy">
                          {lookup.vi_context && <p className="dict-vi-meaning">{lookup.vi_context}</p>}
                          {lookup.en_def && <p className="dict-en-meaning">{lookup.en_def}</p>}
                        </div>
                        {tier1Saved && <span className="dict-saved-badge"><Icon name="check" size={13}/>Saved</span>}
                      </div>
                    </div>
                  ) : allOptions.length > 0 ? (
                    <div className="contextual-meaning dict-tier2-meanings">
                      {allOptions.map((opt, idx) => {
                        const optDef = String(opt.en_def || opt.definition || '').trim()
                        const rowSaved = Boolean(isSaved && savedDef === optDef)
                        const payload = {
                          definition: optDef,
                          phonetic: opt.phonetic || ipaText,
                          partOfSpeech: opt.partOfSpeech || posBadge,
                          example: opt.example || '',
                        }
                        return (
                          <div
                            key={idx}
                            role="button"
                            tabIndex={0}
                            aria-pressed={rowSaved}
                            className={'dict-sense-row dict-sense-tappable' + (showNumbers ? ' dict-sense-numbered' : '') + (rowSaved ? ' is-saved' : '')}
                            onClick={() => toggleSaveMeaning(payload)}
                            onKeyDown={event => handleRowKeyDown(event, payload)}
                          >
                            {showNumbers && <span className="dict-sense-num">{idx + 1}</span>}
                            <div className="dict-sense-body">
                              <div className="dict-sense-line">
                                <span className="dict-sense-def">{optDef}</span>
                              </div>
                            </div>
                            {rowSaved && <span className="dict-saved-badge"><Icon name="check" size={13}/>Saved</span>}
                          </div>
                        )
                      })}
                    </div>
                  ) : (
                    <div className="no-contextual-meaning">
                      <p>No local definition found for “{selectedSurface || selected}”.</p>
                    </div>
                  )}
                </>}
                {lookup.status === 'error' && <><p className="dict-status-note">Dictionary temporarily unavailable.</p><button className="retry-link" onClick={() => setRetryCount(n => n + 1)}>Try again</button></>}
              </div>
            </>
          })()}
        </div>
      </div>}
    </div>
  )
}

export default App
