/* SAGA copyfit probe — paste into the DevTools console on https://saga.id.vn
 * Measures every published page against Page Contract v1 (lines, not px)
 * and prints what would fit as-is, what needs +/- words, and what a lossless
 * paragraph merge/split already fixes. Read-only: changes nothing.
 * Optional: window.SAGA_PROBE_CATALOG = 'catalog-index-xxxx.json' to pin a catalog.
 */
(async () => {
  /*__CONTRACT__*/
  /*__MEASURE__*/
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
