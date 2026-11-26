import test from 'node:test'
import assert from 'node:assert/strict'
import {
  extractSemanticParagraphs,
  mapSemanticPageIndex,
  planParagraphAwareWikiPages,
  splitParagraphs,
} from '../../src/lib/readerPagination.js'
import { makePaginationCacheKey } from '../../src/lib/paginationCache.js'
import { sanitizeReadingArticle } from '../../src/lib/articleCleanup.js'
import {
  mergeTargetedRepairs,
  normalizeDraftForCatalog,
  normalizeParagraphText,
} from '../publish_wiki_batch.mjs'

function makeMultiParagraphStory({ withSecondaryPhoto = true } = {}) {
  return {
    id: 'saga-wiki:77001',
    title: 'How Canal Locks Lifted Ships Over Dry Hills',
    contentType: 'wiki',
    pages: [
      {
        image: 'https://upload.wikimedia.org/wikipedia/commons/fixture/canal-cover.jpg',
        caption: 'Boats waiting beside stone lock walls.',
        text: 'Natural waterways rarely offered smooth routes between seaports and inland workshops, because steep ridges and shallow rapids blocked loaded barges.\n\nTo bridge those elevation gaps without unloading cargo, engineers designed stepped stone chambers known as pound locks.',
      },
      {
        image: '',
        caption: '',
        text: 'Each lock chamber sits between two sealed gates and fills solely through gravity-fed culverts built into its masonry walls. Once a barge enters from the lower reach, operators close the tail gate and raise sluice paddles.\n\nWater pours gently from the upper canal until both levels equalize, lifting hundreds of tons of timber or grain without a single pump.',
      },
      {
        image: withSecondaryPhoto ? 'https://upload.wikimedia.org/wikipedia/commons/fixture/lock-gate.jpg' : '',
        caption: withSecondaryPhoto ? 'Angled wooden doors holding back water.' : '',
        text: 'The defining breakthrough was the miter gate, whose twin timber leaves meet at a shallow upstream angle rather than standing flat across the channel.\n\nOnly after water pressure balances on both sides can lock keepers swing the heavy beams open with modest leverage.',
      },
      {
        image: '',
        caption: '',
        text: 'Managing water supply along summit sections proved far harder than digging straight trenches. Every vessel crossing the crest released an entire chamber of stored water downhill.\n\nCanal companies therefore constructed highland feeder reservoirs, puddle-clay linings, and side-saving basins that recycled nearly half of each lockage.',
      },
      {
        image: '',
        caption: '',
        text: 'Although railways eventually captured urgent passenger traffic, commercial canals continued hauling bulk commodities cheaply for generations.\n\nRestored lock flights now serve heritage vessels and municipal trails while demonstrating how timeless gravity hydraulics remain.',
      },
    ],
  }
}

