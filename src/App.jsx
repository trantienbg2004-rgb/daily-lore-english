import { Fragment, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import './App.css'
import { initializeSeenHistory, persistReadMarker, readLegacyHistory } from './lib/seenHistory.js'
import { storyId } from './lib/feedQueue.js'
import { balancePhotoCoverPage, groupTokenClusters, mapSemanticPageIndex, planAnchoredWikiPages, planReadingPages, rebalanceTextPages, splitParagraphs } from './lib/readerPagination.js'
import { shortNewsPages } from './lib/shortNewsPages.js'
import { sanitizeReadingArticle } from './lib/articleCleanup.js'
import { refreshCatalog, refillCatalog, hasUnfetchedShards, REFRESH_INTERVAL_MS } from './lib/continuousReader.js'
import { QUEUE_TARGET, queuedUnread, lowOnStories, refreshDue } from './lib/loreStockPolicy.js'
import { createEdgeNavigation } from './lib/edgeNavigation.js'
import { photoCaption, photoLabel, photoSourceLink } from './lib/photoPresentation.js'
import { evictPhoto, resolvePhoto, photoResult } from './lib/photoLoad.js'
import { buildPreloadQueue, collectPreloadPlan, isDataSaverEnabled, startSequentialPreload } from './lib/imagePreload.js'
import { createPaginationCache, makePaginationCacheKey } from './lib/paginationCache.js'
import { prefetchFullArticle } from './services/fullArticleService.js'
import { displayHeadline, readerSection } from './lib/editorial.js'
import { loadRecommendationProfile, rememberReading, rankRecommendations } from './lib/recommendationEngine.js'
import { handleReaderArrowKey } from './lib/readerKeyboard.js'
import {NEWS_LEVELS, NEWS_LEVEL_KEY, isNewsLevel, loadNewsLevel, applyNewsLevel} from './lib/newsLevels.js'
import { selectContextualMeaning } from './lib/contextualDictionary.js'
import { tokenizeWithGlossary } from './utils/dictionaryTokenizer.js'
import { buildSavedTokenSet, isTokenSaved } from './lib/savedWordsMatch.js'
import { loadLemmaMap, loadPhraseMap, lookupDictionaryTerm, resolveStaticPhrase, resolveTier1Glossary } from './services/dictionaryService.js'
import { createArticleReaderController, splitPageIntoSentences } from './lib/readerAudio.js'
import FullArticleModal from './components/FullArticleModal.jsx'
import {
  normalizeSavedWord,
  countWordStates,
  splitHighlightedContext,
  buildReviewDeckKeys,
  shuffleDeckKeys,
} from './lib/vocabStudy.js'
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
      <span className="level-label" aria-hidden="true">LEVEL</span>
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
function ArticlePhoto({ image, label: shortLabel, fullCaption, onBroken, onReady = () => {}, priority = 'high', background = false, photoVersion = 0 }) {
  const [asset, setAsset] = useState(() => {
    const known = photoResult(image)
    return known?.url ? known : null
  })
  const [zoomed, setZoomed] = useState(false)
  const [lightboxClosing, setLightboxClosing] = useState(false)
  const lightboxTimerRef = useRef(null)
  const retryTimerRef = useRef(null)
  const retryCountRef = useRef(0)
  const failedUrlsRef = useRef([])
  const mountedRef = useRef(true)
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
  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
      clearTimeout(lightboxTimerRef.current)
      clearTimeout(retryTimerRef.current)
    }
  }, [])
  useEffect(() => {
    retryCountRef.current = 0
    failedUrlsRef.current = []
    clearTimeout(retryTimerRef.current)
    retryTimerRef.current = null
  }, [image])
  useEffect(() => {
    let active = true
    const known = photoResult(image)
    if (known?.url) {
      setAsset(known)
      return () => { active = false }
    }
    if (!image) {
      setAsset(null)
      return () => { active = false }
    }
    if (background) {
      // Hidden adjacent (-1/+1) cards wait for the prioritized sequential preload
      // queue instead of firing competing parallel Wikimedia fetches or marking
      // images broken; promoting a card to active (background=false) loads
      // immediately at high priority if not yet ready.
      setAsset(null)
      return () => { active = false }
    }
    setAsset(null)
    const runAttempt = (attempt, skipUrls = []) => {
      if (attempt > 0) evictPhoto(image)
      resolvePhoto(image, {
        fetchPriority: priority,
        decode: true,
        cacheFailure: attempt > 0,
        skipUrls,
      }).then(result => {
        if (!active) return
        if (result?.url) {
          setAsset(result)
          onReady()
          return
        }
        if (attempt < 1) {
          retryCountRef.current = attempt + 1
          clearTimeout(retryTimerRef.current)
          retryTimerRef.current = setTimeout(() => {
            retryTimerRef.current = null
            if (!active) return
            runAttempt(attempt + 1, failedUrlsRef.current)
          }, 1500)
        } else {
          setAsset(result || { failed: true })
          onBroken?.(image)
        }
      })
    }
    // If a stale failed cache entry exists on a fresh foreground mount, evict
    // it so the initial attempt runs cleanly before giving up.
    if (known?.failed) evictPhoto(image)
    runAttempt(retryCountRef.current, failedUrlsRef.current)
    return () => {
      active = false
      clearTimeout(retryTimerRef.current)
      retryTimerRef.current = null
    }
  }, [image, background, photoVersion])
  useEffect(() => {
    if (!zoomed) return
    const closeOnEscape = event => { if (event.key === 'Escape') closeLightbox() }
    window.addEventListener('keydown', closeOnEscape)
    return () => window.removeEventListener('keydown', closeOnEscape)
  }, [zoomed, lightboxClosing])
  const handleImgError = () => {
    if (background || !image) return
    const badUrl = asset?.url || ''
    if (badUrl && !failedUrlsRef.current.includes(badUrl)) {
      failedUrlsRef.current = [...failedUrlsRef.current, badUrl]
    }
    evictPhoto(image)
    if (retryCountRef.current < 1) {
      retryCountRef.current += 1
      setAsset(null)
      clearTimeout(retryTimerRef.current)
      retryTimerRef.current = setTimeout(() => {
        retryTimerRef.current = null
        if (!mountedRef.current) return
        resolvePhoto(image, {
          fetchPriority: 'high',
          decode: true,
          cacheFailure: true,
          skipUrls: failedUrlsRef.current,
        }).then(result => {
          if (!mountedRef.current) return
          if (result?.url) {
            setAsset(result)
            onReady()
          } else {
            setAsset({ failed: true })
            onBroken?.(image)
          }
        })
      }, 1500)
    } else {
      setAsset({ failed: true })
      onBroken?.(image)
    }
  }
  if (!image) return null
  if (!asset) return <figure className="photo-figure lore-photo-figure hero-media hero-media-loading" aria-hidden="true"><div className="hero-photo-skeleton" /></figure>
  if (!asset.url) return null
  const heroWidth = asset.width || 1600
  const heroHeight = asset.height || 900
  return <><figure className="photo-figure lore-photo-figure hero-media">
    <img className="hero-photo" src={asset.url} alt={label} decoding="async" loading="eager" fetchPriority={priority}
      width={heroWidth} height={heroHeight} role="button" tabIndex={0}
      aria-label={`Enlarge image: ${label || 'article photo'}`}
      onClick={openLightbox}
      onKeyDown={event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); openLightbox() } }}
      onLoad={event => { fitPhoto(event.currentTarget); onReady() }}
      onError={handleImgError} />
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
      <img src={asset.url} alt={label} decoding="async" loading="eager" width={heroWidth} height={heroHeight} onClick={event => event.stopPropagation()} />
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
function layoutPages(item, reader, badImages = new Set(), staticPhrases = null, lemmaMap = null) {
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
  surface?.classList.remove('page-enter-left','page-enter-right','is-dragging','saga-page--dense','page-density-dense','page-density-dense-tight')
  if (surface) surface.style.transform = 'none'
  const heading = fixture.querySelector('.article-heading')
  const media = fixture.querySelector('.article-media')
  const paragraph = fixture.querySelector('.article-text')
  paragraph?.classList.remove('saga-level-settle')
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
  const h1 = heading.querySelector('h1')
  const titleText = displayHeadline(item)
  if (h1) {
    h1.textContent = titleText
    h1.classList.toggle('lore-headline-long', titleText.length > 45)
  }
  const deckText = editorialDeck(item)
  let deckEl = heading.querySelector('.deck')
  if (deckText) {
    if (!deckEl) {
      deckEl = document.createElement('p')
      deckEl.className = 'deck lore-deck'
      heading.appendChild(deckEl)
    }
    deckEl.textContent = deckText
  }
  reader.parentElement.appendChild(fixture)
  try {
    const sourcePages = item?.contentType === 'news' ? item.pages : (item._sourcePages || item.pages)
    const cleanSources = sourcePages.map(p =>
      badImages.has(p.image) ? {...p,image:'',caption:''} : p)
    const coverHasNoImage = item?.contentType === 'wiki'
      ? !cleanSources.some(p => p.image)
      : !cleanSources[0]?.image
    const measureMemo = new Map()
    const measure = ({text, cover:isCover, image, density = ''}) => {
      const memoKey = `${isCover ? 1 : 0}|${image?.image || ''}|${density}|${text}`
      const cached = measureMemo.get(memoKey)
      if (cached) return cached

      heading.classList.add('post-head')
      heading.classList.toggle('post-head--no-image', !image)
      heading.classList.toggle('post-head--cover-no-image', coverHasNoImage)
      heading.classList.toggle('post-head--continued', !isCover)
      heading.classList.toggle('article-heading-continued', !isCover)
      if (deckEl) deckEl.style.display = isCover && deckText ? '' : 'none'
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
        const figMaxStr = getComputedStyle(figure).maxHeight || ''
        const computedMax = figMaxStr.endsWith('px') ? parseFloat(figMaxStr) : NaN
        const maxHeight = Number.isFinite(computedMax) && computedMax > 0
          ? computedMax
          : Math.min(195, Math.max(138, window.innerHeight * 0.21))
        const ratio = asset?.width && asset?.height ? asset.width / asset.height : 4 / 3
        const measuredHeight = Math.min(maxHeight, media.clientWidth / ratio)
        const measuredWidth = Math.min(media.clientWidth, measuredHeight * ratio)
        figure.style.width = `${Math.round(measuredWidth)}px`
        figure.style.height = `${Math.round(measuredHeight)}px`
        photo.width = asset?.width || 1600
        photo.height = asset?.height || 900
        photo.style.width = `${Math.round(measuredWidth)}px`
        photo.style.height = `${Math.round(measuredHeight)}px`
      } else {
        figure.style.width = ''
        figure.style.height = ''
        photo.style.width = ''
        photo.style.height = ''
      }
      const fragment = document.createDocumentFragment()
      const paraList = splitParagraphs(String(text || ''))
      const blocks = paraList.length ? paraList : [String(text || '')]
      for (const blockText of blocks) {
        const pEl = document.createElement('p')
        pEl.className = 'article-paragraph'
        const rawTokens = tokenizeWithGlossary(blockText, item.glossary, staticPhrases, lemmaMap)
        const clustered = groupTokenClusters(rawTokens)
        for (const piece of clustered) {
          if (piece.kind === 'text') {
            pEl.appendChild(document.createTextNode(piece.text))
          } else if (piece.kind === 'cluster') {
            const cluster = document.createElement('span')
            cluster.className = 'saga-word-cluster'
            if (piece.leading) cluster.appendChild(document.createTextNode(piece.leading))
            const btn = document.createElement('button')
            btn.type = 'button'
            btn.className = 'word-token' + (piece.token.kind === 'phrase' ? ' phrase-token' : '')
            btn.textContent = piece.token.text
            cluster.appendChild(btn)
            if (piece.clinging) cluster.appendChild(document.createTextNode(piece.clinging))
            pEl.appendChild(cluster)
          } else {
            const btn = document.createElement('button')
            btn.type = 'button'
            btn.className = 'word-token' + (piece.token.kind === 'phrase' ? ' phrase-token' : '')
            btn.textContent = piece.token.text
            pEl.appendChild(btn)
          }
        }
        fragment.appendChild(pEl)
      }
      paragraph.replaceChildren(fragment)
      // Read V8: the pager has a fixed bottom position. Measure the text
      // against its TOP edge, not the pager's bottom (which no longer moves).
      // Reject overflow instead of silently hiding words behind navigation.
      const cardBounds = card.getBoundingClientRect()
      const surfaceBounds = surface ? surface.getBoundingClientRect() : cardBounds
      const textBounds = paragraph.getBoundingClientRect()
      const mediaBounds = media.getBoundingClientRect()
      const pagerBounds = pager.getBoundingClientRect()
      const viewportBottom = fixture.getBoundingClientRect().bottom
      const safeBottom = Math.min(pagerBounds.top, surfaceBounds.bottom) - 16
      const availableHeight = Math.max(1, safeBottom - cardBounds.top)
      const contentBottom = Math.max(textBounds.bottom, image ? mediaBounds.bottom : 0)
      const bottomWhitespacePx = Math.max(0, pagerBounds.top - contentBottom)
      const unusedVerticalPx = image
        ? bottomWhitespacePx
        : Math.max(0, (pagerBounds.top - cardBounds.top) - textBounds.height)
      const overflowPx = Math.max(0, textBounds.bottom - safeBottom)
      // The flex pager ends exactly at the reader's bottom; allow subpixel
      // rounding while keeping the entire paragraph block above the pager.
      const fitsPage = textBounds.height > 0 && textBounds.bottom <= safeBottom
        && (!image || mediaBounds.bottom <= safeBottom)
        && card.scrollHeight <= card.clientHeight + 2
        && pagerBounds.bottom <= viewportBottom + 1
      const measured = {
        fits: fitsPage,
        usedHeight: textBounds.height,
        availableHeight: Math.max(1, pagerBounds.top - (image ? surfaceBounds.top : cardBounds.top) - 8),
        cardAvailableHeight: availableHeight,
        bottomWhitespacePx,
        unusedVerticalPx,
        overflowPx,
      }
      measureMemo.set(memoKey, measured)
      return measured
    }
    const fits = candidate => measure(candidate).fits
    fits.measure = measure
    // Failed/corrupt thumbnails may not reserve visual space. Reflow their
    // article text immediately, without altering the original source pages.
    const next = item?.contentType === 'news'
      ? balancePhotoCoverPage(cleanSources, fits)
      : item?.contentType === 'wiki'
        ? planAnchoredWikiPages({...item,_sourcePages:cleanSources}, fits, {balanced: true, paragraphAware: true, measure})
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
    return Array.isArray(saved)
      ? saved.map(item => normalizeSavedWord(item, offlineMeaning(item?.word))).filter(Boolean)
      : []
  } catch { return [] }
}

