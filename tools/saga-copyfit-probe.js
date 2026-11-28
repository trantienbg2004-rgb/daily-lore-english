/* SAGA copyfit probe — paste into the DevTools console on https://saga.id.vn
 * Measures every published page against Page Contract v1 (lines, not px)
 * and prints what would fit as-is, what needs +/- words, and what a lossless
 * paragraph merge/split already fixes. Read-only: changes nothing.
 * Optional: window.SAGA_PROBE_CATALOG = 'catalog-index-xxxx.json' to pin a catalog.
 */
(async () => {
  
const LEVELS = Object.freeze(['A1-A2', 'B1-B2', 'C1-C2'])

const PAGE_CONTRACT = Object.freeze({
  version: 1,
  font: Object.freeze({
    family: "'Source Serif 4', Georgia, 'Times New Roman', serif",
    weight: 400,
    opsz: 20,                 // font-variation-settings: 'opsz' 20 — locks glyph widths
    letterSpacingEm: -0.008,
  }),
  titleFont: Object.freeze({
    family: "'Playfair Display', Georgia, serif",
    weight: 700,
    sizeEm: 1.15,
    lineHeight: 1.25,
    letterSpacingEm: -0.015,
    maxLines: 2,
    hintMaxChars: 50,         // prompt hint only; the meter checks real lines
  }),
  measureEm: 17,              // body column width
  narrowFactor: 0.985,        // the meter measures 1.5% narrower: worst case across engines
  fontPx: Object.freeze({ min: 16, max: 23 }),
  lineHeight: Object.freeze({ min: 1.5, max: 1.6 }),
  gridLu: 17.5,               // page height in line units
  sideMarginPx: 32,           // minimum left + right margin together
  paragraphGapLu: 0.5,
  slots: Object.freeze({
    inner: Object.freeze({ padTop: 0.5, title: 0, mediaMin: 6, gap: 0.5, caption: 1, body: 9, padBottom: 0.5 }),
    cover: Object.freeze({ padTop: 0.5, title: 2.5, mediaMin: 5, gap: 0.5, caption: 1, body: 7.5, padBottom: 0.5 }),
  }),
  bodySlackLu: 1,             // a body may be up to 1 lu short; the media slot absorbs it
  tight: Object.freeze({ maxFrameHeightPx: 420, mediaMin: Object.freeze({ inner: 3, cover: 2 }) }),
  scrollBelowFrameHeightPx: 350,
  caption: Object.freeze({ sizeEm: 0.8, maxLines: 1, maxChars: 44 }),   // 44 always fits one line (measured 44–53)
  focus: Object.freeze({ count: 3, maxSurfaceChars: 22, maxIpaChars: 24, maxViChars: 28 }),
  pages: Object.freeze({ min: 4, max: 6, newArticles: Object.freeze([5, 6]) }),  // refit keeps 4-page articles; new ones use 5–6
  photoFitTolerance: 1.3,     // aspect ratio difference allowed before switching cover -> contain
  // Measured 2026-11-28 on 612 lore-v1 pages in the 17em column, opsz 20.
  // Used only to turn line budgets into word hints for Gemini; the meter decides.
  levelYield: Object.freeze({
    'A1-A2': Object.freeze({ wordsPerLine: 5.84, charsPerLine: 32.8 }),
    'B1-B2': Object.freeze({ wordsPerLine: 5.11, charsPerLine: 32.5 }),
    'C1-C2': Object.freeze({ wordsPerLine: 3.93, charsPerLine: 31.7 }),
  }),
})

const round1 = x => Math.round(x * 10) / 10

/** 'cover' for page 0, 'photo' when the page has an image, else 'card'. */
function pageKind(index, page) {
  if (index === 0) return 'cover'
  return page && (page.image || page.imageId) ? 'photo' : 'card'
}

function slotsFor(kind) {
  return kind === 'cover' ? PAGE_CONTRACT.slots.cover : PAGE_CONTRACT.slots.inner
}

/** Sum of the slots must equal the grid height (sanity check used by tests). */
function slotTotalLu(kind) {
  const s = slotsFor(kind)
  return s.padTop + s.title + s.mediaMin + s.gap + s.caption + s.body + s.padBottom
}

/** Body height in lu from the measured line count of each paragraph. */
function bodyLu(paragraphLines) {
  const lines = paragraphLines.filter(n => Number.isFinite(n) && n > 0)
  if (!lines.length) return 0
  return lines.reduce((a, b) => a + b, 0) + PAGE_CONTRACT.paragraphGapLu * (lines.length - 1)
}

/** Accepted body range for a page kind: [cap - slack, cap]. */
function bodyBand(kind) {
  const cap = slotsFor(kind).body
  return { min: cap - PAGE_CONTRACT.bodySlackLu, max: cap }
}

/**
 * Classify a measured body. deltaLu > 0 means "too long by deltaLu",
 * deltaLu < 0 means "too short by |deltaLu|" (beyond the allowed slack).
 */
function classifyBody(kind, lu) {
  const { min, max } = bodyBand(kind)
  if (lu > max) return { status: 'long', deltaLu: round1(lu - max), band: { min, max } }
  if (lu < min) return { status: 'short', deltaLu: round1(lu - min), band: { min, max } }
  return { status: 'fit', deltaLu: 0, band: { min, max } }
}

/** Words that fill `lines` text lines at a level (hint for Gemini, not a rule). */
function wordsForLines(level, lines) {
  const y = PAGE_CONTRACT.levelYield[level] || PAGE_CONTRACT.levelYield['B1-B2']
  return Math.round(lines * y.wordsPerLine)
}

/**
 * First-draft word budget per page kind and level, assuming 2 paragraphs.
 * Inner: 8 text lines + 0.5 gap = 8.5 lu (middle of the 8–9 band).
 * Cover: 6.5 text lines + 0.5 gap = 7 lu (middle of the 6.5–7.5 band).
 */
function wordBudget(level, kind) {
  const band = bodyBand(kind)
  const mid = (band.min + band.max) / 2
  const textLines = mid - PAGE_CONTRACT.paragraphGapLu // two paragraphs
  const target = wordsForLines(level, textLines)
  const halfLine = wordsForLines(level, 0.5)
  return { target, min: target - halfLine, max: target + halfLine, lines: textLines, paragraphs: 2 }
}

/** Budgets table for prompts and logs: {level: {cover:{...}, inner:{...}}}. */
function wordBudgets() {
  return Object.fromEntries(LEVELS.map(level => [level, {
    cover: wordBudget(level, 'cover'),
    inner: wordBudget(level, 'photo'),
  }]))
}

/**
 * Turn a measured page into one concrete instruction for a targeted rewrite.
 * Returns null when the page already fits.
 */
function copyfitInstruction({ level, kind, lu, words }) {
  const verdict = classifyBody(kind, lu)
  if (verdict.status === 'fit') return null
  const band = verdict.band
  const goalLu = (band.min + band.max) / 2
  const deltaLines = round1(goalLu - lu)              // + add, - cut
  const perLine = words && lu > 0 ? words / Math.max(1, lu - 0.25) : PAGE_CONTRACT.levelYield[level]?.wordsPerLine || 5
  const deltaWords = Math.round(deltaLines * perLine)
  const action = deltaWords > 0
    ? `ADD about ${deltaWords} words (≈${Math.abs(deltaLines)} lines) using facts already cited on this page`
    : `CUT about ${Math.abs(deltaWords)} words (≈${Math.abs(deltaLines)} lines); remove the least important clause first`
  return {
    status: verdict.status,
    deltaLu: verdict.deltaLu,
    deltaWords,
    targetWords: Math.max(10, (words || 0) + deltaWords),
    message: `${level} page ${kind}: body measures ${lu} lines, allowed ${band.min}–${band.max}. ${action}. Keep the meaning, keep 1–2 paragraphs.`,
  }
}

/**
 * Lossless ±1-line fixes that do not change a single word:
 *  - long by ≤ 1.5 lu and ≥ 2 paragraphs → merge two paragraphs
 *  - short by ≤ 1.5 lu and one paragraph has ≥ 2 sentences → split it
 * Returns candidate paragraph arrays; the meter re-measures each one.
 */
function paragraphCandidates(paragraphs, verdict) {
  const out = []
  if (!verdict || verdict.status === 'fit') return out
  if (verdict.status === 'long' && verdict.deltaLu <= 1.5 && paragraphs.length >= 2) {
    for (let i = 0; i < paragraphs.length - 1; i++) {
      out.push([...paragraphs.slice(0, i), `${paragraphs[i]} ${paragraphs[i + 1]}`, ...paragraphs.slice(i + 2)])
    }
  }
  if (verdict.status === 'short' && Math.abs(verdict.deltaLu) <= 1.5 && paragraphs.length < 3) {
    paragraphs.forEach((p, i) => {
      const sentences = p.match(/[^.!?]+[.!?]+["”’)]*\s*/g) || [p]
      for (let cut = 1; cut < sentences.length; cut++) {
        const a = sentences.slice(0, cut).join('').trim()
        const b = sentences.slice(cut).join('').trim()
        if (a.split(/\s+/).length >= 8 && b.split(/\s+/).length >= 8) {
          out.push([...paragraphs.slice(0, i), a, b, ...paragraphs.slice(i + 1)])
        }
      }
    })
  }
  return out
}

/** Photo fit inside the media slot: crop (cover) only when aspects are close. */
function photoFit(naturalW, naturalH, slotW, slotH, tolerance = PAGE_CONTRACT.photoFitTolerance) {
  if (!(naturalW > 0 && naturalH > 0 && slotW > 0 && slotH > 0)) return 'contain'
  const r = (naturalW / naturalH) / (slotW / slotH)
  return r <= tolerance && r >= 1 / tolerance ? 'cover' : 'contain'
}

/** Evidence IDs that leaked into reader text, e.g. "(P14, P16)". Found on 3/612 pages. */
const CITATION_MARKERS = /\s*[([](?:P\d{1,3}(?:\s*[,;]\s*)?)+[)\]]/g
function stripCitationMarkers(text) {
  return String(text || '').replace(CITATION_MARKERS, '')
}

/** Split stored page text into paragraphs the same way the reader does. */
function splitParagraphs(text) {
  return String(text || '')
    .split(/\n\s*\n/)
    .map(p => p.replace(/\s+/g, ' ').trim())
    .filter(Boolean)
}

/** Validate the focus words shown on the card of a page without photo. */
function validateFocus(page) {
  const errors = []
  const { count, maxSurfaceChars, maxIpaChars, maxViChars } = PAGE_CONTRACT.focus
  const items = Array.isArray(page?.focus) ? page.focus : []
  if (items.length !== count) errors.push(`focus: need exactly ${count} items, got ${items.length}`)
  const text = ` ${String(page?.text || '').toLowerCase()} `
  items.forEach((f, i) => {
    const surface = String(f?.surface || '')
    if (!surface || !text.includes(surface.toLowerCase())) errors.push(`focus[${i}]: "${surface}" is not in the page text`)
    if (surface.length > maxSurfaceChars) errors.push(`focus[${i}]: surface longer than ${maxSurfaceChars} chars`)
    if (String(f?.ipa || '').length > maxIpaChars) errors.push(`focus[${i}]: ipa longer than ${maxIpaChars} chars`)
    const vi = String(f?.vi || '')
    if (!vi || vi.length > maxViChars) errors.push(`focus[${i}]: vi missing or longer than ${maxViChars} chars`)
  })
  return errors
}

  function measureInPage({items, c, px}) {
  let host = document.getElementById('pc-meter')
  if (!host) {
    host = document.createElement('div')
    host.id = 'pc-meter'
    host.style.cssText = 'position:absolute;left:-30000px;top:0;visibility:hidden;contain:layout style;'
    document.body.appendChild(host)
  }
  const lh = px * 1.5
  const colPx = c.measureEm * c.narrowFactor * px
  const body = document.createElement('div')
  body.style.cssText = `width:${colPx}px;font-family:${c.font.family};font-weight:${c.font.weight};font-size:${px}px;line-height:${lh}px;letter-spacing:${c.font.letterSpacingEm}em;font-optical-sizing:none;font-variation-settings:'opsz' ${c.font.opsz};text-align:left;hyphens:manual;text-wrap:wrap;overflow-wrap:break-word;`
  const titleLh = px * c.titleFont.sizeEm * c.titleFont.lineHeight
  const title = document.createElement('div')
  title.style.cssText = `width:${colPx}px;font-family:${c.titleFont.family};font-weight:${c.titleFont.weight};font-size:${px * c.titleFont.sizeEm}px;line-height:${titleLh}px;letter-spacing:${c.titleFont.letterSpacingEm}em;`
  const caption = document.createElement('div')
  caption.style.cssText = `width:${colPx}px;font-family:${c.font.family};font-style:italic;font-size:${px * c.caption.sizeEm}px;line-height:${lh}px;font-optical-sizing:none;font-variation-settings:'opsz' ${c.font.opsz};`
  host.replaceChildren(body, title, caption)
  const count = (el, unit) => Math.round(el.getBoundingClientRect().height / unit)
  return items.map(it => {
    if (it.kind === 'title') { title.textContent = it.text || ''; return {lines: it.text ? count(title, titleLh) : 0} }
    if (it.kind === 'caption') { caption.textContent = it.text || ''; return {lines: it.text ? count(caption, lh) : 0} }
    body.replaceChildren(...(it.paragraphs || []).map(t => {
      const p = document.createElement('p'); p.style.margin = '0'; p.textContent = t; return p
    }))
    return {paragraphLines: [...body.children].map(p => count(p, lh))}
  })
}

  const t0 = performance.now()
  const get = async url => (await fetch(url, {cache: 'no-store'})).json()
  const manifest = await get('/wiki-reader/manifest.json')
  const catalog = await get('/wiki-reader/' + (window.SAGA_PROBE_CATALOG || manifest.catalogIndex))
  const stories = []
  for (const shard of [...new Set(catalog.entries.map(e => e.shard))]) stories.push(...await get(`/wiki-reader/${shard}.json`))
  const c = PAGE_CONTRACT
  const sample = 'The Catalan Atlas, 1375 — ancient sea routes; “quoted” words.'
  await Promise.all([
    document.fonts.load(`${c.font.weight} 20px ${c.font.family}`, sample),
    document.fonts.load(`italic ${c.font.weight} 16px ${c.font.family}`, sample),
    document.fonts.load(`${c.titleFont.weight} 23px ${c.titleFont.family}`, sample),
  ])
  await document.fonts.ready
  const measure = items => measureInPage({items, c, px: 20})
  const rows = []
  let titles = 0, titlesOver = 0, captions = 0, captionsOver = 0
  const shapes = new Set()
  for (const s of stories) {
    const perLevelShape = []
    for (const level of LEVELS) {
      const v = s.levelVariants?.[level]
      if (!v) continue
      perLevelShape.push((v.pages || []).map((p, i) => pageKind(i, p)).join(','))
      titles++
      if (measure([{kind: 'title', text: v.headline}])[0].lines > c.titleFont.maxLines) titlesOver++
      v.pages.forEach((p, index) => {
        const kind = pageKind(index, p)
        const paragraphs = splitParagraphs(p.text)
        const lu = bodyLu(measure([{kind: 'body', paragraphs}])[0].paragraphLines)
        const verdict = classifyBody(kind, lu)
        let fixable = false
        if (verdict.status !== 'fit') {
          for (const cand of paragraphCandidates(paragraphs, verdict)) {
            if (classifyBody(kind, bodyLu(measure([{kind: 'body', paragraphs: cand}])[0].paragraphLines)).status === 'fit') { fixable = true; break }
          }
        }
        if (kind !== 'card' && p.caption) { captions++; if (measure([{kind: 'caption', text: p.caption}])[0].lines > 1) captionsOver++ }
        const words = paragraphs.join(' ').split(/\s+/).filter(Boolean).length
        const ins = verdict.status === 'fit' ? null : copyfitInstruction({level, kind, lu, words})
        rows.push({story: s.title, level, page: index + 1, kind, lu, words, status: verdict.status, delta: verdict.deltaLu, fixable, deltaWords: ins?.deltaWords || 0, hasFocus: Array.isArray(p.focus), sourceIds: stripCitationMarkers(p.text) !== String(p.text || '')})
      })
    }
    if (new Set(perLevelShape).size > 1) shapes.add(s.title)
  }
  // Font check: with opsz locked, line breaks must not depend on font size.
  let invarianceDiff = 0
  for (const s of stories) for (const level of LEVELS) for (const p of s.levelVariants?.[level]?.pages || []) {
    const paragraphs = splitParagraphs(p.text)
    const at = px => measureInPage({items: [{kind: 'body', paragraphs}], c, px})[0].paragraphLines.join(',')
    if (at(18) !== at(22)) invarianceDiff++
  }
  const by = key => rows.reduce((m, r) => { const k = key(r); (m[k] ||= {pages: 0, fit: 0, long: 0, short: 0, fixedByParagraphs: 0}); m[k].pages++; m[k][r.status]++; if (r.fixable) m[k].fixedByParagraphs++; return m }, {})
  const q = (xs, p) => { const a = xs.slice().sort((x, y) => x - y); return a.length ? a[Math.min(a.length - 1, Math.floor(p * (a.length - 1) + 0.5))] : null }
  const needsRewrite = rows.filter(r => r.status !== 'fit' && !r.fixable)
  const summary = {
    contract: c.version,
    stories: stories.length,
    pages: rows.length,
    byKind: by(r => r.kind),
    byLevel: by(r => r.level),
    rewriteWordsDelta: {add: rows.filter(r => r.deltaWords > 0 && !r.fixable).map(r => r.deltaWords).sort((a, b) => a - b), median: q(needsRewrite.map(r => Math.abs(r.deltaWords)), 0.5), p90: q(needsRewrite.map(r => Math.abs(r.deltaWords)), 0.9)},
    headlinesOver2Lines: `${titlesOver}/${titles}`,
    captionsOver1Line: `${captionsOver}/${captions}`,
    pagesWithFocusWords: `${rows.filter(r => r.hasFocus).length}/${rows.length}`,
    pagesWithSourceIdsInText: rows.filter(r => r.sourceIds).length,
    storiesWithDifferentShapesAcrossLevels: shapes.size,
    lineBreaksDifferBetween18and22px: invarianceDiff, // must be 0; otherwise the font or opsz lock is wrong
    ms: Math.round(performance.now() - t0),
  }
  window.__sagaCopyfitRows = rows
  console.table(Object.entries(summary.byKind).map(([k, v]) => ({kind: k, ...v})))
  console.table(Object.entries(summary.byLevel).map(([k, v]) => ({level: k, ...v})))
  console.log('[saga copyfit probe]', summary)
  return summary
})()
