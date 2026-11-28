import test from 'node:test'
import assert from 'node:assert/strict'
import {readFile} from 'node:fs/promises'
import {
  PAGE_CONTRACT, LEVELS, pageKind, slotTotalLu, bodyLu, bodyBand, classifyBody,
  wordBudget, copyfitInstruction, paragraphCandidates, photoFit, splitParagraphs, validateFocus, stripCitationMarkers,
} from '../../src/lib/pageContract.js'
import {
  copyfitGenerationRules, buildCopyfitRewritePrompt, applyCopyfitRewrite, copyfitLoop, withFocus,
} from '../wiki/copyfit-prompts.mjs'

const css = await readFile(new URL('../../src/styles/page-frame.css', import.meta.url), 'utf8')
const cssVar = (name, scope = css) => scope.match(new RegExp(`${name}:\\s*([^;]+);`))?.[1].trim()

test('slots of cover and inner pages add up to the page height', () => {
  assert.equal(slotTotalLu('cover'), PAGE_CONTRACT.gridLu)
  assert.equal(slotTotalLu('photo'), PAGE_CONTRACT.gridLu)
  assert.equal(slotTotalLu('card'), PAGE_CONTRACT.gridLu)
})

test('page-frame.css mirrors PAGE_CONTRACT', () => {
  assert.equal(cssVar('--pc-measure'), String(PAGE_CONTRACT.measureEm))
  assert.equal(cssVar('--pc-L'), String(PAGE_CONTRACT.gridLu))
  assert.equal(cssVar('--pc-fmin'), `${PAGE_CONTRACT.fontPx.min}px`)
  assert.equal(cssVar('--pc-fmax'), `${PAGE_CONTRACT.fontPx.max}px`)
  assert.equal(cssVar('--pc-side'), `${PAGE_CONTRACT.sideMarginPx}px`)
  assert.equal(cssVar('--pc-media-min'), String(PAGE_CONTRACT.slots.inner.mediaMin))
  const cover = css.slice(css.indexOf('.saga-frame--cover .saga-frame__grid'))
  assert.equal(cssVar('--pc-media-min', cover), String(PAGE_CONTRACT.slots.cover.mediaMin))
  assert.match(css, new RegExp(`'opsz' ${PAGE_CONTRACT.font.opsz}`))
  assert.match(css, new RegExp(`font-size: ${PAGE_CONTRACT.titleFont.sizeEm}em`))
  assert.match(css, new RegExp(`font-size: ${PAGE_CONTRACT.caption.sizeEm}em`))
  assert.match(css, new RegExp(`max-height: ${PAGE_CONTRACT.tight.maxFrameHeightPx}px`))
  assert.match(css, new RegExp(`max-height: ${PAGE_CONTRACT.scrollBelowFrameHeightPx}px`))
  assert.match(css, /clamp\(1\.5 \* var\(--pc-f\), 100cqh \/ var\(--pc-L\), 1\.6 \* var\(--pc-f\)\)/)
  // two title lines + padding must fit the 2.5 lu title slot at line-height 1.5
  const pad = Number(css.match(/padding-bottom: calc\(([\d.]+) \* var\(--pc-lu\)\)/)[1])
  const titleLu = 2 * PAGE_CONTRACT.titleFont.sizeEm * PAGE_CONTRACT.titleFont.lineHeight / PAGE_CONTRACT.lineHeight.min
  assert.ok(titleLu + pad <= PAGE_CONTRACT.slots.cover.title + 1e-9, `title ${titleLu + pad} lu > slot`)
})

test('pageKind: cover, photo, card', () => {
  assert.equal(pageKind(0, {}), 'cover')
  assert.equal(pageKind(2, {image: 'x.jpg'}), 'photo')
  assert.equal(pageKind(2, {imageId: 'IMG_1'}), 'photo')
  assert.equal(pageKind(2, {imageId: null}), 'card')
})

test('bodyLu adds half a line between paragraphs', () => {
  assert.equal(bodyLu([4, 4]), 8.5)
  assert.equal(bodyLu([9]), 9)
  assert.equal(bodyLu([3, 3, 2]), 9)
  assert.equal(bodyLu([]), 0)
})

