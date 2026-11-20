// 60fps iOS/Vaul-grade gesture & sheet physics helpers (pure math, GPU-composited)
export const IOS_SHEET_EASING = 'cubic-bezier(0.32, 0.72, 0, 1)'
export const SHEET_OPEN_MS = 340
export const SHEET_CLOSE_MS = 220
export const SWIPE_SETTLE_MS = 320
export const RUBBER_BAND_FACTOR = 0.25
export const SWIPE_DISTANCE_RATIO = 0.22
export const SWIPE_VELOCITY_THRESHOLD = 0.3 // px/ms
export const SHEET_DISMISS_RATIO = 0.3
export const SHEET_DISMISS_VELOCITY = 0.25 // px/ms

export function applyRubberBand(delta, atBoundary) {
  if (!Number.isFinite(delta)) return 0
  return atBoundary ? delta * RUBBER_BAND_FACTOR : delta
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
