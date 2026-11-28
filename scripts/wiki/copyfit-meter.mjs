// Copyfit meter for Page Contract v1 — measures LINES, not pixels or fill %.
//
// Why one measurement is enough: the body column is 17em wide and the font's
// optical size is locked ('opsz' 20), so a paragraph breaks into the same
// lines at 16px, 20px or 23px. Tested on 612 lore-v1 pages: 0 differences
// between 18px and 22px with opsz locked (143 differences with opsz auto).
// The meter measures 1.5% narrower than the real column (narrowFactor), so
// small engine differences can only make the real page shorter, never longer.
//
// Drop-in replacement for scripts/wiki/editorial-meter.mjs:
//   const meter = await openCopyfitMeter('http://127.0.0.1:4173')
//   meter.budgets            -> old {level:{cover,photo,text}} shape for prompts
//   await meter.audit(vars)  -> string[] errors (+ .rows, .fixes, .rewrites)
//   meter.applyFixes(vars, errors.fixes) -> variants with lossless paragraph fixes
//   await meter.close()
import {chromium, webkit} from '@playwright/test'
import {
  PAGE_CONTRACT, LEVELS, pageKind, splitParagraphs, bodyLu, classifyBody,
  copyfitInstruction, paragraphCandidates, validateFocus, wordBudgets, stripCitationMarkers,
} from '../../src/lib/pageContract.js'

const REF_PX = 20

// Runs inside the browser page. Must stay self-contained (serialized).
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

const maxMerge = (a, b) => {
  if (!a) return b
  if (b.paragraphLines) return {paragraphLines: a.paragraphLines.map((n, i) => Math.max(n, b.paragraphLines[i] ?? 0))}
  return {lines: Math.max(a.lines, b.lines)}
}

/** Old budget shape so measuredGuidance(budgets) keeps working during migration. */
function legacyBudgets() {
  const wb = wordBudgets()
  return Object.fromEntries(LEVELS.map(level => {
    const y = PAGE_CONTRACT.levelYield[level]
    const shape = b => ({
      target: Math.round(b.lines * y.charsPerLine),
      min: Math.round((b.lines - 0.5) * y.charsPerLine),
      max: Math.round((b.lines + 0.5) * y.charsPerLine),
      targetWords: b.target,
      lines: b.lines,
    })
    return [level, {cover: shape(wb[level].cover), photo: shape(wb[level].inner), text: shape(wb[level].inner)}]
  }))
}

/**
 * Pure audit logic, separated from the browser so it can be unit-tested.
 * `measure(items)` must return, for each item, {lines} (title/caption) or
 * {paragraphLines: number[]} (body), exactly like measureInPage().
 */