test('classifyBody uses the [cap-1, cap] band', () => {
  assert.deepEqual(bodyBand('photo'), {min: 8, max: 9})
  assert.deepEqual(bodyBand('cover'), {min: 6.5, max: 7.5})
  assert.equal(classifyBody('photo', 8.5).status, 'fit')
  assert.equal(classifyBody('card', 8).status, 'fit')
  assert.deepEqual(classifyBody('photo', 10.5), {status: 'long', deltaLu: 1.5, band: {min: 8, max: 9}})
  assert.deepEqual(classifyBody('photo', 6.5), {status: 'short', deltaLu: -1.5, band: {min: 8, max: 9}})
  assert.equal(classifyBody('cover', 8).status, 'long')
})

test('word budgets follow measured yield per level', () => {
  assert.deepEqual(wordBudget('A1-A2', 'photo'), {target: 47, min: 44, max: 50, lines: 8, paragraphs: 2})
  assert.deepEqual(wordBudget('B1-B2', 'photo'), {target: 41, min: 38, max: 44, lines: 8, paragraphs: 2})
  assert.deepEqual(wordBudget('C1-C2', 'photo'), {target: 31, min: 29, max: 33, lines: 8, paragraphs: 2})
  assert.equal(wordBudget('A1-A2', 'cover').target, 38)
  assert.equal(wordBudget('C1-C2', 'cover').target, 26)
})

test('copyfitInstruction asks for a concrete word delta', () => {
  assert.equal(copyfitInstruction({level: 'B1-B2', kind: 'photo', lu: 8.5, words: 41}), null)
  const cut = copyfitInstruction({level: 'B1-B2', kind: 'card', lu: 11.5, words: 56})
  assert.equal(cut.status, 'long')
  assert.ok(cut.deltaWords < 0)
  assert.match(cut.message, /CUT about \d+ words/)
  const add = copyfitInstruction({level: 'A1-A2', kind: 'photo', lu: 6.5, words: 37})
  assert.equal(add.status, 'short')
  assert.ok(add.deltaWords > 0)
  assert.match(add.message, /ADD about \d+ words/)
  assert.ok(add.targetWords > 37)
})

test('paragraphCandidates merges or splits without changing words', () => {
  const p = ['First sentence here is long enough to count. Second sentence is also long enough to stand here.', 'Another paragraph with enough words to stand alone on the page today.']
  const merges = paragraphCandidates(p, {status: 'long', deltaLu: 0.5})
  assert.equal(merges.length, 1)
  assert.equal(merges[0].length, 1)
  assert.equal(merges[0][0].split(/\s+/).length, p.join(' ').split(/\s+/).length)
  const splits = paragraphCandidates([p[0]], {status: 'short', deltaLu: -0.5})
  assert.equal(splits.length, 1)
  assert.equal(splits[0].length, 2)
  assert.equal(splits[0].join(' '), p[0])
  assert.deepEqual(paragraphCandidates(p, {status: 'long', deltaLu: 3}), [])
})

test('photoFit crops only when the aspect is close to the slot', () => {
  assert.equal(photoFit(1500, 1000, 358, 264), 'cover')      // 3:2 in 1.36 slot
  assert.equal(photoFit(800, 1200, 309, 164), 'contain')     // portrait in 1.89 slot
  assert.equal(photoFit(2000, 600, 391, 315), 'contain')     // panorama in 1.24 slot
  assert.equal(photoFit(0, 0, 300, 200), 'contain')
})

test('splitParagraphs matches the reader', () => {
  assert.deepEqual(splitParagraphs('A  b.\n\n  C d.\n \n'), ['A b.', 'C d.'])
})

test('validateFocus checks count, presence and lengths', () => {
  const page = {text: 'Sailors used the atlas to plan a safe route across the sea.', focus: [
    {surface: 'atlas', ipa: '/ˈæt.ləs/', vi: 'tập bản đồ'},
    {surface: 'route', ipa: '/ruːt/', vi: 'tuyến đường'},
    {surface: 'sailors', ipa: '/ˈseɪ.lərz/', vi: 'thủy thủ'},
  ]}
  assert.deepEqual(validateFocus(page), [])
  assert.equal(validateFocus({...page, focus: page.focus.slice(0, 2)}).length, 1)
  assert.match(validateFocus({...page, focus: [...page.focus.slice(0, 2), {surface: 'harbour', ipa: '/x/', vi: 'cảng'}]})[0], /not in the page text/)
})

test('generation rules carry the word targets and the shared page plan', () => {
  const rules = copyfitGenerationRules()
  for (const level of LEVELS) assert.match(rules, new RegExp(level))
  assert.match(rules, /SAME number of pages/)
  assert.match(rules, /Do NOT count characters/)
  assert.match(rules, /"focus"/)
  const schema = withFocus({type: 'object', properties: {text: {type: 'string'}}, required: ['text']})
  assert.deepEqual(schema.required, ['text', 'focus'])
})