function HighlightedContext({ sentence, word }) {
  const segments = splitHighlightedContext(sentence, word)
  return segments.map((seg, idx) =>
    seg.match
      ? <mark key={idx} className="saga-context-highlight">{seg.text}</mark>
      : <Fragment key={idx}>{seg.text}</Fragment>
  )
}

function Icon({ name, size = 24 }) {
  const paths = {
    book: <><path d="M12 6.5C9.5 4.6 6.5 4.2 3 5v14c3.5-.8 6.5-.4 9 1.5 2.5-1.9 5.5-2.3 9-1.5V5c-3.5-.8-6.5-.4-9 1.5Z"/><path d="M12 6.5v14"/></>,
    bookmark: <path d="M6 3.5h12v17l-6-4-6 4v-17Z"/>,
    layers: <><rect x="4" y="5" width="16" height="14" rx="2"/><path d="M8 9h8M8 13h5"/></>,
    left: <path d="m14 5-7 7 7 7"/>, right: <path d="m10 5 7 7-7 7"/>,
    close: <path d="M5 5l14 14M19 5 5 19"/>, check: <path d="m5 12 4 4L19 6"/>,
    volume: <><path d="M4 9v6h4l5 4V5L8 9H4Z"/><path d="M17 9a5 5 0 0 1 0 6"/></>,
    shuffle: <><path d="M16 3h5v5"/><path d="M4 20 21 3"/><path d="M21 16v5h-5"/><path d="M15 15l6 6"/><path d="M4 4l5 5"/></>,
    search: <><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></>,
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
  const [fontVersion, setFontVersion] = useState(0)
  useEffect(() => {
    const fonts = typeof document !== 'undefined' ? document.fonts : null
    if (!fonts) return undefined
    let active = true
    const bump = () => { if (active) setFontVersion(v => v + 1) }
    fonts.ready?.then(bump).catch(() => {})
    fonts.addEventListener?.('loadingdone', bump)
    return () => {
      active = false
      fonts.removeEventListener?.('loadingdone', bump)
    }
  }, [])
  const [showCredits, setShowCredits] = useState(false)
  const [fullArticleStory, setFullArticleStory] = useState(null)
  const fullArticleOpen = Boolean(fullArticleStory)
  const markBrokenImage = image => {
    if (!image) return
    setBrokenImages(previous => {
      if (previous.has(image)) return previous
      const next = new Set(previous)
      next.add(image)
      return next
    })
  }
  useEffect(() => {
    setBrokenImages(previous => (previous.size ? new Set() : previous))
  }, [storyIndex, readingLevel])
  const [selected, setSelected] = useState('')
  const [selectedSurface, setSelectedSurface] = useState('')
  const [selectedGlossaryEntry, setSelectedGlossaryEntry] = useState(null)
  const [selectedSentenceOverride, setSelectedSentenceOverride] = useState('')
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
  const [reviewMode, setReviewMode] = useState('learning')
  const [reviewDeck, setReviewDeck] = useState(() => buildReviewDeckKeys(words, 'learning'))
  const [reviewIndex, setReviewIndex] = useState(0)
  const [revealed, setRevealed] = useState(false)
  const [finished, setFinished] = useState(false)
  const [reviewMotion, setReviewMotion] = useState('idle')
  const [reviewExitDir, setReviewExitDir] = useState('left')
  const [reviewSwipe, setReviewSwipe] = useState({ dx: 0, phase: 'idle' })
  const reviewTimerRef = useRef(null)
  const reviewReturnTimerRef = useRef(null)
  const reviewDragRef = useRef(null)
  const suppressReviewClickRef = useRef(false)
  const suppressReviewTimerRef = useRef(null)
  const gesture = useRef(null)
  const suppressWordClick = useRef(false)
  const wheelLock = useRef(0)
  const wheelAccum = useRef(0)
  const pointerGesture = useRef(null)
  const lastNavigationGesture = useRef(0)
  const [slide, setSlide] = useState(null)
  const slideTimer = useRef(null)
  const toggleWordMastered = word => {
    if (!word) return
    setWords(current =>
      current.map(item =>
        item.word === word ? { ...item, mastered: !item.mastered } : item
      )
    )
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
      setReviewDeck(prev => prev.filter(key => key !== word))
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
    clearTimeout(reviewReturnTimerRef.current)
    clearTimeout(suppressReviewTimerRef.current)
    clearTimeout(slideTimer.current)
    removeTimersRef.current.forEach(timer => clearTimeout(timer))
    removeTimersRef.current.clear()
  }, [])
  useEffect(() => {
    if (tab !== 'read') articleReaderRef.current?.stop()
  }, [tab])
  const story = stories[storyIndex] || null
  const currentPage = story?.pages?.[page] || null
  const paginationCacheRef = useRef(null)
  if (!paginationCacheRef.current) {
    paginationCacheRef.current = createPaginationCache(120)
  }

  const getStoryMediaSig = (item, badImages) => {
    const src = item?.contentType === 'news' ? item.pages : (item?._sourcePages || item?.pages || [])
    return src
      .map(p => {
        if (!p?.image) return ''
        if (badImages?.has?.(p.image)) return 'X'
        const asset = photoResult(p.image)
        if (!asset) return 'P'
        if (asset.failed) return 'X'
        return `${asset.width || 0}x${asset.height || 0}`
      })
      .filter(Boolean)
      .join(',')
  }

  const getStoryContentSig = item => {
    const src = item?.contentType === 'news' ? item.pages : (item?._sourcePages || item?.pages || [])
    const headline = displayHeadline(item)
    let hash = 2166136261
    const feedStr = `${headline}\u0001${src.map(p => `${p?.image || ''}\u0002${p?.text || ''}`).join('\u0003')}`
    for (let i = 0; i < feedStr.length; i++) {
      hash ^= feedStr.charCodeAt(i)
      hash = Math.imul(hash, 16777619)
    }
    return `${src.length}:${(hash >>> 0).toString(36)}`
  }

  const getCachedOrLayoutPages = (item, reader, badImages, levelOverride = null) => {
    if (!item || !reader) return item?.pages || []
    const bounds = reader.getBoundingClientRect()
    if (bounds.width < 100 || bounds.height < 220) return item.pages
    const key = makePaginationCacheKey({
      storyId: storyId(item),
      readingLevel: levelOverride || readingLevelRef.current,
      colWidth: bounds.width,
      colHeight: bounds.height,
      mediaSig: getStoryMediaSig(item, badImages),
      contentSig: getStoryContentSig(item),
      fontVersion,
      brokenKey: `${staticPhrases ? 1 : 0}:${lemmaMap ? 1 : 0}`,
    })
    const cached = paginationCacheRef.current.get(key)
    if (cached) return cached
    const measured = layoutPages(item, reader, badImages, staticPhrases, lemmaMap)
    if (Array.isArray(measured) && measured.length) {
      paginationCacheRef.current.set(key, measured)
    }
    return measured
  }

  const pagesSignature = pages =>
    (Array.isArray(pages) ? pages : []).map(p => `${p.image}|${p.density || ''}|${p.text}`).join('\u0000')

  const changeReadingLevel = level => {
    if (!isNewsLevel(level) || level === readingLevel) return
    stopSpeech()
    const prevStory = stories[storyIndex] || null
    const prevPages = prevStory?.pages || []
    const prevPageIndex = page
    readingLevelRef.current = level
    setReadingLevel(level)
    try { localStorage.setItem(NEWS_LEVEL_KEY, level) } catch { /* private mode */ }
    const reader = document.querySelector('.story-layer:not(.outgoing) .reader-gesture')
    let targetPages = null
    const nextStories = stories.map((item, idx) => {
      if (!item.levelVariants) return item
      const leveled = paginateStory(applyNewsLevel(item, level))
      if (idx === storyIndex && reader) {
        const measured = getCachedOrLayoutPages(leveled, reader, brokenImages, level)
        targetPages = measured
        return { ...leveled, pages: measured }
      }
      if (idx === storyIndex) targetPages = leveled.pages
      return leveled
    })
    setStories(nextStories)
    if (targetPages && targetPages.length) {
      setPage(mapSemanticPageIndex(prevPages, prevPageIndex, targetPages))
    } else {
      setPage(0)
    }
    setPageMotion(null)
    setLevelSettleKey(k => k + 1)
  }

  // Recalculate before paint when dimensions change; hit pagination cache in O(1)
  // when already warmed for (storyId, readingLevel, rounded viewport size).
  useLayoutEffect(() => {
    if (tab !== 'read' || !story) return
    let frame = 0
    let observer
    let cancelled = false
    const applyLayout = () => {
      if (cancelled) return
      const reader = document.querySelector('.story-layer:not(.outgoing) .reader-gesture')
      if (!reader) return
      fitPhoto(reader.querySelector('.article-media img'))
      const next = getCachedOrLayoutPages(story, reader, brokenImages)
      if (pagesSignature(story.pages) !== pagesSignature(next)) {
        const previousPages = story.pages
        setStories(old => old.map((item, i) => i === storyIndex ? { ...item, pages: next } : item))
        setPage(p => mapSemanticPageIndex(previousPages, p, next))
      }
    }
    const recalculate = () => {
      cancelAnimationFrame(frame)
      frame = requestAnimationFrame(applyLayout)
    }
    // Check synchronously before paint so cached/warmed stories never flash or reflow.
    applyLayout()
    const viewport = document.querySelector('.story-viewport')
    if (viewport && typeof ResizeObserver !== 'undefined') {
      observer = new ResizeObserver(recalculate)
      observer.observe(viewport)
    }
    window.addEventListener('resize', recalculate)
    window.visualViewport?.addEventListener('resize', recalculate)
    document.fonts?.ready.then(recalculate).catch(() => {})
    return () => { cancelled = true; cancelAnimationFrame(frame); observer?.disconnect(); window.removeEventListener('resize', recalculate); window.visualViewport?.removeEventListener('resize', recalculate) }
  }, [tab, storyIndex, stories.length, readingLevel, story?._sourcePages, story?.pages, brokenImages, photoVersion, fontVersion, staticPhrases, lemmaMap])

  // Layer 3 idle warming: pre-compute exact balanced pagination for storyIndex + 1
  // (and storyIndex - 1 if uncached) during idle time so vertical swipes never reflow.
  useEffect(() => {
    if (tab !== 'read' || !stories.length) return undefined
    let cancelled = false
    const warmAdjacent = () => {
      if (cancelled) return
      const reader =
        document.querySelector('.story-layer:not(.outgoing) .reader-gesture:has(.article-heading)') ||
        document.querySelector('.story-layer-adjacent.story-layer-next .reader-gesture') ||
        document.querySelector('.story-layer:not(.outgoing) .reader-gesture')
      if (!reader) return
      const targets = [storyIndex + 1, storyIndex - 1].filter(
        idx => idx >= 0 && idx < storiesRef.current.length
      )
      const updates = new Map()
      for (const idx of targets) {
        const targetStory = storiesRef.current[idx]
        if (!targetStory) continue
        const measured = getCachedOrLayoutPages(targetStory, reader, brokenImages)
        if (measured && pagesSignature(targetStory.pages) !== pagesSignature(measured)) {
          updates.set(idx, measured)
        }
      }
      if (!cancelled && updates.size) {
        setStories(old => {
          let changed = false
          const nextList = old.map((item, idx) => {
            const warmed = updates.get(idx)
            if (!warmed || pagesSignature(item.pages) === pagesSignature(warmed)) return item
            changed = true
            return { ...item, pages: warmed }
          })
          return changed ? nextList : old
        })
      }
    }
    let handle = null
    if (typeof window !== 'undefined' && typeof window.requestIdleCallback === 'function') {
      handle = window.requestIdleCallback(warmAdjacent, { timeout: 600 })
      return () => {
        cancelled = true
        window.cancelIdleCallback?.(handle)
      }
    }
    handle = setTimeout(warmAdjacent, 120)
    return () => {
      cancelled = true
      clearTimeout(handle)
    }
  }, [tab, storyIndex, stories.length, readingLevel, brokenImages, photoVersion, fontVersion])

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
          target:Math.min(BUFFER_TARGET,Math.max(newIds.length,urgent?1:Math.max(1,BUFFER_TARGET-remaining))),urgent,
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
    const remaining = queuedUnread(stories.length, storyIndex)
    const low = lowOnStories(remaining)
    const enteredLow = low && !wasLowOnStoriesRef.current
    // Layer 1: early JSON shard prefetch whenever within 4 stories of the end
    const nearShardEdge = remaining <= 4
    const enteredCritical = nearShardEdge && !wasCriticalOnStoriesRef.current
    wasLowOnStoriesRef.current = low
    wasCriticalOnStoriesRef.current = nearShardEdge
    if (feedBusy.current && (enteredLow || enteredCritical)) checkAfterBusyRef.current = true
    // Silently prefetch and append the next shard when within 4 stories of the end
    // and more shards remain in manifest.json.
    if (!feedLoading && !feedBusy.current && nearShardEdge && (!feedDone || hasUnfetchedShards(poolsRef.current))) {
      loadFeed({ forceCheck: false })
    } else if (!feedLoading && !feedBusy.current && low &&
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
  const selectedSentence = selectedSentenceOverride || (tab === 'words' && selectedSaved?.sentence) || sentenceParts.find(sentence => {
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
    setSelectedSentenceOverride('')
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
        storyTitle: existing?.storyTitle || (fullArticleStory ? displayHeadline(fullArticleStory) : tab === 'read' && story ? displayHeadline(story) : ''),
        mastered: existing?.mastered ?? false,
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
    if (!story || !Array.isArray(story.pages) || story.pages.length === 0) return
    const startPage = page >= story.pages.length ? 0 : page
    if (startPage !== page) {
      setPageMotion(null)
      setPage(startPage)
    }
    articleReaderRef.current?.start({
      pages: story.pages,
      startPage,
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
    if (typeof document !== 'undefined') {
      document.querySelectorAll('.story-layer-adjacent').forEach(node => {
        node.style.transition = ''
        node.style.transform = ''
      })
    }
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
    document.querySelectorAll('.story-layer-adjacent').forEach(node => {
      node.style.transition = 'none'
    })
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
      const nextLayer = document.querySelector('.story-layer-adjacent.story-layer-next')
      const prevLayer = document.querySelector('.story-layer-adjacent.story-layer-prev')
      if (ty < 0 && nextLayer) {
        nextLayer.style.transition = 'none'
        nextLayer.style.transform = `translate3d(0, calc(100% + ${ty}px), 0)`
        if (prevLayer) {
          prevLayer.style.transition = 'none'
          prevLayer.style.transform = 'translate3d(0, -100%, 0)'
        }
      } else if (ty > 0 && prevLayer) {
        prevLayer.style.transition = 'none'
        prevLayer.style.transform = `translate3d(0, calc(-100% + ${ty}px), 0)`
        if (nextLayer) {
          nextLayer.style.transition = 'none'
          nextLayer.style.transform = 'translate3d(0, 100%, 0)'
        }
      }
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
    const nextLayer = document.querySelector('.story-layer-adjacent.story-layer-next')
    if (nextLayer && nextLayer.style.transform) {
      nextLayer.style.transition = transitionVal
      nextLayer.style.transform = spring ? 'translate3d(0, 100%, 0)' : ''
      if (!spring) nextLayer.style.transition = ''
    }
    const prevLayer = document.querySelector('.story-layer-adjacent.story-layer-prev')
    if (prevLayer && prevLayer.style.transform) {
      prevLayer.style.transition = transitionVal
      prevLayer.style.transform = spring ? 'translate3d(0, -100%, 0)' : ''
      if (!spring) prevLayer.style.transition = ''
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
    if (event.pointerType !== 'touch' || selected || fullArticleOpen || event.target.closest('button, a, summary, select, label')) return
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
  const wordsByKey = useMemo(() => new Map(words.map(w => [w.word, w])), [words])
  const wordCounts = useMemo(() => countWordStates(words), [words])
  const effectiveReviewDeck = useMemo(
    () => reviewDeck.filter(key => wordsByKey.has(key)),
    [reviewDeck, wordsByKey]
  )
  const activeReviewKey = effectiveReviewDeck.length
    ? effectiveReviewDeck[Math.min(reviewIndex, effectiveReviewDeck.length - 1)]
    : null
  const activeReviewWord = activeReviewKey ? (wordsByKey.get(activeReviewKey) || null) : null
  const activeReviewMeaning = activeReviewWord
    ? (activeReviewWord.definition || offlineMeaning(activeReviewWord.word) || 'No definition yet. Open this word in Words to retry.')
    : ''

  const resetReviewSwipe = () => {
    clearTimeout(reviewReturnTimerRef.current)
    reviewDragRef.current = null
    setReviewSwipe({ dx: 0, phase: 'idle' })
  }

  const startReviewSession = (mode = 'learning', { shuffle = false, sourceWords = words } = {}) => {
    clearTimeout(reviewTimerRef.current)
    resetReviewSwipe()
    const keys = buildReviewDeckKeys(sourceWords, mode)
    const nextDeck = shuffle ? shuffleDeckKeys(keys) : keys
    setReviewMode(mode)
    setReviewDeck(nextDeck)
    setReviewIndex(0)
    setRevealed(false)
    setFinished(false)
    setReviewMotion(nextDeck.length ? 'entering' : 'idle')
    if (nextDeck.length && !prefersReducedMotion()) {
      reviewTimerRef.current = setTimeout(() => setReviewMotion('idle'), SWIPE_SETTLE_MS)
    }
  }

  const shuffleCurrentReview = () => {
    if (effectiveReviewDeck.length < 2) return
    clearTimeout(reviewTimerRef.current)
    resetReviewSwipe()
    setReviewDeck(shuffleDeckKeys(effectiveReviewDeck))
    setReviewIndex(0)
    setRevealed(false)
    setFinished(false)
    setReviewMotion('entering')
    if (!prefersReducedMotion()) {
      reviewTimerRef.current = setTimeout(() => setReviewMotion('idle'), SWIPE_SETTLE_MS)
    }
  }

  const handleReviewOutcome = (markMastered, { direction } = {}) => {
    if (reviewMotion === 'leaving' || !activeReviewWord) return
    const targetKey = activeReviewWord.word
    const exitDirection = direction || (markMastered ? 'right' : 'left')
    resetReviewSwipe()
    setReviewExitDir(exitDirection)
    setWords(current =>
      current.map(item =>
        item.word === targetKey ? { ...item, mastered: Boolean(markMastered) } : item
      )
    )
    const deckLen = effectiveReviewDeck.length
    const advanceNow = () => {
      if (reviewIndex + 1 >= deckLen) {
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
      setReviewMotion('leaving')
      clearTimeout(reviewTimerRef.current)
      reviewTimerRef.current = setTimeout(advanceNow, 110)
      return
    }
    setReviewMotion('leaving')
    clearTimeout(reviewTimerRef.current)
    reviewTimerRef.current = setTimeout(advanceNow, REVIEW_GLIDE_MS)
  }

  const onReviewPointerDown = event => {
    if (reviewMotion === 'leaving' || !activeReviewWord) return
    if (event.pointerType === 'mouse' && event.button !== 0) return
    if (event.target?.closest?.('.review-card-speak')) return
    clearTimeout(reviewReturnTimerRef.current)
    clearTimeout(suppressReviewTimerRef.current)
    suppressReviewClickRef.current = false
    const now = performance.now()
    reviewDragRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      lastX: event.clientX,
      lastTime: now,
      vx: 0,
      axis: null,
      moved: false,
    }
  }

  const onReviewPointerMove = event => {
    const state = reviewDragRef.current
    if (!state || state.pointerId !== event.pointerId) return
    const dx = event.clientX - state.startX
    const dy = event.clientY - state.startY
    const now = performance.now()
    const dt = Math.max(1, now - state.lastTime)
    state.vx = state.vx * 0.35 + ((event.clientX - state.lastX) / dt) * 0.65
    state.lastX = event.clientX
    state.lastTime = now
    if (!state.axis) {
      if (Math.abs(dx) >= 10 && Math.abs(dx) >= Math.abs(dy)) {
        state.axis = 'x'
        state.moved = true
        try { event.currentTarget.setPointerCapture?.(event.pointerId) } catch { /* synthetic event */ }
      } else if (Math.abs(dy) >= 12 && Math.abs(dy) > Math.abs(dx)) {
        state.axis = 'y'
        return
      }
    }
    if (state.axis === 'x') {
      setReviewSwipe({ dx, phase: 'dragging' })
    }
  }

  const finishReviewPointer = (event, cancelled = false) => {
    const state = reviewDragRef.current
    if (!state || state.pointerId !== event.pointerId) return
    reviewDragRef.current = null
    try {
      if (event.currentTarget.hasPointerCapture?.(event.pointerId)) {
        event.currentTarget.releasePointerCapture(event.pointerId)
      }
    } catch { /* synthetic event */ }
    if (state.axis !== 'x') return
    suppressReviewClickRef.current = true
    clearTimeout(suppressReviewTimerRef.current)
    suppressReviewTimerRef.current = setTimeout(() => {
      suppressReviewClickRef.current = false
    }, 90)
    const dx = event.clientX - state.startX
    const vx = state.vx
    if (!cancelled && (dx >= 80 || (dx > 28 && vx >= 0.45))) {
      handleReviewOutcome(true, { direction: 'right' })
      return
    }
    if (!cancelled && (dx <= -80 || (dx < -28 && vx <= -0.45))) {
      handleReviewOutcome(false, { direction: 'left' })
      return
    }
    setReviewSwipe({ dx: 0, phase: 'returning' })
    clearTimeout(reviewReturnTimerRef.current)
    reviewReturnTimerRef.current = setTimeout(() => {
      setReviewSwipe({ dx: 0, phase: 'idle' })
    }, prefersReducedMotion() ? 20 : 460)
  }

  const onReviewCardClick = event => {
    if (event.target?.closest?.('.review-card-speak')) return
    if (suppressReviewClickRef.current) {
      suppressReviewClickRef.current = false
      return
    }
    if (reviewMotion === 'leaving') return
    setRevealed(r => !r)
  }
  // Treat word buttons as part of the reading surface, not as navigation controls.
  // This makes swiping across the paragraph work on touch screens.
  const startGesture = event => {
    if (event.touches.length !== 1 || selected || fullArticleOpen) { gesture.current = null; return }
    const scrollSurface = event.target.closest('.page-surface')
    if (scrollSurface && scrollSurface.scrollHeight > scrollSurface.clientHeight + 2) { gesture.current = null; return }
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
    if (!gesture.current || selected || fullArticleOpen) return
    const state = gesture.current
    gesture.current = null
    const t = event.changedTouches[0]
    finishNavigationGesture(state, t.clientX, t.clientY)
  }
  const cancelGesture = () => { gesture.current = null; releaseSwipeTransform({ spring: true }); suppressWordClick.current = false }
  const onWordClick = (event, word, glossaryEntry = null, surfaceText = '', sentenceText = '') => {
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
    setSelectedSentenceOverride(String(sentenceText || '').trim())
    setSelected(word)
  }
  // Layer 2: Polite sequential image preload + decode (concurrency = 1, 250ms pause)
  // prioritized as: +1 next lead -> current remaining pages -> +2 lead -> -1 lead.
  // Cancels any queued items immediately when storyIndex changes, and never
  // poisons photoLoad/brokenImages cache on background preload failure.
  useEffect(() => {
    if (tab !== 'read' || !story) return undefined
    let active = true
    const plan = collectPreloadPlan(stories, storyIndex, { brokenImages })
    const queue = buildPreloadQueue(plan)
    if (!queue.length) return undefined
    const nextLead = plan.upcomingLeads[0] || ''
    const controller = startSequentialPreload(queue, {
      pauseMs: 250,
      onItemDone: (url, result, meta) => {
        if (!active || meta?.alreadyReady || !result?.url) return
        if (url === nextLead || url === plan.previousLead || plan.currentRemaining.includes(url)) {
          setPhotoVersion(n => n + 1)
        }
      },
    })
    return () => {
      active = false
      controller.cancel()
    }
  }, [tab, storyIndex, stories, brokenImages])

  // Bonus: Silently prefetch the Wikipedia full article when the user reaches
  // the closing card (skipped when Data Saver / slow-2g is active).
  useEffect(() => {
    if (tab !== 'read' || !story) return
    if (page !== story.pages.length) return
    if (isDataSaverEnabled()) return
    prefetchFullArticle({
      sourceTitle: story.sourceTitle,
      sourcePageId: story.sourcePageId,
      title: displayHeadline(story),
    })
  }, [tab, story, page])
  // V20.1: refresh the keyboard handler whenever the page changes. V20
  // omitted `page` from the dependencies, so ArrowRight kept reading a stale
  // page index (often page 0) and could not progress beyond page 2.
  useEffect(() => {
    const onKey = event => handleReaderArrowKey(event, {
      enabled: tab === 'read' && !selected && !showCredits && !fullArticleOpen && !!story,
      onNextPage: () => changePage(1),
      onPrevPage: () => changePage(-1),
      onNextStory: () => changeStory(1),
      onPrevStory: () => changeStory(-1),
    })
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [tab, selected, showCredits, fullArticleOpen, page, storyIndex, story?.pages?.length, stories.length])

  useEffect(() => {
    if (tab !== 'review' || selected || showCredits || finished || !activeReviewWord) return
    const onReviewKey = event => {
      if (event.metaKey || event.ctrlKey || event.altKey) return
      const tag = event.target?.tagName
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return
      if (event.key === ' ' || event.key === 'Enter') {
        if (event.target?.closest?.('.review-card-speak, .review-shuffle-btn, .review-hint-trigger')) return
        event.preventDefault()
        setRevealed(r => !r)
      } else if (event.key === 'ArrowLeft') {
        event.preventDefault()
        handleReviewOutcome(false, { direction: 'left' })
      } else if (event.key === 'ArrowRight') {
        event.preventDefault()
        handleReviewOutcome(true, { direction: 'right' })
      }
    }
    window.addEventListener('keydown', onReviewKey)
    return () => window.removeEventListener('keydown', onReviewKey)
  }, [tab, selected, showCredits, finished, activeReviewWord, reviewIndex, effectiveReviewDeck.length, reviewMotion])

  // Desktop: wheel navigates stories instead of scrolling the reading screen.
  const onReaderWheel = event => {
    if (selected || fullArticleOpen || event.ctrlKey) return
    const surface = event.target.closest?.('.page-surface')
    if (surface && surface.scrollHeight > surface.clientHeight + 2) return
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
  const renderStory = (item, index, pageNumber, interactive, { imagePriority = interactive ? 'high' : 'low' } = {}) => {
    const closing = pageNumber === item.pages.length
    const itemPage = closing ? null : (item.pages[pageNumber] || item.pages[0])
    const highlightActive = Boolean(interactive && articlePlaying && activeSentenceIndex !== null)
    const pagePhotoMissing = !itemPage?.image || brokenImages.has(itemPage.image)
    const coverPhotoMissing = !item.pages[0]?.image || brokenImages.has(item.pages[0].image)
    const pageHasPhoto = Boolean(!closing && !pagePhotoMissing)
    const dotTotal = item.pages.length
    const topicLabel = readerSection(item).replace(/^DISCOVER\s*·\s*/i, '').trim()
    const handleReadFullArticleClick = event => {
      if (!interactive || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0) return
      event.preventDefault()
      stopSpeech()
      setFullArticleStory(item)
    }
    return <div className="reader-gesture" aria-hidden={!interactive} onTouchStart={interactive ? startGesture : undefined} onTouchMove={interactive ? moveGesture : undefined} onTouchEnd={interactive ? endGesture : undefined} onTouchCancel={interactive ? cancelGesture : undefined} onPointerDown={interactive ? startPointer : undefined} onPointerMove={interactive ? movePointer : undefined} onPointerUp={interactive ? endPointer : undefined} onPointerCancel={interactive ? () => {pointerGesture.current = null; releaseSwipeTransform({ spring: true })} : undefined}>
      <header className="topbar lore-reader-topbar">
        <div className="saga-topbar-slot saga-topbar-left">
          {interactive && item.levelVariants && (
            <LevelSegmentedControl readingLevel={readingLevel} onChange={changeReadingLevel} />
          )}
        </div>
        <span className="saga-toolbar-story" title={topicLabel}>{topicLabel}</span>
        <div className="saga-topbar-slot saga-topbar-right">
          {interactive && <button type="button" className={'icon-button saga-toolbar-audio' + (articlePlaying ? ' is-speaking' : '')} onClick={toggleArticleAudio} aria-pressed={articlePlaying} aria-label={articlePlaying ? 'Stop reading aloud' : 'Read aloud'} title={articlePlaying ? 'Stop reading aloud' : 'Read aloud'}><span className="audio-label" aria-hidden="true">{articlePlaying ? 'STOP' : 'LISTEN'}</span><Icon name="volume" size={18}/></button>}
        </div>
      </header>
      <div key={`${index}:${pageNumber}`} className={'page-surface ' + (!closing && !pageHasPhoto ? 'saga-page--text-only ' : '') + (itemPage?.density ? `page-density-${itemPage.density} ` : '') + (interactive && pageMotion ? (pageMotion > 0 ? 'page-enter-left' : 'page-enter-right') : '')}>
      {closing ? <section className="story-end" aria-label="Article completed">
        <div className="story-end-center"><Icon name="book" size={56}/><h2>That's the short version.</h2>
          {safeStoryUrl(item.sourceUrl) && <a className="story-end-cta" href={safeStoryUrl(item.sourceUrl)} target="_blank" rel="noopener noreferrer" onClick={handleReadFullArticleClick}>Read the full article</a>}
        </div><div className="story-end-next">Swipe up for the next story</div>
      </section> : <>
      <div className={'post-head article-heading lore-article-heading ' + (pagePhotoMissing ? 'post-head--no-image ' : '') + (coverPhotoMissing ? 'post-head--cover-no-image ' : '') + (pageNumber > 0 ? 'post-head--continued ' : '') + (pageNumber > 0 && item.contentType !== 'news' ? 'article-heading-continued' : '')}>
        <h1 className={displayHeadline(item).length > 45 ? 'lore-headline-long' : ''} title={displayHeadline(item)} aria-live={item.contentType === 'news' ? 'polite' : undefined}>{displayHeadline(item)}</h1>
        {pageNumber === 0 && editorialDeck(item) && <p className="deck lore-deck">{editorialDeck(item)}</p>}
      </div>
      <div className={"article-media " + (pagePhotoMissing ? "article-media-empty" : "")}>
        <ArticlePhoto key={itemPage.image || 'no-photo'} image={pagePhotoMissing ? '' : itemPage.image}
          label={photoLabel(itemPage)} fullCaption={itemPage.caption} priority={imagePriority} background={!interactive} photoVersion={photoVersion}
          onBroken={interactive ? markBrokenImage : undefined}
          onReady={interactive ? () => setPhotoVersion(n => n + 1) : undefined} />
      </div>
      <section className={'reading-card ' + (pagePhotoMissing ? 'reading-card-no-photo' : 'reading-card-with-photo')}><div className="reading-topline" aria-hidden="true" />
        <div key={levelSettleKey ? `lvl-${levelSettleKey}` : 'lvl-0'} className={'article-text' + (levelSettleKey > 0 ? ' saga-level-settle' : '')}>{(() => {
          const paraBlocks = splitParagraphs(itemPage.text)
          const blocks = paraBlocks.length ? paraBlocks : [itemPage.text || '']
          let runningSentenceIdx = 0
          return blocks.map((blockText, pIdx) => {
            const blockSentences = splitPageIntoSentences(blockText)
            return <p key={pIdx} className="article-paragraph">{blockSentences.map((seg, localIdx) => {
              const sIdx = runningSentenceIdx++
              const [, leading, core, trailing] = seg.match(/^(\s*)([\s\S]*?)(\s*)$/) || ['', '', seg, '']
              const tokens = core ? tokenizeWithGlossary(core, item.glossary, staticPhrases, lemmaMap) : []
              const clustered = groupTokenClusters(tokens)
              const isCurrentSentence = highlightActive && activeSentenceIndex === sIdx
              const isDimmedSentence = highlightActive && activeSentenceIndex !== sIdx
              const sentenceClass = 'saga-sentence' + (isCurrentSentence ? ' saga-sentence--active' : '') + (isDimmedSentence ? ' saga-sentence--dimmed' : '')
              const renderWordButton = (token, key) => {
                const saved = isTokenSaved(token, savedTokenSet, lemmaMap)
                const newlySaved = Boolean(saved && justSavedWord && (String(token.lookupKey || '').toLowerCase() === justSavedWord || String(token.text || '').toLowerCase() === justSavedWord))
                return <button key={key} type="button" disabled={!interactive} className={'word-token ' + (token.kind === 'glossary' ? 'glossary-token ' : token.kind === 'phrase' ? 'phrase-token' : '') + (saved ? 'known ' : '') + (newlySaved ? 'just-saved' : '')} onClick={event => onWordClick(event, token.lookupKey, token.entry, token.text)}>{token.text}</button>
              }
              return <Fragment key={localIdx}>{leading}{core && <span className={sentenceClass} data-sentence-index={sIdx}>{clustered.map((piece, i) => {
                if (piece.kind === 'text') return piece.text
                if (piece.kind === 'cluster') {
                  return <span key={i} className="saga-word-cluster">{piece.leading || ''}{renderWordButton(piece.token)}{piece.clinging || ''}</span>
                }
                return renderWordButton(piece.token, i)
              })}</span>}{trailing}</Fragment>
            })}</p>
          })
        })()}</div>
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
      </div>
    </div>
  }
  const sheetDepthActive = Boolean(tab === 'read' && selected && !sheetClosing)
  const openTab = key => {
    if (key === 'read' && tab === 'read' && story && storyIndex === stories.length - 1) {
      changeStory(1)
      return
    }
    setTabSwitchedToRead(key === 'read' && tab !== 'read')
    if (key === 'review' && tab !== 'review') {
      startReviewSession('learning', { sourceWords: words })
    }
    setTab(key)
    closeDictionary({ immediate: true })
  }
  return (
    <div className={"app-shell " + (tab === "read" ? "reading-mode lore-editorial-v5" : "")}>
      <main className="app-content">
        {tab === 'read' && <div className={'story-viewport' + (sheetDepthActive ? ' is-depth-scaled' : '') + (tabSwitchedToRead ? ' saga-tab-enter' : '')} onWheel={onReaderWheel}>
          {(() => {
            const windowIndices = []
            if (storyIndex > 0 && stories[storyIndex - 1]) windowIndices.push(storyIndex - 1)
            if (stories[storyIndex]) windowIndices.push(storyIndex)
            if (storyIndex + 1 < stories.length && stories[storyIndex + 1]) windowIndices.push(storyIndex + 1)
            if (slide && stories[slide.from] && !windowIndices.includes(slide.from)) {
              windowIndices.unshift(slide.from)
            }
            return windowIndices.map(idx => {
              const item = stories[idx]
              const isActive = idx === storyIndex
              const isOutgoing = Boolean(slide && slide.from === idx && !isActive)
              const isPrev = !isActive && !isOutgoing && idx < storyIndex
              const cardKey = `story-card-${idx}-${storyId(item)}`
              let className = 'story-layer'
              if (isActive) {
                className += ' ' + (slide ? (slide.direction > 0 ? 'enter-from-bottom' : 'enter-from-top') : (initialStoryReveal ? 'story-layer--reveal' : ''))
              } else if (isOutgoing) {
                className += ' outgoing ' + (slide.direction > 0 ? 'slide-up' : 'slide-down')
              } else {
                className = 'story-layer-adjacent ' + (isPrev ? 'story-layer-prev' : 'story-layer-next')
              }
              const pageNum = isActive ? page : (isOutgoing ? slide.fromPage : 0)
              return (
                <div
                  key={cardKey}
                  className={className.trim()}
                  data-story-slot={isActive ? '0' : isOutgoing ? 'outgoing' : (isPrev ? '-1' : '+1')}
                  data-story-index={idx}
                  aria-hidden={!isActive || undefined}
                >
                  {renderStory(item, idx, pageNum, isActive, { imagePriority: isActive ? 'high' : 'low' })}
                </div>
              )
            })
          })()}
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
        {tab === 'words' && (
          <div key="tab-words" className="saga-tab-panel saga-tab-panel--words">
            <header className="section-header words-header">
              <h1>Saved words<span className="period">.</span></h1>
              {words.length > 0 && (
                <p className="saga-tab-meta">
                  {words.length} {words.length === 1 ? 'word' : 'words'} saved
                </p>
              )}
            </header>
            {words.length === 0 ? (
              <div className="empty">
                <Icon name="bookmark" size={40}/>
                <h2>Your collection begins here.</h2>
                <p>Read a story, tap a word, and save it to keep learning.</p>
                <button className="primary" onClick={() => { setTabSwitchedToRead(true); setTab('read') }}>Start reading →</button>
              </div>
            ) : (
              <div className="saved-list">
                {words.map((item, idx) => {
                  const defText = item.definition || offlineMeaning(item.word)
                  const metaBits = [item.partOfSpeech, item.phonetic].filter(Boolean)
                  return (
                    <article
                      className={'saved-item' + (item.mastered ? ' is-mastered' : '') + (removingWords.has(item.word) ? ' is-removing' : '')}
                      style={{ '--stagger-idx': Math.min(idx, 7) }}
                      key={item.word}
                    >
                      <div className="saved-item-top">
                        <div className="saved-item-head">
                          <h2 className="saved-word-title">
                            <button
                              type="button"
                              className="saved-word-open"
                              onClick={() => {
                                stopSpeech()
                                clearTimeout(sheetCloseTimerRef.current)
                                setSheetClosing(false)
                                setSelectedGlossaryEntry(null)
                                setSelectedSurface('')
                                setSelected(item.word)
                              }}
                            >
                              {item.word}
                            </button>
                          </h2>
                          {metaBits.length > 0 && (
                            <span className="saved-item-meta">
                              {item.partOfSpeech && <span className="saved-item-pos">{item.partOfSpeech}</span>}
                              {item.partOfSpeech && item.phonetic && <span className="saved-item-sep" aria-hidden="true">·</span>}
                              {item.phonetic && <span className="saved-item-ipa">{item.phonetic}</span>}
                            </span>
                          )}
                        </div>
                        <div className="saved-item-actions">
                          <button
                            type="button"
                            className="saved-item-icon-btn saved-item-speak"
                            onClick={() => speak(item.word)}
                            aria-label={`Listen to ${item.word}`}
                            title="Listen"
                          >
                            <Icon name="volume" size={16}/>
                          </button>
                          <button
                            type="button"
                            className={'saved-item-icon-btn saved-item-master' + (item.mastered ? ' is-mastered' : '')}
                            aria-pressed={Boolean(item.mastered)}
                            aria-label={item.mastered ? `Mark ${item.word} as learning` : `Mark ${item.word} as mastered`}
                            title={item.mastered ? 'Mastered' : 'Mark as mastered'}
                            onClick={() => toggleWordMastered(item.word)}
                          >
                            <Icon name="check" size={16}/>
                          </button>
                          <button
                            type="button"
                            className="saved-item-icon-btn saved-item-remove"
                            onClick={() => removeSavedWord(item.word)}
                            aria-label={`Remove ${item.word}`}
                            title="Remove"
                          >
                            <Icon name="close" size={16}/>
                          </button>
                        </div>
                      </div>
                      {defText && <p className="saved-item-def">{defText}</p>}
                      {item.sentence && (
                        <blockquote className="saved-item-quote">
                          <HighlightedContext sentence={item.sentence} word={item.word} />
                        </blockquote>
                      )}
                    </article>
                  )
                })}
              </div>
            )}
          </div>
        )}
        {tab === 'review' && (
          <div key="tab-review" className="saga-tab-panel saga-tab-panel--review">
            <header className="section-header">
              <h1>Daily review<span className="period">.</span></h1>
            </header>
            {words.length === 0 ? (
              <div className="empty">
                <Icon name="layers" size={42}/>
                <h2>Nothing to review yet.</h2>
                <p>Save a few words while reading to start your daily deck.</p>
                <button className="primary" onClick={() => { setTabSwitchedToRead(true); setTab('read') }}>Start reading →</button>
              </div>
            ) : (!activeReviewWord || finished) ? (
              wordCounts.learning === 0 ? (
                <div className="empty">
                  <Icon name="check" size={44}/>
                  <h2>All words mastered.</h2>
                  <p>Every saved word is marked mastered. Practice your mastered collection anytime.</p>
                  <button
                    type="button"
                    className="primary"
                    onClick={() => startReviewSession('mastered')}
                  >
                    Review mastered words →
                  </button>
                </div>
              ) : (
                <div className="empty">
                  <Icon name="check" size={44}/>
                  <h2>Beautiful work.</h2>
                  <p>
                    {reviewMode === 'mastered'
                      ? 'You reviewed your mastered words.'
                      : `${wordCounts.learning} ${wordCounts.learning === 1 ? 'word' : 'words'} still learning · ${wordCounts.mastered} mastered.`}
                  </p>
                  <button
                    type="button"
                    className="primary"
                    onClick={() => startReviewSession('learning')}
                  >
                    Review again →
                  </button>
                </div>
              )
            ) : (
              <div className="review-stage">
                <div
                  className="review-progress"
                  aria-label={`Card ${Math.min(reviewIndex + 1, effectiveReviewDeck.length)} of ${effectiveReviewDeck.length}`}
                >
                  <div className="review-progress-meta">
                    <span className="review-progress-count">
                      {Math.min(reviewIndex + 1, effectiveReviewDeck.length)} / {effectiveReviewDeck.length}
                      {reviewMode === 'mastered' && <span className="review-mode-tag"> · Mastered</span>}
                    </span>
                    <button
                      type="button"
                      className="review-shuffle-btn"
                      disabled={effectiveReviewDeck.length < 2}
                      onClick={shuffleCurrentReview}
                      aria-label="Shuffle cards"
                    >
                      <Icon name="shuffle" size={13}/>
                      <span>Shuffle</span>
                    </button>
                  </div>
                  <div className="review-progress-track" aria-hidden="true">
                    <span
                      className="review-progress-fill"
                      style={{ transform: `scaleX(${Math.min(reviewIndex + 1, effectiveReviewDeck.length) / effectiveReviewDeck.length})` }}
                    />
                  </div>
                </div>
                {(() => {
                  const swipeDx = reviewSwipe.phase === 'dragging' ? reviewSwipe.dx : 0
                  const absDx = Math.abs(swipeDx)
                  const cueDir = swipeDx > 18 ? 'right' : swipeDx < -18 ? 'left' : null
                  const cueOpacity = cueDir ? Math.min(1, absDx / 80) : 0
                  const reduced = prefersReducedMotion()
                  const dragStyle = reviewSwipe.phase === 'dragging' && !reduced
                    ? { transform: `translate3d(${swipeDx}px, 0, 0) rotate(${(swipeDx * 0.032).toFixed(2)}deg)` }
                    : undefined
                  return (
                    <div
                      role="button"
                      tabIndex={0}
                      className={
                        'flashcard review-card' +
                        (revealed ? ' is-flipped' : '') +
                        (reviewSwipe.phase === 'dragging' ? ' is-dragging' : '') +
                        (reviewSwipe.phase === 'returning' ? ' is-returning' : '') +
                        (cueDir ? ' has-swipe-cue' : '') +
                        (reviewMotion === 'leaving' ? ` is-gliding-out is-gliding-out-${reviewExitDir}` : '') +
                        (reviewMotion === 'entering' ? ' is-gliding-in' : '')
                      }
                      style={dragStyle}
                      aria-label={revealed ? 'Show word' : 'Show meaning'}
                      aria-pressed={revealed}
                      onPointerDown={onReviewPointerDown}
                      onPointerMove={onReviewPointerMove}
                      onPointerUp={event => finishReviewPointer(event, false)}
                      onPointerCancel={event => finishReviewPointer(event, true)}
                      onClick={onReviewCardClick}
                    >
                      {cueDir && (
                        <span
                          className={'review-swipe-cue ' + (cueDir === 'right' ? 'is-gotit' : 'is-learning')}
                          style={{ opacity: cueOpacity }}
                          aria-live="polite"
                        >
                          {cueDir === 'right' ? 'Got it' : 'Still learning'}
                        </span>
                      )}
                      <span className="review-card-inner">
                        <span className="review-card-face review-card-front" aria-hidden={revealed}>
                          <div className="review-card-front-top">
                            <span className="review-card-meta">
                              {activeReviewWord.partOfSpeech && <span>{activeReviewWord.partOfSpeech}</span>}
                              {activeReviewWord.partOfSpeech && activeReviewWord.phonetic && <span aria-hidden="true">·</span>}
                              {activeReviewWord.phonetic && <span className="review-card-ipa">{activeReviewWord.phonetic}</span>}
                            </span>
                            <button
                              type="button"
                              className="review-card-speak"
                              aria-label={`Listen to ${activeReviewWord.word}`}
                              title="Listen"
                              onPointerDown={event => event.stopPropagation()}
                              onClick={event => {
                                event.stopPropagation()
                                speak(activeReviewWord.word)
                              }}
                              onKeyDown={event => event.stopPropagation()}
                            >
                              <Icon name="volume" size={17}/>
                            </button>
                          </div>
                          <div className="review-card-center">
                            {!revealed ? (
                              <strong className="review-word">{activeReviewWord.word}</strong>
                            ) : (
                              <strong className="review-word-inert">{activeReviewWord.word}</strong>
                            )}
                            {activeReviewWord.sentence && (
                              <p className="review-card-context">
                                <HighlightedContext sentence={activeReviewWord.sentence} word={activeReviewWord.word} />
                              </p>
                            )}
                          </div>
                          <span className="review-card-hint">Tap to reveal meaning</span>
                        </span>
                        <span className="review-card-face review-card-back" aria-hidden={!revealed}>
                          <span className="review-card-back-label">{activeReviewWord.word}</span>
                          <div className="review-card-center">
                            {revealed ? (
                              <strong className="review-meaning">{activeReviewMeaning}</strong>
                            ) : (
                              <strong className="review-meaning-inert">{activeReviewMeaning}</strong>
                            )}
                          </div>
                          {activeReviewWord.storyTitle ? (
                            <span className="review-card-source">From: {activeReviewWord.storyTitle}</span>
                          ) : (
                            <span className="review-card-hint">Tap to return</span>
                          )}
                        </span>
                      </span>
                    </div>
                  )
                })()}
                <div className="review-swipe-hint">
                  <button
                    type="button"
                    className="review-hint-trigger review-hint-learning"
                    onClick={() => handleReviewOutcome(false, { direction: 'left' })}
                  >
                    ← Still learning
                  </button>
                  <span className="review-hint-sep" aria-hidden="true">·</span>
                  <button
                    type="button"
                    className="review-hint-trigger review-hint-gotit"
                    onClick={() => handleReviewOutcome(true, { direction: 'right' })}
                  >
                    Got it →
                  </button>
                </div>
              </div>
            )}
          </div>
        )}
      </main>
      <nav className="bottom-nav" aria-label="Main navigation">{[['read', 'book', 'Read'], ['words', 'bookmark', 'Words'], ['review', 'layers', 'Review']].map(([key, icon, label]) => <button key={key} className={tab === key ? 'current' : ''} onClick={() => openTab(key)}><Icon name={icon} size={25}/><span>{key === 'read' && tab === 'read' && story && storyIndex === stories.length - 1 ? waitingForNext ? 'Finding…' : feedDone ? 'Check again' : 'Next ↓' : label}</span></button>)}</nav>
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
      {fullArticleStory && (
        <FullArticleModal
          story={fullArticleStory}
          headline={displayHeadline(fullArticleStory)}
          safeStoryUrl={safeStoryUrl}
          brokenImages={brokenImages}
          onBrokenImage={markBrokenImage}
          staticPhrases={staticPhrases}
          lemmaMap={lemmaMap}
          savedTokenSet={savedTokenSet}
          justSavedWord={justSavedWord}
          readingLevel={readingLevel}
          onWordClick={onWordClick}
          onClose={() => setFullArticleStory(null)}
          stopParentSpeech={stopSpeech}
          dictionaryOpen={Boolean(selected)}
          creditsOpen={showCredits}
          onOpenCredits={() => setShowCredits(true)}
        />
      )}
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
            const tier1Def = String(lookup.en_def || activeMeaning?.definition || '').trim()
            const tier1Saved = Boolean(isSaved && tier1Def && savedDef === tier1Def)
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
                          {tier1Def && <p className="dict-en-meaning">{tier1Def}</p>}
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
