import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import {
  MICRO_FIT_FLOORS,
  computeBoundedMicroFit,
  planEditorialWikiPages,
} from '../../src/lib/readerPagination.js'

test('computeBoundedMicroFit returns no-op when baseline already fits', () => {
  let calls = 0
  const result = computeBoundedMicroFit({
    baseBodyPx: 17,
    baseLineHeight: 1.5,
    basePhotoMaxPx: 200,
    viewportHeight: 844,
    hasPhoto: true,
    testFit: spec => {
      calls++
      assert.equal(spec, null)
      return true
    },
  })
  assert.deepEqual(result, {fits: true, microFit: null, dense: false})
  assert.equal(calls, 1)
})

test('computeBoundedMicroFit steps body font-size in 0.5px increments and stops immediately on fit', () => {
  const tried = []
  const result = computeBoundedMicroFit({
    baseBodyPx: 17,
    baseLineHeight: 1.5,
    basePhotoMaxPx: 185,
    viewportHeight: 667,
    hasPhoto: true,
    alreadyOverflowing: true,
    testFit: spec => {
      tried.push({...spec})
      return spec.bodyPx <= 16
    },
  })
  assert.equal(result.fits, true)
  assert.equal(result.dense, false)
  assert.deepEqual(result.microFit, {bodyPx: 16})
  assert.deepEqual(tried, [{bodyPx: 16.5}, {bodyPx: 16}])
})

test('computeBoundedMicroFit steps line-height down to 1.42 and photo max-height down to max(105px, 18dvh)', () => {
  const tried = []
  const result = computeBoundedMicroFit({
    baseBodyPx: 16,
    baseLineHeight: 1.48,
    basePhotoMaxPx: 150,
    viewportHeight: 667, // 18% = 120px (> 105px floor)
    hasPhoto: true,
    alreadyOverflowing: true,
    testFit: spec => {
      tried.push({...spec})
      return Boolean(spec.photoMaxPx && spec.photoMaxPx <= 120)
    },
  })
  assert.equal(result.fits, true)
  assert.equal(result.dense, false)
  assert.equal(result.microFit.bodyPx, MICRO_FIT_FLOORS.minBodyPx)
  assert.equal(result.microFit.lineHeight, MICRO_FIT_FLOORS.minLineHeight)
  assert.equal(result.microFit.photoMaxPx, 120)
  assert.ok(tried.every(s => (s.bodyPx ?? 16) >= 15))
  assert.ok(tried.every(s => (s.lineHeight ?? 1.48) >= 1.42))
  assert.ok(tried.every(s => (s.photoMaxPx ?? 150) >= 120))
})

test('computeBoundedMicroFit respects 105px absolute minimum photo floor on very short screens', () => {
  const seenPhotoHeights = []
  const result = computeBoundedMicroFit({
    baseBodyPx: 15.5,
    baseLineHeight: 1.44,
    basePhotoMaxPx: 125,
    viewportHeight: 500, // 18% = 90px -> clamped up to 105px floor
    hasPhoto: true,
    alreadyOverflowing: true,
    testFit: spec => {
      if (spec.photoMaxPx) seenPhotoHeights.push(spec.photoMaxPx)
      return false
    },
  })
  assert.deepEqual(result, {fits: false, microFit: null, dense: true})
  assert.equal(Math.min(...seenPhotoHeights), 105)
})

test('planEditorialWikiPages uses bounded microFit before dense fallback and preserves authored slots', () => {
  const pages = Array.from({length: 5}, (_, i) => ({
    text: `Editorial slot ${i + 1}. Complete sentence preserved.`,
    image: i === 0 ? 'cover.jpg' : '',
  }))
  const levelVariants = {
    'A1-A2': {headline: 'Charter', pages},
    'B1-B2': {headline: 'Charter', pages},
    'C1-C2': {headline: 'Charter', pages},
  }
  const planned = planEditorialWikiPages(
    {pages, levelVariants, readingLevel: 'B1-B2'},
    candidate => candidate.text.includes('slot 1') ? false : !candidate.text.includes('slot 5'),
    {
      fitPage: candidate => {
        if (candidate.text.includes('slot 1')) {
          return {fits: true, microFit: {bodyPx: 15.5}, dense: false}
        }
        return {fits: false, microFit: null, dense: true}
      },
    }
  )
  assert.equal(planned.length, 5)
  assert.equal(planned[0].density, '')
  assert.deepEqual(planned[0].microFit, {bodyPx: 15.5})
  assert.equal(planned[1].density, '')
  assert.equal(planned[1].microFit, undefined)
  assert.equal(planned[4].density, 'dense saga-page--dense')
  assert.equal(planned[4].microFit, undefined)
})

test('App.css UI Fix 01 enforces unified left-axis layout, micro-fit variables, and editorial-meter.mjs empty-figure compatibility', () => {
  const css = fs.readFileSync(new URL('../../src/App.css', import.meta.url), 'utf8')
  const fixBlock = css.slice(css.indexOf('UI Fix 01'))
  assert.ok(fixBlock.length > 500, 'UI Fix 01 CSS block must exist at bottom of App.css')
  assert.match(fixBlock, /-webkit-line-clamp:\s*2;/)
  assert.match(fixBlock, /-webkit-line-clamp:\s*1;/)
  assert.match(fixBlock, /align-self:\s*flex-start;/)
  assert.match(fixBlock, /object-fit:\s*contain;/)
  assert.match(fixBlock, /var\(--saga-fit-body-size/)
  assert.match(fixBlock, /var\(--saga-fit-line-height/)
  assert.match(fixBlock, /var\(--saga-fit-photo-max-h/)
  assert.match(fixBlock, /\.layout-measure-fixture \.article-media \.photo-figure\.lore-photo-figure\.hero-media:empty/)
})