export function createCopyfitAuditor(measure) {
  const audit = async variants => {
    const items = [], meta = []
    for (const level of LEVELS) {
      const v = variants?.[level]
      if (!v) continue
      items.push({kind: 'title', text: v.headline}); meta.push({level, what: 'title'})
      ;(v.pages || []).forEach((p, index) => {
        const kind = pageKind(index, p)
        const paragraphs = splitParagraphs(stripCitationMarkers(p.text))
        const cleaned = paragraphs.join('\n\n') !== splitParagraphs(p.text).join('\n\n')
        items.push({kind: 'body', paragraphs}); meta.push({level, what: 'body', index, kind, paragraphs, page: p, cleaned})
        if (kind !== 'card') { items.push({kind: 'caption', text: p.caption || ''}); meta.push({level, what: 'caption', index}) }
      })
    }
    const measured = await measure(items)
    const errors = [], rows = [], fixes = [], rewrites = []

    // Structure: same page count and photo positions in every level.
    const shapes = LEVELS.map(l => (variants?.[l]?.pages || []).map((p, i) => pageKind(i, p)).join(','))
    if (new Set(shapes).size > 1) errors.push(`structure: page count or photo positions differ between levels (${shapes.join(' | ')})`)
    for (const level of LEVELS) {
      const n = variants?.[level]?.pages?.length || 0
      if (n < PAGE_CONTRACT.pages.min || n > PAGE_CONTRACT.pages.max) errors.push(`${level}: ${n} pages, contract needs ${PAGE_CONTRACT.pages.min}–${PAGE_CONTRACT.pages.max}`)
    }

    const pendingCandidates = []
    meta.forEach((m, i) => {
      const r = measured[i]
      if (m.what === 'title') {
        rows.push({level: m.level, what: 'title', lines: r.lines})
        if (r.lines > PAGE_CONTRACT.titleFont.maxLines) errors.push(`${m.level} headline: ${r.lines} lines, must fit ${PAGE_CONTRACT.titleFont.maxLines} (aim ≤ ${PAGE_CONTRACT.titleFont.hintMaxChars} characters)`)
        return
      }
      if (m.what === 'caption') {
        rows.push({level: m.level, what: 'caption', index: m.index, lines: r.lines})
        if (r.lines > 1) errors.push(`${m.level} page ${m.index + 1} caption: ${r.lines} lines, must fit one line (aim ≤ ${PAGE_CONTRACT.caption.maxChars} characters)`)
        return
      }
      const lu = bodyLu(r.paragraphLines)
      const words = m.paragraphs.join(' ').split(/\s+/).filter(Boolean).length
      const verdict = classifyBody(m.kind, lu)
      // Source IDs such as "(P14, P16)" never belong in reader text: remove them losslessly.
      if (m.cleaned) fixes.push({level: m.level, index: m.index, text: m.paragraphs.join('\n\n'), lu, from: lu, reason: 'citation-markers'})
      rows.push({level: m.level, what: 'body', index: m.index, kind: m.kind, paragraphLines: r.paragraphLines, lu, words, status: verdict.status})
      if (m.kind === 'card') for (const e of validateFocus(m.page)) errors.push(`${m.level} page ${m.index + 1} ${e}`)
      if (verdict.status === 'fit') return
      const candidates = paragraphCandidates(m.paragraphs, verdict)
      if (candidates.length) pendingCandidates.push({m, verdict, candidates, lu, words})
      else {
        const ins = copyfitInstruction({level: m.level, kind: m.kind, lu, words})
        rewrites.push({level: m.level, index: m.index, ...ins})
        errors.push(`${m.level} page ${m.index + 1} (${m.kind}): ${ins.message}`)
      }
    })

    // Try lossless paragraph merges/splits before asking Gemini to rewrite.
    if (pendingCandidates.length) {
      const flat = pendingCandidates.flatMap(pc => pc.candidates.map(paragraphs => ({kind: 'body', paragraphs})))
      const res = await measure(flat)
      let k = 0
      for (const pc of pendingCandidates) {
        let chosen = null
        for (const paragraphs of pc.candidates) {
          const lu = bodyLu(res[k++].paragraphLines)
          if (!chosen && classifyBody(pc.m.kind, lu).status === 'fit') chosen = {paragraphs, lu}
        }
        if (chosen) {
          // a paragraph fix supersedes the plain citation clean-up for the same page
          const at = fixes.findIndex(f => f.level === pc.m.level && f.index === pc.m.index)
          if (at >= 0) fixes.splice(at, 1)
          fixes.push({level: pc.m.level, index: pc.m.index, text: chosen.paragraphs.join('\n\n'), lu: chosen.lu, from: pc.lu})
        }
        else {
          const ins = copyfitInstruction({level: pc.m.level, kind: pc.m.kind, lu: pc.lu, words: pc.words})
          rewrites.push({level: pc.m.level, index: pc.m.index, ...ins})
          errors.push(`${pc.m.level} page ${pc.m.index + 1} (${pc.m.kind}): ${ins.message}`)
        }
      }
    }
    return Object.assign(errors, {rows, fixes, rewrites})
  }

  const applyFixes = (variants, fixes = []) => {
    const next = structuredClone(variants)
    for (const f of fixes) next[f.level].pages[f.index].text = f.text
    return next
  }
  return {audit, applyFixes}
}

export async function openCopyfitMeter(baseURL, {engines = ['chromium'], path = '/meter.html'} = {}) {
  const launched = []
  try {
    for (const name of engines) {
      const browser = await (name === 'webkit' ? webkit : chromium).launch({headless: true})
      launched.push({name, browser})
      const page = await browser.newPage()
      await page.goto(new URL(path, baseURL).href, {waitUntil: 'load'})
      await page.evaluate(async c => {
        const sample = 'The Catalan Atlas, 1375 — ancient sea routes; “quoted” words.'
        await Promise.all([
          document.fonts.load(`${c.font.weight} 20px ${c.font.family}`, sample),
          document.fonts.load(`italic ${c.font.weight} 16px ${c.font.family}`, sample),
          document.fonts.load(`${c.titleFont.weight} 23px ${c.titleFont.family}`, sample),
        ])
        await document.fonts.ready
        if (!document.fonts.check(`${c.font.weight} 20px ${c.font.family}`, sample)) throw Error('Body font not loaded')
      }, PAGE_CONTRACT)
      launched.at(-1).page = page
    }
  } catch (error) {
    await Promise.all(launched.map(l => l.browser.close()))
    throw error
  }

  // Worst case (most lines) across engines.
  const measure = async items => {
    let merged = null
    for (const {page} of launched) {
      const res = await page.evaluate(measureInPage, {items, c: PAGE_CONTRACT, px: REF_PX})
      merged = merged ? merged.map((m, i) => maxMerge(m, res[i])) : res
    }
    return merged
  }

  const {audit, applyFixes} = createCopyfitAuditor(measure)

  return {
    contract: PAGE_CONTRACT,
    budgets: legacyBudgets(),
    wordBudgets: wordBudgets(),
    measure,
    audit,
    applyFixes,
    close: () => Promise.all(launched.map(l => l.browser.close())),
  }
}

export {measureInPage}