test('paragraph-aware content normalization preserves blank-line boundaries and optional paragraphs arrays across draft and repair flows', () => {
  assert.equal(
    normalizeParagraphText('First paragraph.  \n\n  Second   paragraph.\r\n\r\nThird one', null, { ensureTerminalPunctuation: true }),
    'First paragraph.\n\nSecond paragraph.\n\nThird one.'
  )
  assert.equal(
    normalizeParagraphText('ignored flat text', ['Alpha paragraph.', 'Beta paragraph without period'], { ensureTerminalPunctuation: true }),
    'Alpha paragraph.\n\nBeta paragraph without period.'
  )

  const evidence = [
    { id: 'P1', text: 'Canal locks use gravity-fed chambers and wooden miter gates across hills.' },
    { id: 'P2', text: 'Summit reservoirs store rain and recycle water during dry summer seasons.' },
  ]
  const rawDraft = {
    variants: Object.fromEntries(['A1-A2', 'B1-B2', 'C1-C2'].map(level => [level, {
      headline: `How Canal Locks Shaped ${level} Trade Routes`,
      pages: [
        { text: 'First beat paragraph.\n\nSecond beat paragraph.', imageId: 'IMG_0', caption: 'Stone lock walls', evidenceIds: ['P1'] },
        { text: '', paragraphs: ['Gravity lifts barges cleanly.', 'Valves open smoothly.'], imageId: null, caption: '', evidenceIds: ['P1'] },
        { text: 'Miter gates seal under pressure.\n\nKeepers open beams easily.', imageId: null, caption: '', evidenceIds: ['P1'] },
        { text: 'Reservoirs catch rain.\n\nClay linings stop leaks.', imageId: null, caption: '', evidenceIds: ['P2'] },
      ],
    }])),
  }

  const normalized = normalizeDraftForCatalog(rawDraft, {
    source: { sourceTitle: 'Canal lock' },
    evidence,
    verifiedPhotos: [{ imageId: 'IMG_0' }],
  })
  assert.deepEqual(splitParagraphs(normalized.variants['B1-B2'].pages[0].text), ['First beat paragraph.', 'Second beat paragraph.'])
  assert.deepEqual(splitParagraphs(normalized.variants['B1-B2'].pages[1].text), ['Gravity lifts barges cleanly.', 'Valves open smoothly.'])

  const repaired = mergeTargetedRepairs(
    normalized,
    { repairs: { 'B1-B2': { pages: [{ pageIndex: 1, text: 'Repaired first para.\n\nRepaired second para.', evidenceIds: ['P1'] }] } } },
    { useTargetedPatch: true, targetSummary: [{ level: 'B1-B2', headline: false, pageIndexes: [1] }] }
  )
  assert.deepEqual(splitParagraphs(repaired.variants['B1-B2'].pages[1].text), ['Repaired first para.', 'Repaired second para.'])

  // Reader media-credit cleanup also preserves paragraph breaks
  const cleaned = sanitizeReadingArticle({
    pages: [{ image: '', text: 'Image by Jane Doe.\n\nFirst real paragraph.\n\nSecond real paragraph.' }],
  })
  assert.deepEqual(splitParagraphs(cleaned.pages[0].text), ['First real paragraph.', 'Second real paragraph.'])
})

test('planParagraphAwareWikiPages keeps every paragraph intact, targets 4-6 pages, preserves secondary image anchoring, and maintains 100% lossless text', () => {
  const story = makeMultiParagraphStory({ withSecondaryPhoto: true })
  const sourceParas = extractSemanticParagraphs(story).paragraphs.map(p => p.text)
  const expectedFlat = sourceParas.join(' ')

  // Simulate realistic 390x844 phone height metrics
  const measurePhone = ({ text, cover, image }) => {
    const avail = image ? (cover ? 250 : 285) : 520
    const paras = splitParagraphs(text)
    const lines = paras.reduce((sum, p) => sum + Math.ceil(p.length / 40), 0)
    const used = lines * 25 + Math.max(0, paras.length - 1) * 12
    const fits = used <= avail
    return {
      fits,
      usedHeight: used,
      availableHeight: avail,
      bottomWhitespacePx: Math.max(0, avail - used),
      unusedVerticalPx: Math.max(0, avail - used),
      overflowPx: Math.max(0, used - avail),
    }
  }
  const fitsPhone = c => measurePhone(c).fits
  fitsPhone.measure = measurePhone

  const planned = planParagraphAwareWikiPages(story, fitsPhone, { measure: measurePhone })
  assert.ok(Array.isArray(planned) && planned.length >= 4 && planned.length <= 6, `Expected 4-6 pages, got ${planned?.length}`)

  // Every rendered paragraph matches a complete source paragraph verbatim (0 broken paragraphs)
  const renderedParas = planned.flatMap(p => splitParagraphs(p.text))
  assert.deepEqual(renderedParas, sourceParas)
  assert.equal(renderedParas.join(' '), expectedFlat)

  // Cover photo stays on Page 0; secondary photo stays on a page containing Section 2 (miter gate)
  assert.match(planned[0].image, /canal-cover\.jpg/)
  const secPhotoIdx = planned.findIndex(p => /lock-gate\.jpg/.test(p.image))
  assert.ok(secPhotoIdx > 0, 'Secondary photo must appear on a body page')
  assert.ok(planned[secPhotoIdx].sourceSectionIndices.includes(2), 'Secondary photo must remain anchored to section 2')
  assert.match(planned[secPhotoIdx].text, /miter gate|water pressure/i)
})

