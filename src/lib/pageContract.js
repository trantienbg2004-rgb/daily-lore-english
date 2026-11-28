/**
 * SAGA Page Contract v1 — the single source of truth for page geometry and
 * copy budgets. Imported by the reader (React), the copyfit meter
 * (Playwright) and the Gemini prompt builders, so all three use the same
 * numbers. src/styles/page-frame.css mirrors the geometry; the unit test
 * scripts/test/page-contract.test.mjs fails when the two drift apart.
 *
 * Units
 *  - em   : widths. The body column is always `measureEm` wide, and the font's
 *           optical size is locked, so a paragraph breaks into the same lines
 *           on every screen. Measure once, valid everywhere.
 *  - lu   : "line unit" = one body line (line-height). Heights are in lu.
 *
 * Pure ES module: no DOM, no Node APIs.
 */

export const LEVELS = Object.freeze(['A1-A2', 'B1-B2', 'C1-C2'])

export const PAGE_CONTRACT = Object.freeze({
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
export function pageKind(index, page) {
  if (index === 0) return 'cover'
  return page && (page.image || page.imageId) ? 'photo' : 'card'
}

export function slotsFor(kind) {
  return kind === 'cover' ? PAGE_CONTRACT.slots.cover : PAGE_CONTRACT.slots.inner
}

/** Sum of the slots must equal the grid height (sanity check used by tests). */
export function slotTotalLu(kind) {
  const s = slotsFor(kind)
  return s.padTop + s.title + s.mediaMin + s.gap + s.caption + s.body + s.padBottom
}

/** Body height in lu from the measured line count of each paragraph. */
export function bodyLu(paragraphLines) {
  const lines = paragraphLines.filter(n => Number.isFinite(n) && n > 0)
  if (!lines.length) return 0
  return lines.reduce((a, b) => a + b, 0) + PAGE_CONTRACT.paragraphGapLu * (lines.length - 1)
}

/** Accepted body range for a page kind: [cap - slack, cap]. */
export function bodyBand(kind) {
  const cap = slotsFor(kind).body
  return { min: cap - PAGE_CONTRACT.bodySlackLu, max: cap }
}

/**
 * Classify a measured body. deltaLu > 0 means "too long by deltaLu",
 * deltaLu < 0 means "too short by |deltaLu|" (beyond the allowed slack).
 */
export function classifyBody(kind, lu) {
  const { min, max } = bodyBand(kind)
  if (lu > max) return { status: 'long', deltaLu: round1(lu - max), band: { min, max } }
  if (lu < min) return { status: 'short', deltaLu: round1(lu - min), band: { min, max } }
  return { status: 'fit', deltaLu: 0, band: { min, max } }
}

/** Words that fill `lines` text lines at a level (hint for Gemini, not a rule). */
export function wordsForLines(level, lines) {
  const y = PAGE_CONTRACT.levelYield[level] || PAGE_CONTRACT.levelYield['B1-B2']
  return Math.round(lines * y.wordsPerLine)
}

/**
 * First-draft word budget per page kind and level, assuming 2 paragraphs.
 * Inner: 8 text lines + 0.5 gap = 8.5 lu (middle of the 8–9 band).
 * Cover: 6.5 text lines + 0.5 gap = 7 lu (middle of the 6.5–7.5 band).
 */
export function wordBudget(level, kind) {
  const band = bodyBand(kind)
  const mid = (band.min + band.max) / 2
  const textLines = mid - PAGE_CONTRACT.paragraphGapLu // two paragraphs
  const target = wordsForLines(level, textLines)
  const halfLine = wordsForLines(level, 0.5)
  return { target, min: target - halfLine, max: target + halfLine, lines: textLines, paragraphs: 2 }
}

/** Budgets table for prompts and logs: {level: {cover:{...}, inner:{...}}}. */
export function wordBudgets() {
  return Object.fromEntries(LEVELS.map(level => [level, {
    cover: wordBudget(level, 'cover'),
    inner: wordBudget(level, 'photo'),
  }]))
}

/**
 * Turn a measured page into one concrete instruction for a targeted rewrite.
 * Returns null when the page already fits.
 */
export function copyfitInstruction({ level, kind, lu, words }) {
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
export function paragraphCandidates(paragraphs, verdict) {
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
export function photoFit(naturalW, naturalH, slotW, slotH, tolerance = PAGE_CONTRACT.photoFitTolerance) {
  if (!(naturalW > 0 && naturalH > 0 && slotW > 0 && slotH > 0)) return 'contain'
  const r = (naturalW / naturalH) / (slotW / slotH)
  return r <= tolerance && r >= 1 / tolerance ? 'cover' : 'contain'
}

/** Evidence IDs that leaked into reader text, e.g. "(P14, P16)". Found on 3/612 pages. */
const CITATION_MARKERS = /\s*[([](?:P\d{1,3}(?:\s*[,;]\s*)?)+[)\]]/g
export function stripCitationMarkers(text) {
  return String(text || '').replace(CITATION_MARKERS, '')
}

/** Split stored page text into paragraphs the same way the reader does. */
export function splitParagraphs(text) {
  return String(text || '')
    .split(/\n\s*\n/)
    .map(p => p.replace(/\s+/g, ' ').trim())
    .filter(Boolean)
}

/** Validate the focus words shown on the card of a page without photo. */
export function validateFocus(page) {
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