const draftFixture = () => ({variants: Object.fromEntries(LEVELS.map(level => [level, {
  headline: 'A Map That Sailors Trusted',
  pages: [
    {text: 'Cover text.', imageId: 'IMG_0', caption: 'Catalan Atlas, 1375', evidenceIds: ['P1']},
    {text: 'Page two text.', imageId: null, caption: '', evidenceIds: ['P2']},
  ],
}]))})

test('rewrite prompt lists only the failing fields', () => {
  const draft = draftFixture()
  const audit = Object.assign(['B1-B2 page 2 (card): …', 'C1-C2 headline: 3 lines, must fit 2 (aim ≤ 50 characters)'], {
    rewrites: [{level: 'B1-B2', index: 1, message: 'B1-B2 page card: CUT about 8 words', targetWords: 41}],
  })
  const prompt = buildCopyfitRewritePrompt({source: {sourceTitle: 'Catalan Atlas', sourceRevisionId: 1}, evidence: [{id: 'P1', heading: 'Lead', text: 'x'}], draft, audit})
  assert.match(prompt, /"field": "text"/)
  assert.match(prompt, /"field": "headline"/)
  assert.match(prompt, /CUT about 8 words/)
  assert.doesNotMatch(prompt, /"level": "A1-A2"/)
})

test('applyCopyfitRewrite edits only named fields', () => {
  const draft = draftFixture()
  const next = applyCopyfitRewrite(draft, {edits: [
    {level: 'B1-B2', page: 2, field: 'text', value: 'New text.', evidenceIds: ['P2']},
    {level: 'C1-C2', page: 1, field: 'headline', value: 'Shorter Title'},
    {level: 'A1-A2', page: 9, field: 'text', value: 'ignored'},
  ]})
  assert.equal(next.variants['B1-B2'].pages[1].text, 'New text.')
  assert.equal(next.variants['C1-C2'].headline, 'Shorter Title')
  assert.equal(next.variants['A1-A2'].pages[1].text, 'Page two text.')
  assert.equal(draft.variants['B1-B2'].pages[1].text, 'Page two text.')
})

test('copyfitLoop: paragraph fix first, then one targeted rewrite, then pass', async () => {
  let audits = 0
  const meter = {
    audit: async variants => {
      audits++
      const t = variants['B1-B2'].pages[1].text
      if (t === 'Page two text.') return Object.assign(['B1-B2 page 2 (card): long'], {fixes: [], rewrites: [{level: 'B1-B2', index: 1, message: 'CUT about 5 words', targetWords: 40}]})
      return Object.assign([], {fixes: [], rewrites: []})
    },
    applyFixes: v => v,
  }
  const calls = []
  const callGemini = async prompt => { calls.push(prompt); return {edits: [{level: 'B1-B2', page: 2, field: 'text', value: 'Shorter page two.'}]} }
  const result = await copyfitLoop({draft: draftFixture(), meter, source: {sourceTitle: 'x', sourceRevisionId: 1}, evidence: [], callGemini})
  assert.equal(result.ok, true)
  assert.equal(result.rounds, 1)
  assert.equal(calls.length, 1)
  assert.equal(audits, 2)
  assert.equal(result.draft.variants['B1-B2'].pages[1].text, 'Shorter page two.')
})

test('copyfitLoop gives up after maxRounds and reports not ok', async () => {
  const meter = {audit: async () => Object.assign(['still long'], {fixes: [], rewrites: [{level: 'A1-A2', index: 1, message: 'CUT', targetWords: 40}]}), applyFixes: v => v}
  const result = await copyfitLoop({draft: draftFixture(), meter, source: {sourceTitle: 'x', sourceRevisionId: 1}, evidence: [], callGemini: async () => ({edits: []}), maxRounds: 2})
  assert.equal(result.ok, false)
  assert.equal(result.rounds, 2)
})

