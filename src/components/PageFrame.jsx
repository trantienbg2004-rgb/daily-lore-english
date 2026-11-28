import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { photoFit, PAGE_CONTRACT } from '../lib/pageContract.js'
import '../styles/page-frame.css'

/**
 * One frame for every reader page (Page Contract v1).
 *
 *   kind="cover"  title + photo + caption + body (page 1)
 *   kind="photo"  photo + caption + body
 *   kind="card"   focus-word card + label line + body (page without photo,
 *                 or a page whose photo failed to load)
 *
 * The body (children) is rendered as-is, so the existing word-token
 * paragraphs from App.jsx can be passed in unchanged:
 *   <PageFrame kind="photo" image={src} caption={label}>{paragraphs}</PageFrame>
 *
 * Nothing here measures text or changes font size. The CSS derives one font
 * size from the frame; the media slot absorbs the remaining height.
 * onOverflow fires only if content breaks the contract (should never happen
 * for published articles; use it to switch the article to scroll mode and
 * to log which device and page broke).
 */
export default function PageFrame({
  kind = 'photo',
  headline = '',
  image = '',
  imageAlt = '',
  caption = '',
  focus = [],
  cardLabel = 'Từ khóa trong trang',
  onImageError,
  onOverflow,
  children,
}) {
  const gridRef = useRef(null)
  const mediaRef = useRef(null)
  const [fit, setFit] = useState('cover')
  const [natural, setNatural] = useState(null)
  const [overflow, setOverflow] = useState(false)
  const showPhoto = kind !== 'card' && Boolean(image)

  // Decide cover/contain from the photo's natural size and the slot size.
  useLayoutEffect(() => {
    const media = mediaRef.current
    if (!media || !natural) return undefined
    const update = () => {
      const r = media.getBoundingClientRect()
      setFit(photoFit(natural.w, natural.h, r.width, r.height))
    }
    update()
    const ro = new ResizeObserver(update)
    ro.observe(media)
    return () => ro.disconnect()
  }, [natural])

  // Contract guard: after fonts are ready, a page that still overflows
  // scrolls inside its frame (never clipped) and is reported once.
  useEffect(() => {
    const grid = gridRef.current
    if (!grid) return undefined
    let cancelled = false
    let reported = false
    const check = () => {
      if (cancelled) return
      const over = grid.scrollHeight - grid.clientHeight
      if (over > 1) {
        setOverflow(true)
        if (!reported && onOverflow) { reported = true; onOverflow({ overflowPx: Math.round(over), kind, contract: PAGE_CONTRACT.version }) }
      }
    }
    const ro = new ResizeObserver(check)
    document.fonts?.ready?.then(() => { if (!cancelled) { check(); ro.observe(grid) } })
    return () => { cancelled = true; ro.disconnect() }
  }, [onOverflow, kind])

  return (
    <div className={`saga-frame saga-frame--${kind}${overflow ? ' saga-frame--overflow' : ''}`} data-page-kind={kind} data-contract={PAGE_CONTRACT.version}>
      <div className="saga-frame__grid" ref={gridRef}>
        {kind === 'cover' && <h1 className="saga-frame__title" title={headline}>{headline}</h1>}

        <div className="saga-frame__media" ref={mediaRef} data-fit={showPhoto ? fit : undefined}>
          {showPhoto ? (
            <>
              <img className="saga-photo-backdrop" src={image} alt="" aria-hidden="true" decoding="async" />
              <img
                className="saga-photo"
                src={image}
                alt={imageAlt || caption}
                decoding="async"
                onLoad={e => setNatural({ w: e.currentTarget.naturalWidth, h: e.currentTarget.naturalHeight })}
                onError={onImageError}
              />
            </>
          ) : (
            <FocusCard items={focus} label={cardLabel} />
          )}
        </div>

        <p className="saga-frame__caption">{showPhoto ? caption : cardLabelLine(focus)}</p>

        <div className="saga-frame__body">{children}</div>
      </div>
    </div>
  )
}

function cardLabelLine(focus) {
  return focus?.length ? 'Chạm vào từ tô màu để nghe và lưu' : ''
}

function FocusCard({ items, label }) {
  const list = (items || []).slice(0, PAGE_CONTRACT.focus.count)
  return (
    <div className="saga-card" role="note" aria-label={label}>
      <p className="saga-card__label">{label}</p>
      <ul className="saga-card__list">
        {list.map(item => (
          <li className="saga-card__item" key={item.surface}>
            <span className="saga-card__word">{item.surface}</span>
            <span className="saga-card__ipa">{item.ipa}</span>
            <span className="saga-card__vi">{item.vi}</span>
          </li>
        ))}
      </ul>
    </div>
  )
}