test('planParagraphAwareWikiPages keeps genuinely oversized single paragraphs intact with dense scrolling fallback instead of clipping or splitting', () => {
  const megaParagraph = 'Early cinema relied on fragile nitrate and acetate film bases that accelerated chemical decay whenever warm air and elevated humidity penetrated ordinary storage cabinets, causing frames to buckle and vibrant dye layers to fade rapidly. Because manually inspecting and scanning millions of historic reels demanded decades of laboratory work, archivists transferred sealed metal canisters into subzero underground vaults to slow molecular breakdown tenfold and preserve cultural memory for future generations.'
  const story = {
    id: 'saga-wiki:77002',
    title: 'Why Libraries Built Underground Cold Vaults For Film',
    contentType: 'wiki',
    pages: [
      { image: 'https://upload.wikimedia.org/wikipedia/commons/fixture/archive-cover.jpg', caption: 'Film cans in cold storage.', text: 'Motion-picture reels sealed in steel cans appear remarkably sturdy, yet ordinary room temperatures silently trigger chemical decay that fades dyes and warps soundtracks.\n\nTo halt that hidden deterioration, national archives constructed climate-controlled underground vaults.' },
      { image: '', caption: '', text: megaParagraph },
      { image: '', caption: '', text: 'Retrieving a reel from sub-zero storage requires strict patience rather than rushing straight to a screening room. Technicians stage each sealed canister inside an intermediate acclimatization chamber for twenty-four hours.\n\nGradual warming prevents airborne moisture from condensing directly onto cold gelatin emulsions.' },
      { image: '', caption: '', text: 'High-resolution scanning expands public access dramatically, yet digital formats require continuous hardware migration and costly server upkeep.\n\nCombining cold analog storage with open digital preservation therefore remains the gold standard for safeguarding visual memory.' },
    ],
  }

  // Tight 360x740 viewport where megaParagraph alone exceeds available height
  const measureTight = ({ text, image }) => {
    const avail = image ? 180 : 320
    const used = Math.ceil(text.length / 34) * 26
    return {
      fits: used <= avail,
      usedHeight: used,
      availableHeight: avail,
      bottomWhitespacePx: Math.max(0, avail - used),
      unusedVerticalPx: Math.max(0, avail - used),
      overflowPx: Math.max(0, used - avail),
    }
  }
  const planned = planParagraphAwareWikiPages(story, c => measureTight(c).fits, { measure: measureTight })
  assert.ok(planned && planned.length >= 4 && planned.length <= 6, `Expected 4-6 pages, got ${planned?.length}`)
  const megaPage = planned.find(p => p.text.includes('autocatalytic') || p.text.includes('fragile nitrate'))
  assert.ok(megaPage, 'Oversized paragraph must be preserved intact')
  assert.equal(megaPage.text, megaParagraph, 'Oversized paragraph must NOT be split mid-sentence')
  assert.match(String(megaPage.density || ''), /saga-page--dense/, 'Oversized intact paragraph must activate safe scrolling fallback')
})

