import { Fragment, useEffect, useMemo, useRef, useState } from 'react'
import { fetchFullArticle, selectMinimapSections } from '../services/fullArticleService.js'
import { createArticleReaderController, splitPageIntoSentences } from '../lib/readerAudio.js'
import { tokenizeWithGlossary } from '../utils/dictionaryTokenizer.js'
import { groupTokenClusters } from '../lib/readerPagination.js'
import { isTokenSaved } from '../lib/savedWordsMatch.js'
import { resolvePhoto, photoResult } from '../lib/photoLoad.js'
import { photoCaption, photoLabel, photoSrcSet } from '../lib/photoPresentation.js'
import { prefersReducedMotion } from '../lib/gesturePhysics.js'

function CloseIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M6 6l12 12M18 6 6 18" />
    </svg>
  )
}

function VolumeIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M4 9v6h4l5 4V5L8 9H4Z" />
      <path d="M17 9a5 5 0 0 1 0 6" />
    </svg>
  )
}

function LeadPhoto({ page, brokenImages, onBroken }) {
  const image = page?.image || ''
  const [asset, setAsset] = useState(() => (image ? photoResult(image) : null))

  useEffect(() => {
    let active = true
    if (!image || brokenImages?.has?.(image)) {
      setAsset(null)
      return () => { active = false }
    }
    const known = photoResult(image)
    setAsset(known)
    if (known?.failed) {
      onBroken?.(image)
      return () => { active = false }
    }
    if (!known) {
      resolvePhoto(image).then(result => {
        if (!active) return
        setAsset(result)
        if (!result?.url) onBroken?.(image)
      })
    }
    return () => { active = false }
  }, [image, brokenImages, onBroken])

  if (!image || brokenImages?.has?.(image)) return null
  if (!asset) {
    return (
      <figure className="full-article-hero-figure is-loading" aria-hidden="true">
        <div className="full-article-hero-skeleton" />
      </figure>
    )
  }
  if (!asset.url) return null

  const label = photoCaption({ image, caption: page?.caption }) || photoLabel(page) || ''
  const srcSet = photoSrcSet(asset.url, asset.width)

  return (
    <figure className="full-article-hero-figure">
      <img
        className="full-article-hero-img"
        src={asset.url}
        srcSet={srcSet}
        sizes="(max-width: 760px) calc(100vw - 2.5rem), 388px"
        alt={label || 'Article illustration'}
        width={asset.width || 1200}
        height={asset.height || 800}
        loading="eager"
        decoding="async"
        referrerPolicy="no-referrer"
        onError={() => onBroken?.(image)}
      />
      {label && label !== 'Article photograph' && (
        <figcaption className="full-article-hero-caption">{label}</figcaption>
      )}
    </figure>
  )
}