test('refitStory: rebuilds evidence, runs the loop, marks the story as contract v1', async () => {
  const {refitStory} = await import('../wiki/refit-catalog.mjs')
  const {createHash} = await import('node:crypto')
  const passage = 'The Catalan Atlas is a medieval world map made in 1375 for sailors.'
  const story = {
    sourcePageId: 1, sourceTitle: 'Catalan Atlas', sourceRevisionId: 2,
    sourceEvidence: [{id: 'P1', heading: 'Lead', hash: createHash('sha256').update(passage).digest('hex'), excerpt: passage.slice(0, 40)}],
    levelVariants: draftFixture().variants,
  }
  const meter = {
    audit: async v => v['A1-A2'].pages[1].text === 'Page two text.'
      ? Object.assign(['A1-A2 page 2 (card): long'], {fixes: [], rewrites: [{level: 'A1-A2', index: 1, message: 'CUT', targetWords: 40}]})
      : Object.assign([], {fixes: [], rewrites: []}),
    applyFixes: v => v,
  }
  const seen = []
  const res = await refitStory(story, {
    meter,
    callGemini: async prompt => { seen.push(prompt); return {edits: [{level: 'A1-A2', page: 2, field: 'text', value: 'Fitted page two.'}]} },
    fetchSource: async () => ({paragraphDetails: [{heading: 'Lead', text: passage}]}),
    validate: () => ({accepted: true, errors: []}),
    factCheck: () => ({ok: true, errors: []}),
    now: () => new Date('2026-11-28T00:00:00Z'),
  })
  assert.equal(res.status, 'ok')
  assert.equal(res.story.pageContractVersion, PAGE_CONTRACT.version)
  assert.equal(res.story.levelVariants['A1-A2'].pages[1].text, 'Fitted page two.')
  assert.deepEqual(res.story.pages, res.story.levelVariants['B1-B2'].pages)
  assert.match(seen[0], /medieval world map/)            // full passage, not the excerpt
  assert.equal(story.levelVariants['A1-A2'].pages[1].text, 'Page two text.') // input untouched
})

test('refitStory stops when cited passages cannot be found', async () => {
  const {refitStory} = await import('../wiki/refit-catalog.mjs')
  const res = await refitStory({sourceEvidence: [{id: 'P1', hash: 'x', excerpt: 'nothing'}], levelVariants: draftFixture().variants}, {
    meter: {audit: async () => Object.assign([], {fixes: [], rewrites: []}), applyFixes: v => v},
    fetchSource: async () => ({paragraphDetails: [{heading: 'Lead', text: 'Unrelated text.'}]}),
  })
  assert.equal(res.status, 'no-evidence')
})

test('stripCitationMarkers removes leaked evidence IDs only', () => {
  assert.equal(stripCitationMarkers('Trade networks grew (P14, P16).'), 'Trade networks grew.')
  assert.equal(stripCitationMarkers('Sealed in 1215 (P8). Later [P2; P3] it changed.'), 'Sealed in 1215. Later it changed.')
  assert.equal(stripCitationMarkers('Page 14 (Part 2) and P.S. stay.'), 'Page 14 (Part 2) and P.S. stay.')
})

// Fake measure: greedy wrap at 32 characters per line (titles 26, captions 40).
const wrap = (text, width) => {
  let lines = 0, cur = 0
  for (const w of String(text).split(/\s+/).filter(Boolean)) {
    if (!cur) { lines++; cur = w.length } else if (cur + 1 + w.length <= width) cur += 1 + w.length; else { lines++; cur = w.length }
  }
  return lines
}
const fakeMeasure = async items => items.map(it => it.kind === 'title' ? {lines: wrap(it.text, 26)}
  : it.kind === 'caption' ? {lines: it.text ? wrap(it.text, 40) : 0}
  : {paragraphLines: it.paragraphs.map(p => wrap(p, 32))})
const words = (n, w = 'word') => Array.from({length: n}, () => w).join(' ')
const page = (lines, extra = {}) => ({text: `${words(lines * 6 - 3)}.\n\n${words(3)}.`, caption: 'Short caption', image: 'x.jpg', evidenceIds: ['P1'], ...extra})

