// 60fps iOS/Vaul-grade gesture, spring & editorial motion physics helpers (pure math, GPU-composited)
export const SILK_EASING = 'cubic-bezier(0.32, 0.72, 0, 1)'
export const SPRING_EASING = 'cubic-bezier(0.22, 1.18, 0.36, 1)'
export const SNAPPY_EASING = 'cubic-bezier(0.2, 0, 0, 1)'
export const TACTILE_EASING = 'cubic-bezier(0.25, 0.9, 0.3, 1)'

export const IOS_SHEET_EASING = SILK_EASING
export const SILK_MS = 380
export const SPRING_MS = 460
export const SNAPPY_MS = 170
export const TACTILE_MS = 240

export const SHEET_OPEN_MS = SPRING_MS
export const SHEET_CLOSE_MS = 220
export const SWIPE_SETTLE_MS = SILK_MS
export const LIGHTBOX_CLOSE_MS = 220
export const WORDS_REMOVE_MS = 210
export const REVIEW_GLIDE_MS = 220

export const RUBBER_BAND_FACTOR = 0.25
export const SHEET_UPWARD_MAX_OVERSHOOT = 22
export const SWIPE_DISTANCE_RATIO = 0.22
export const SWIPE_VELOCITY_THRESHOLD = 0.3 // px/ms
export const SHEET_DISMISS_RATIO = 0.3
export const SHEET_DISMISS_VELOCITY = 0.25 // px/ms

export function applyRubberBand(delta, atBoundary) {
  if (!Number.isFinite(delta)) return 0
  return atBoundary ? delta * RUBBER_BAND_FACTOR : delta
}

// Smooth asymptotic upward resistance when dragging a bottom sheet past its resting top edge.
export function applySheetUpwardRubberBand(rawDy, maxOvershoot = SHEET_UPWARD_MAX_OVERSHOOT) {
  if (!Number.isFinite(rawDy) || rawDy >= 0) return Math.max(0, Number(rawDy) || 0)
  const cap = Math.max(1, Number(maxOvershoot) || SHEET_UPWARD_MAX_OVERSHOOT)
  return -cap * (1 - Math.exp(rawDy / (cap * 4)))
}

// Compute GPU-composited translateX + scaleX for a 1px base sliding underline bar.
export function measureUnderlineTransform(buttonRect, trackRect, ratio = 0.58) {
  if (!buttonRect || !trackRect || !Number.isFinite(buttonRect.width) || buttonRect.width <= 0) {
    return null
  }
  const barWidth = Math.round(Math.min(18, Math.max(12, buttonRect.width * ratio)))
  const x = (buttonRect.left - trackRect.left) + (buttonRect.width - barWidth) / 2
  return {
    x: Number(x.toFixed(2)),
    scaleX: barWidth,
  }
}

export function lockGestureAxis(dx, dy, threshold = 10) {
  const absX = Math.abs(dx)
  const absY = Math.abs(dy)
  if (Math.max(absX, absY) < threshold) return null
  if (absX > absY * 1.15) return 'x'
  if (absY > absX * 1.15) return 'y'
  return null
}

export function shouldCompleteSwipe(delta, viewportSize, velocityPxPerMs, minPx = 24) {
  const dist = Math.abs(delta)
  if (dist < minPx) return false
  const dim = Math.max(1, Number(viewportSize) || 1)
  return dist > dim * SWIPE_DISTANCE_RATIO || Math.abs(velocityPxPerMs) > SWIPE_VELOCITY_THRESHOLD
}

export function shouldDismissSheet(dy, sheetHeight, velocityPxPerMs) {
  if (dy <= 0) return false
  const height = Math.max(1, Number(sheetHeight) || 1)
  return dy > height * SHEET_DISMISS_RATIO || velocityPxPerMs > SHEET_DISMISS_VELOCITY
}

export function sheetBackdropOpacity(dy, sheetHeight) {
  if (dy <= 0) return 1
  const height = Math.max(1, Number(sheetHeight) || 1)
  return Math.max(0.15, Math.min(1, 1 - dy / (height * 1.15)))
}

export function prefersReducedMotion() {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches
}