test('mapSemanticPageIndex preserves semantic reading position across A/B/C level switches even when rendered page counts differ', () => {
  // Level A renders in 4 pages, Level B in 5 pages, Level C in 6 pages for the same 5 editorial sections
  const pagesA = [
    { sourceSectionIndices: [0], sourceSectionCount: 5, semanticRange: { start: 0.0, end: 0.2, mid: 0.1 } },
    { sourceSectionIndices: [1, 2], sourceSectionCount: 5, semanticRange: { start: 0.2, end: 0.55, mid: 0.375 } },
    { sourceSectionIndices: [2, 3], sourceSectionCount: 5, semanticRange: { start: 0.55, end: 0.8, mid: 0.675 } },
    { sourceSectionIndices: [4], sourceSectionCount: 5, semanticRange: { start: 0.8, end: 1.0, mid: 0.9 } },
  ]
  const pagesB = [
    { sourceSectionIndices: [0], sourceSectionCount: 5, semanticRange: { start: 0.0, end: 0.2, mid: 0.1 } },
    { sourceSectionIndices: [1], sourceSectionCount: 5, semanticRange: { start: 0.2, end: 0.4, mid: 0.3 } },
    { sourceSectionIndices: [2], sourceSectionCount: 5, semanticRange: { start: 0.4, end: 0.6, mid: 0.5 } },
    { sourceSectionIndices: [3], sourceSectionCount: 5, semanticRange: { start: 0.6, end: 0.8, mid: 0.7 } },
    { sourceSectionIndices: [4], sourceSectionCount: 5, semanticRange: { start: 0.8, end: 1.0, mid: 0.9 } },
  ]
  const pagesC = [
    { sourceSectionIndices: [0], sourceSectionCount: 5, semanticRange: { start: 0.0, end: 0.15, mid: 0.075 } },
    { sourceSectionIndices: [0, 1], sourceSectionCount: 5, semanticRange: { start: 0.15, end: 0.35, mid: 0.25 } },
    { sourceSectionIndices: [1, 2], sourceSectionCount: 5, semanticRange: { start: 0.35, end: 0.5, mid: 0.425 } },
    { sourceSectionIndices: [2], sourceSectionCount: 5, semanticRange: { start: 0.5, end: 0.65, mid: 0.575 } },
    { sourceSectionIndices: [3], sourceSectionCount: 5, semanticRange: { start: 0.65, end: 0.82, mid: 0.735 } },
    { sourceSectionIndices: [4], sourceSectionCount: 5, semanticRange: { start: 0.82, end: 1.0, mid: 0.91 } },
  ]

  // Cover stays cover; closing card stays closing card
  assert.equal(mapSemanticPageIndex(pagesB, 0, pagesC), 0)
  assert.equal(mapSemanticPageIndex(pagesB, pagesB.length, pagesC), pagesC.length)
  assert.equal(mapSemanticPageIndex(pagesB, pagesB.length, pagesA), pagesA.length)

  // Mid-article section 2 (index 2 in B) maps to a section-2 page in both A and C (never resets to 0!)
  const idxInA = mapSemanticPageIndex(pagesB, 2, pagesA)
  assert.ok(idxInA === 1 || idxInA === 2, `Expected B page 2 -> A page 1 or 2, got ${idxInA}`)
  assert.ok(pagesA[idxInA].sourceSectionIndices.includes(2))

  const idxInC = mapSemanticPageIndex(pagesB, 2, pagesC)
  assert.ok(idxInC === 2 || idxInC === 3, `Expected B page 2 -> C page 2 or 3, got ${idxInC}`)
  assert.ok(pagesC[idxInC].sourceSectionIndices.includes(2))

  // Section 3 (index 3 in B) maps to section 3 in C (index 4)
  assert.equal(mapSemanticPageIndex(pagesB, 3, pagesC), 4)
})

test('makePaginationCacheKey invalidates on content, viewport, fontVersion, and image dimension changes', () => {
  const base = makePaginationCacheKey({
    storyId: 'saga-wiki:1',
    readingLevel: 'B1-B2',
    colWidth: 390,
    colHeight: 844,
    mediaSig: '800x520',
    contentSig: '5:abc123',
    fontVersion: 1,
  })
  assert.notEqual(base, makePaginationCacheKey({ storyId: 'saga-wiki:1', readingLevel: 'B1-B2', colWidth: 360, colHeight: 740, mediaSig: '800x520', contentSig: '5:abc123', fontVersion: 1 }))
  assert.notEqual(base, makePaginationCacheKey({ storyId: 'saga-wiki:1', readingLevel: 'B1-B2', colWidth: 390, colHeight: 844, mediaSig: '800x600', contentSig: '5:abc123', fontVersion: 1 }))
  assert.notEqual(base, makePaginationCacheKey({ storyId: 'saga-wiki:1', readingLevel: 'B1-B2', colWidth: 390, colHeight: 844, mediaSig: '800x520', contentSig: '5:xyz999', fontVersion: 1 }))
  assert.notEqual(base, makePaginationCacheKey({ storyId: 'saga-wiki:1', readingLevel: 'B1-B2', colWidth: 390, colHeight: 844, mediaSig: '800x520', contentSig: '5:abc123', fontVersion: 2 }))
})
