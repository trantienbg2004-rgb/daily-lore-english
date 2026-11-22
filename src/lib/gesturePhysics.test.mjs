import test from 'node:test'
import assert from 'node:assert/strict'
import {
  SILK_EASING,
  SPRING_EASING,
  SNAPPY_EASING,
  TACTILE_EASING,
  SILK_MS,
  SPRING_MS,
  SNAPPY_MS,
  TACTILE_MS,
  SHEET_UPWARD_MAX_OVERSHOOT,
  applyRubberBand,
  applySheetUpwardRubberBand,
  measureUnderlineTransform,
  lockGestureAxis,
  shouldCompleteSwipe,
  shouldDismissSheet,
  sheetBackdropOpacity,
  prefersReducedMotion,
} from './gesturePhysics.js'

test('motion system tokens expose the 4 standardized SAGA curves and timings', () => {
  assert.equal(SILK_EASING, 'cubic-bezier(0.32, 0.72, 0, 1)')
  assert.equal(SPRING_EASING, 'cubic-bezier(0.22, 1.18, 0.36, 1)')
  assert.equal(SNAPPY_EASING, 'cubic-bezier(0.2, 0, 0, 1)')
  assert.equal(TACTILE_EASING, 'cubic-bezier(0.25, 0.9, 0.3, 1)')
  assert.equal(SILK_MS, 380)
  assert.equal(SPRING_MS, 460)
  assert.equal(SNAPPY_MS, 170)
  assert.equal(TACTILE_MS, 240)
})

test('applyRubberBand damps boundary drags to 0.25x and preserves free drags', () => {
  assert.equal(applyRubberBand(80, false), 80)
  assert.equal(applyRubberBand(-80, true), -20)
  assert.equal(applyRubberBand(Number.NaN, true), 0)
})

test('applySheetUpwardRubberBand passes downward drags untouched and caps upward overshoot asymptotically', () => {
  assert.equal(applySheetUpwardRubberBand(45), 45)
  assert.equal(applySheetUpwardRubberBand(0), 0)
  const gentleUp = applySheetUpwardRubberBand(-20)
  const hardUp = applySheetUpwardRubberBand(-400)
  assert.ok(gentleUp < 0 && gentleUp > -SHEET_UPWARD_MAX_OVERSHOOT)
  assert.ok(hardUp < gentleUp && hardUp > -SHEET_UPWARD_MAX_OVERSHOOT)
})

test('measureUnderlineTransform centers the 1px-scaled bar beneath each A/B/C button', () => {
  const track = { left: 100, width: 72 }
  const btnA = { left: 100, width: 24 }
  const btnB = { left: 124, width: 24 }
  const btnC = { left: 148, width: 24 }

  const resA = measureUnderlineTransform(btnA, track)
  const resB = measureUnderlineTransform(btnB, track)
  const resC = measureUnderlineTransform(btnC, track)

  assert.deepEqual(resA, { x: 5, scaleX: 14 })
  assert.deepEqual(resB, { x: 29, scaleX: 14 })
  assert.deepEqual(resC, { x: 53, scaleX: 14 })
  assert.equal(measureUnderlineTransform(null, track), null)
})

test('lockGestureAxis locks clear horizontal or vertical gestures and ignores diagonal noise', () => {
  assert.equal(lockGestureAxis(5, 2), null)
  assert.equal(lockGestureAxis(30, 8), 'x')
  assert.equal(lockGestureAxis(6, -32), 'y')
  assert.equal(lockGestureAxis(20, 20), null)
})

test('swipe completion and sheet dismissal respect distance and velocity thresholds', () => {
  assert.equal(shouldCompleteSwipe(10, 390, 0.8), false)
  assert.equal(shouldCompleteSwipe(-100, 390, 0.05), true)
  assert.equal(shouldCompleteSwipe(-30, 390, -0.45), true)
  assert.equal(shouldCompleteSwipe(-30, 390, -0.1), false)

  assert.equal(shouldDismissSheet(-20, 400, 0.9), false)
  assert.equal(shouldDismissSheet(140, 400, 0.05), true)
  assert.equal(shouldDismissSheet(40, 400, 0.4), true)
  assert.equal(shouldDismissSheet(40, 400, 0.1), false)
})

test('sheetBackdropOpacity clamps smoothly between 0.15 and 1', () => {
  assert.equal(sheetBackdropOpacity(-25, 400), 1)
  assert.equal(sheetBackdropOpacity(0, 400), 1)
  const mid = sheetBackdropOpacity(200, 400)
  assert.ok(mid > 0.4 && mid < 0.7)
  assert.equal(sheetBackdropOpacity(800, 400), 0.15)
})

test('prefersReducedMotion defaults safely to false in Node environment', () => {
  assert.equal(prefersReducedMotion(), false)
})
