import { useEffect, useRef, useState } from 'react'
import { PAGE_CONTRACT } from '../lib/pageContract.js'
import '../styles/page-frame.css'

/**
 * One frame for every reader page (Page Contract v1).
 *
 *   kind="cover"  title + photo + caption + body (page 1)
 *   kind="photo"  title + photo + caption + body
 *   kind="card"   title + body (page without photo)
 */
export default function PageFrame({
  kind = 'photo',
  headline = '',
  image = '',
  imageAlt = '',
  caption = '',
  onImageError,
  onOverflow,
  children,
}) {
  const gridRef = useRef(null)
  const [overflow, setOverflow] = useState(false)
  const showPhoto = kind !== 'card' && Boolean(image)

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
        {headline && <h1 className="saga-frame__title" title={headline}>{headline}</h1>}

        {showPhoto && (
          <div className="saga-frame__media">
            <img
              className="saga-photo"
              src={image}
              alt={imageAlt || caption}
              decoding="async"
              onError={onImageError}
            />
          </div>
        )}

        {showPhoto && caption && <p className="saga-frame__caption">{caption}</p>}

        <div className="saga-frame__body">{children}</div>
      </div>
    </div>
  )
}