test('auditor: clean contract passes; leaked IDs become a lossless fix', async () => {
  const {createCopyfitAuditor} = await import('../wiki/copyfit-meter.mjs')
  const {audit} = createCopyfitAuditor(fakeMeasure)
  const focus = [{surface: 'word', ipa: '/wɜːd/', vi: 'từ'}, {surface: 'word word', ipa: '/x/', vi: 'cụm từ'}, {surface: 'Word', ipa: '/y/', vi: 'từ (hoa)'}]
  const level = () => ({headline: 'A Short Headline', pages: [
    {text: `${words(30)}.\n\n${words(6)}.`, caption: 'Cover', image: 'c.jpg', evidenceIds: ['P1']},
    {text: `${words(36)}.\n\n${words(11)} (P14, P16).`, caption: '', image: '', evidenceIds: ['P1'], focus},
    {text: `${words(36)}.\n\n${words(11)}.`, caption: 'Photo', image: 'p.jpg', evidenceIds: ['P1']},
    {text: `${words(36)}.\n\n${words(11)}.`, caption: '', image: '', evidenceIds: ['P1'], focus},
  ]})
  const variants = Object.fromEntries(LEVELS.map(l => [l, level()]))
  const res = await audit(variants)
  assert.deepEqual([...res], [])
  assert.equal(res.fixes.length, 3)                       // one per level, page 2
  assert.ok(res.fixes.every(f => !/P14/.test(f.text) && f.reason === 'citation-markers'))
  assert.ok(res.rows.filter(r => r.what === 'body').every(r => r.status === 'fit'))
})

test('auditor: long card page gets a word delta, long title and caption are flagged, structure is compared', async () => {
  const {createCopyfitAuditor} = await import('../wiki/copyfit-meter.mjs')
  const {audit} = createCopyfitAuditor(fakeMeasure)
  const base = () => ({headline: 'A Short Headline', pages: [
    {text: `${words(30)}.\n\n${words(6)}.`, caption: 'Cover', image: 'c.jpg', evidenceIds: ['P1']},
    {text: `${words(36)}.\n\n${words(11)}.`, caption: 'Photo', image: 'p.jpg', evidenceIds: ['P1']},
    {text: `${words(36)}.\n\n${words(11)}.`, caption: 'Photo two', image: 'q.jpg', evidenceIds: ['P1']},
    {text: `${words(36)}.\n\n${words(11)}.`, caption: 'Photo three', image: 'r.jpg', evidenceIds: ['P1']},
  ]})
  const variants = Object.fromEntries(LEVELS.map(l => [l, base()]))
  variants['B1-B2'].pages[3] = {text: `${words(70)}.\n\n${words(30)}.`, caption: '', image: '', evidenceIds: ['P1'], focus: []}
  variants['C1-C2'].headline = 'A Much Longer Headline That Cannot Possibly Fit In Two Lines Of The Cover'
  variants['A1-A2'].pages[1].caption = 'A caption that is far too long to fit on one single line of the frame'
  const res = await audit(variants)
  const text = res.join('\n')
  assert.match(text, /structure: page count or photo positions differ/)
  assert.match(text, /C1-C2 headline: \d lines, must fit 2/)
  assert.match(text, /A1-A2 page 2 caption: 2 lines/)
  assert.match(text, /B1-B2 page 4 focus: need exactly 3 items/)
  const r = res.rewrites.find(x => x.level === 'B1-B2' && x.index === 3)
  assert.equal(r.status, 'long')
  assert.ok(r.deltaWords < -20)
})

test('auditor: a paragraph merge that fits is offered instead of a rewrite', async () => {
  const {createCopyfitAuditor} = await import('../wiki/copyfit-meter.mjs')
  const {audit, applyFixes} = createCopyfitAuditor(fakeMeasure)
  const p2 = `${words(48)}.\n\n${words(4)}.` // 8 + 1 lines + gap = 9.5 lu, merged = 9 lines
  const level = () => ({headline: 'A Short Headline', pages: [
    {text: `${words(30)}.\n\n${words(6)}.`, caption: 'Cover', image: 'c.jpg', evidenceIds: ['P1']},
    {text: p2, caption: 'Photo', image: 'p.jpg', evidenceIds: ['P1']},
    {text: `${words(36)}.\n\n${words(11)}.`, caption: 'Photo', image: 'q.jpg', evidenceIds: ['P1']},
    {text: `${words(36)}.\n\n${words(11)}.`, caption: 'Photo', image: 'r.jpg', evidenceIds: ['P1']},
  ]})
  const variants = Object.fromEntries(LEVELS.map(l => [l, level()]))
  const res = await audit(variants)
  assert.deepEqual([...res], [])
  assert.equal(res.fixes.length, 3)
  const fixed = applyFixes(variants, res.fixes)
  assert.equal(splitParagraphs(fixed['A1-A2'].pages[1].text).length, 1)
  assert.equal(fixed['A1-A2'].pages[1].text.split(/\s+/).length, p2.split(/\s+/).length)
  const again = await audit(fixed)
  assert.equal(again.fixes.length, 0)
})