export default function FullArticleModal({
  story,
  headline,
  safeStoryUrl,
  brokenImages,
  onBrokenImage,
  staticPhrases,
  lemmaMap,
  savedTokenSet,
  justSavedWord,
  readingLevel,
  onWordClick,
  onClose,
  stopParentSpeech,
  dictionaryOpen,
  creditsOpen,
  onOpenCredits,
}) {
  const [status, setStatus] = useState('loading')
  const [article, setArticle] = useState(null)
  const [retryCount, setRetryCount] = useState(0)
  const [activeSectionId, setActiveSectionId] = useState('')
  const [audioPlaying, setAudioPlaying] = useState(false)
  const [activeParaIndex, setActiveParaIndex] = useState(null)
  const [activeSentenceIndex, setActiveSentenceIndex] = useState(null)

  const scrollRef = useRef(null)
  const sectionRefs = useRef(new Map())
  const paraRefs = useRef(new Map())
  const audioRef = useRef(null)
  const readingLevelRef = useRef(readingLevel)
  readingLevelRef.current = readingLevel

  if (!audioRef.current) {
    audioRef.current = createArticleReaderController({
      onStateChange: ({ playing, pageIndex }) => {
        setAudioPlaying(playing)
        setActiveParaIndex(playing ? pageIndex : null)
        if (!playing) setActiveSentenceIndex(null)
      },
      onSentenceChange: nextIdx => setActiveSentenceIndex(nextIdx),
      onAdvancePage: nextIdx => setActiveParaIndex(nextIdx),
    })
  }

  // Stop parent speech when opening and stop modal speech on unmount
  useEffect(() => {
    stopParentSpeech?.()
    return () => {
      audioRef.current?.stop()
    }
  }, [])

  // Fetch Wikipedia full text on demand
  useEffect(() => {
    if (!story) return undefined
    const controller = new AbortController()
    let active = true
    audioRef.current?.stop()
    setStatus('loading')
    setArticle(null)

    fetchFullArticle({
      sourceTitle: story.sourceTitle,
      sourcePageId: story.sourcePageId,
      title: headline,
      signal: controller.signal,
    })
      .then(parsed => {
        if (!active) return
        setArticle(parsed)
        setStatus('ready')
        const firstId = parsed.sections?.[0]?.id || ''
        setActiveSectionId(firstId)
      })
      .catch(err => {
        if (!active || err?.name === 'AbortError') return
        setStatus('error')
      })

    return () => {
      active = false
      controller.abort()
    }
  }, [story?.sourceTitle, story?.sourcePageId, headline, retryCount])

  // Escape closes full article ONLY when dictionary and credits sheets are not open
  useEffect(() => {
    const onKeyDown = event => {
      if (event.key === 'Escape' && !dictionaryOpen && !creditsOpen) {
        event.preventDefault()
        audioRef.current?.stop()
        onClose()
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [dictionaryOpen, creditsOpen, onClose])

  // Build flat paragraph index for read-aloud narration
  const flatParagraphs = useMemo(() => {
    if (!article?.sections?.length) return []
    const items = []
    article.sections.forEach((sec, secIdx) => {
      sec.paragraphs.forEach((text, pIdx) => {
        items.push({
          key: `${secIdx}:${pIdx}`,
          text,
        })
      })
    })
    return items
  }, [article])

  const paraKeyToIndex = useMemo(() => {
    const map = new Map()
    flatParagraphs.forEach((item, idx) => map.set(item.key, idx))
    return map
  }, [flatParagraphs])

  // Gently keep active read-aloud sentence visible as playback advances
  useEffect(() => {
    if (!audioPlaying || activeParaIndex === null) return
    const container = scrollRef.current
    const activeSentenceNode = container?.querySelector('.full-article-paragraph .saga-sentence--active')
    const key = flatParagraphs[activeParaIndex]?.key
    const targetNode = activeSentenceNode || (key ? paraRefs.current.get(key) : null)
    if (targetNode && typeof targetNode.scrollIntoView === 'function') {
      targetNode.scrollIntoView({
        behavior: prefersReducedMotion() ? 'auto' : 'smooth',
        block: 'nearest',
      })
    }
  }, [audioPlaying, activeParaIndex, activeSentenceIndex, flatParagraphs])

  // Right-edge minimap sections: Intro + all rendered h2 and h3 headings (capped cleanly to 16)
  const minimapSections = useMemo(
    () => selectMinimapSections(article?.sections || [], 16),
    [article]
  )

  // Track visible section (intro, h2, h3) accurately via scroll + IntersectionObserver
  useEffect(() => {
    const container = scrollRef.current
    if (!container || status !== 'ready' || !minimapSections.length) return undefined

    let rafId = 0
    const updateFromScroll = () => {
      const containerRect = container.getBoundingClientRect()
      const readingLine = containerRect.top + 112
      const scrollBottom = container.scrollTop + container.clientHeight
      if (container.scrollTop <= 16) {
        setActiveSectionId(minimapSections[0].id)
        return
      }
      if (container.scrollHeight - scrollBottom <= 24) {
        setActiveSectionId(minimapSections[minimapSections.length - 1].id)
        return
      }
      let currentId = minimapSections[0].id
      for (const sec of minimapSections) {
        const el = sectionRefs.current.get(sec.id)
        if (!el) continue
        const rect = el.getBoundingClientRect()
        if (rect.top <= readingLine) {
          currentId = sec.id
        } else {
          break
        }
      }
      setActiveSectionId(currentId)
    }

    const scheduleUpdate = () => {
      if (rafId) return
      rafId = window.requestAnimationFrame(() => {
        rafId = 0
        updateFromScroll()
      })
    }

    let observer = null
    if (typeof IntersectionObserver !== 'undefined') {
      observer = new IntersectionObserver(scheduleUpdate, {
        root: container,
        rootMargin: '-48px 0px -55% 0px',
        threshold: [0, 0.1, 0.5],
      })

      minimapSections.forEach(sec => {
        const el = sectionRefs.current.get(sec.id)
        if (el) observer.observe(el)
      })
    }

    updateFromScroll()
    container.addEventListener('scroll', scheduleUpdate, { passive: true })
    return () => {
      if (rafId) window.cancelAnimationFrame(rafId)
      observer?.disconnect()
      container.removeEventListener('scroll', scheduleUpdate)
    }
  }, [status, minimapSections])

  const handleClose = () => {
    audioRef.current?.stop()
    onClose()
  }

  const findVisibleStartParagraphIndex = () => {
    const container = scrollRef.current
    if (!container || !flatParagraphs.length) return 0
    if (container.scrollTop <= 20) return 0
    const viewportTop = container.getBoundingClientRect().top + 52
    let closestIdx = 0
    let closestDist = Infinity
    for (let i = 0; i < flatParagraphs.length; i += 1) {
      const node = paraRefs.current.get(flatParagraphs[i].key)
      if (!node) continue
      const rect = node.getBoundingClientRect()
      if (rect.bottom > viewportTop + 10) {
        return i
      }
      const dist = Math.abs(rect.top - viewportTop)
      if (dist < closestDist) {
        closestDist = dist
        closestIdx = i
      }
    }
    return closestIdx
  }

  const toggleFullAudio = () => {
    if (audioPlaying) {
      audioRef.current?.stop()
      return
    }
    if (!flatParagraphs.length) return
    stopParentSpeech?.()
    const startPage = findVisibleStartParagraphIndex()
    audioRef.current?.start({
      pages: flatParagraphs,
      startPage,
      readingLevel: readingLevelRef.current,
    })
  }

  const handleWordTap = (event, token, sentenceText) => {
    audioRef.current?.stop()
    onWordClick(event, token.lookupKey, token.entry, token.text, sentenceText)
  }

  const jumpToSection = sectionId => {
    const container = scrollRef.current
    const el = sectionRefs.current.get(sectionId)
    if (!container || !el) return
    const targetTop = Math.max(0, el.offsetTop - 64)
    container.scrollTo({
      top: targetTop,
      behavior: prefersReducedMotion() ? 'auto' : 'smooth',
    })
    setActiveSectionId(sectionId)
  }

  const leadPage = story?.pages?.[0] || null
  const displayTitle = story?.sourceTitle || article?.title || story?.title || headline || ''
  const subtitle = article?.description || ''
  const safeSourceUrl = safeStoryUrl(story?.sourceUrl)
  const safeLicenseUrl = safeStoryUrl(story?.licenseUrl || 'https://creativecommons.org/licenses/by-sa/4.0/')
  const attributionTitle = story?.sourceTitle || article?.title || displayTitle
  const licenseLabel = story?.license || 'CC BY-SA 4.0'

  return (
    <div
      className="full-article-overlay"
      role="dialog"
      aria-modal="true"
      aria-label={`Full article: ${displayTitle}`}
      onWheel={event => event.stopPropagation()}
      onTouchStart={event => event.stopPropagation()}
      onTouchMove={event => event.stopPropagation()}
      onTouchEnd={event => event.stopPropagation()}
      onPointerDown={event => event.stopPropagation()}
    >
      <header className="full-article-topbar">
        <button
          type="button"
          className="full-article-close"
          onClick={handleClose}
          aria-label="Close full article"
          title="Close"
        >
          <CloseIcon />
        </button>

        <button
          type="button"
          className={'icon-button saga-toolbar-audio full-article-audio' + (audioPlaying ? ' is-speaking' : '')}
          onClick={toggleFullAudio}
          disabled={status !== 'ready' || flatParagraphs.length === 0}
          aria-pressed={audioPlaying}
          aria-label={audioPlaying ? 'Stop reading aloud' : 'Read aloud'}
          title={audioPlaying ? 'Stop reading aloud' : 'Read aloud'}
        >
          <span className="audio-label" aria-hidden="true">
            {audioPlaying ? 'STOP' : 'LISTEN'}
          </span>
          <VolumeIcon />
        </button>
      </header>

      <div ref={scrollRef} className="full-article-scroll">
        <article className="full-article-body">
          <header className="full-article-header">
            <h1 className="full-article-title">{displayTitle}</h1>
            {subtitle && <p className="full-article-subtitle">{subtitle}</p>}
          </header>

          {leadPage?.image && (
            <LeadPhoto
              page={leadPage}
              brokenImages={brokenImages}
              onBroken={onBrokenImage}
            />
          )}

          {status === 'loading' && (
            <div className="full-article-skeleton" role="status" aria-label="Loading full article">
              <div className="full-article-skel-line is-wide" />
              <div className="full-article-skel-line" />
              <div className="full-article-skel-line is-mid" />
              <div className="full-article-skel-gap" />
              <div className="full-article-skel-line" />
              <div className="full-article-skel-line is-wide" />
              <div className="full-article-skel-line is-short" />
            </div>
          )}

          {status === 'error' && (
            <div className="full-article-error" role="alert">
              <p>Could not load the full article right now. Check your connection or open it directly on Wikipedia.</p>
              <div className="full-article-error-actions">
                <button
                  type="button"
                  className="full-article-retry-btn"
                  onClick={() => setRetryCount(c => c + 1)}
                >
                  Try again
                </button>
                {safeSourceUrl && (
                  <a
                    className="full-article-external-link"
                    href={safeSourceUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    Open on Wikipedia
                  </a>
                )}
              </div>
            </div>
          )}

          {status === 'ready' && article && (
            <>
              <div className="full-article-sections">
                {article.sections.map((section, secIdx) => (
                  <section
                    key={section.id}
                    id={section.id}
                    data-section-id={section.id}
                    ref={el => {
                      if (el) sectionRefs.current.set(section.id, el)
                      else sectionRefs.current.delete(section.id)
                    }}
                    className={'full-article-section' + (section.isIntro ? ' is-intro' : '')}
                  >
                    {!section.isIntro && section.level === 2 && (
                      <h2 className="full-article-h2">{section.title}</h2>
                    )}
                    {!section.isIntro && section.level >= 3 && (
                      <h3 className="full-article-h3">{section.title}</h3>
                    )}

                    {section.paragraphs.map((paragraph, pIdx) => {
                      const paraKey = `${secIdx}:${pIdx}`
                      const paraGlobalIndex = paraKeyToIndex.get(paraKey)
                      const isParaPlaying =
                        audioPlaying &&
                        activeParaIndex === paraGlobalIndex &&
                        activeSentenceIndex !== null
                      const sentences = splitPageIntoSentences(paragraph)

                      return (
                        <p
                          key={paraKey}
                          ref={el => {
                            if (el) paraRefs.current.set(paraKey, el)
                            else paraRefs.current.delete(paraKey)
                          }}
                          className="full-article-paragraph"
                        >
                          {sentences.map((seg, sIdx) => {
                            const [, leading, core, trailing] =
                              seg.match(/^(\s*)([\s\S]*?)(\s*)$/) || ['', '', seg, '']
                            const tokens = core
                              ? tokenizeWithGlossary(core, story?.glossary, staticPhrases, lemmaMap)
                              : []
                            const clustered = groupTokenClusters(tokens)
                            const isCurrentSentence = isParaPlaying && activeSentenceIndex === sIdx
                            const sentenceClass =
                              'saga-sentence' +
                              (isCurrentSentence ? ' saga-sentence--active' : '')

                            const renderWordButton = (token, key) => {
                              const saved = isTokenSaved(token, savedTokenSet, lemmaMap)
                              const newlySaved = Boolean(
                                saved &&
                                  justSavedWord &&
                                  (String(token.lookupKey || '').toLowerCase() === justSavedWord ||
                                    String(token.text || '').toLowerCase() === justSavedWord)
                              )
                              return (
                                <button
                                  key={key}
                                  type="button"
                                  className={
                                    'word-token ' +
                                    (token.kind === 'glossary'
                                      ? 'glossary-token '
                                      : token.kind === 'phrase'
                                        ? 'phrase-token '
                                        : '') +
                                    (saved ? 'known ' : '') +
                                    (newlySaved ? 'just-saved' : '')
                                  }
                                  onClick={event => handleWordTap(event, token, core)}
                                >
                                  {token.text}
                                </button>
                              )
                            }

                            return (
                              <Fragment key={sIdx}>
                                {leading}
                                {core && (
                                  <span className={sentenceClass} data-sentence-index={sIdx}>
                                    {clustered.map((piece, i) => {
                                      if (piece.kind === 'text') return piece.text
                                      if (piece.kind === 'cluster') {
                                        return (
                                          <span key={i} className="saga-word-cluster">
                                            {piece.leading || ''}
                                            {renderWordButton(piece.token)}
                                            {piece.clinging || ''}
                                          </span>
                                        )
                                      }
                                      return renderWordButton(piece.token, i)
                                    })}
                                  </span>
                                )}
                                {trailing}
                              </Fragment>
                            )
                          })}
                        </p>
                      )
                    })}
                  </section>
                ))}
              </div>

              <footer className="full-article-footer">
                <p>
                  Excerpt from{' '}
                  {safeSourceUrl ? (
                    <a href={safeSourceUrl} target="_blank" rel="noopener noreferrer">
                      {attributionTitle}
                    </a>
                  ) : (
                    attributionTitle
                  )}{' '}
                  on Wikipedia, licensed{' '}
                  {safeLicenseUrl ? (
                    <a
                      className="full-article-license-link"
                      href={safeLicenseUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                    >
                      {licenseLabel}
                    </a>
                  ) : (
                    licenseLabel
                  )}
                  .
                  {onOpenCredits && (
                    <>
                      {' '}
                      <span aria-hidden="true">·</span>{' '}
                      <button
                        type="button"
                        className="full-article-credits-btn"
                        onClick={onOpenCredits}
                        aria-label="View article author, text license and individual image credits"
                      >
                        Image credits
                      </button>
                    </>
                  )}
                </p>
              </footer>
            </>
          )}
        </article>
      </div>

      {status === 'ready' && minimapSections.length > 1 && (
        <nav className="full-article-minimap" aria-label="Article sections">
          {minimapSections.map(sec => {
            const isActive = activeSectionId === sec.id
            const isSub = sec.level >= 3
            return (
              <button
                key={sec.id}
                type="button"
                className={
                  'full-article-tick' +
                  (isSub ? ' is-sub' : '') +
                  (isActive ? ' is-active' : '')
                }
                aria-label={`Jump to section: ${sec.title}`}
                aria-current={isActive ? 'true' : undefined}
                title={sec.title}
                onClick={() => jumpToSection(sec.id)}
              >
                <span className="full-article-tick-bar" aria-hidden="true" />
              </button>
            )
          })}
        </nav>
      )}
    </div>
  )
}
