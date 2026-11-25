// SAGA Layer 2 preloader: lookahead planner, data-saver throttling, and
// polite sequential image preload + decode backing the swipe deck.
import { photoResult, resolvePhoto } from './photoLoad.js'

export const DEFAULT_LOOKAHEAD = 2
export const SAVE_DATA_LOOKAHEAD = 1
export const DEFAULT_PRELOAD_PAUSE_MS = 250
export const BACKGROUND_PRELOAD_TIMEOUT_MS = 8000
export const SLOW_EFFECTIVE_TYPES = new Set(['2g', 'slow-2g'])

const preloadedAssets = new Map()

function defaultConnection() {
  if (typeof navigator === 'undefined') return null
  return navigator.connection || navigator.mozConnection || navigator.webkitConnection || null
}

/**
 * Returns true when the user has enabled Data Saver or is on a very slow
 * cellular connection (2g / slow-2g).
 */
export function isDataSaverEnabled(connection = defaultConnection()) {
  if (!connection) return false
  if (connection.saveData === true) return true
  const eff = String(connection.effectiveType || '').trim().toLowerCase()
  return SLOW_EFFECTIVE_TYPES.has(eff)
}

/**
 * Story lookahead depth: 2 stories ahead normally (polite to Wikimedia),
 * automatically throttled to 1 story ahead when saveData is on or
 * effectiveType is 2g / slow-2g.
 */
export function getPreloadLookahead(connection = defaultConnection()) {
  return isDataSaverEnabled(connection) ? SAVE_DATA_LOOKAHEAD : DEFAULT_LOOKAHEAD
}

/**
 * Build a deduplicated, prioritized preload plan for the active reading index:
 * - currentRemaining: remaining photo pages (pages[1..]) of the current story
 * - upcomingLeads: Page 1 lead images of stories [index + 1 .. index + lookahead]
 * - previousLead: Page 1 lead image of story [index - 1] for instant back-swipe
 */
export function collectPreloadPlan(
  stories,
  currentIndex,
  { brokenImages = new Set(), connection = defaultConnection() } = {}
) {
  const list = Array.isArray(stories) ? stories : []
  const idx = Number.isInteger(currentIndex) ? currentIndex : 0
  const lookahead = getPreloadLookahead(connection)
  const seen = new Set()

  const usable = url => {
    const clean = String(url || '').trim()
    if (!clean) return ''
    if (brokenImages?.has?.(clean)) return ''
    if (seen.has(clean)) return ''
    seen.add(clean)
    return clean
  }

  const currentStory = list[idx] || null
  const currentLead = String(currentStory?.pages?.[0]?.image || '').trim()
  if (currentLead) seen.add(currentLead)

  const currentRemaining = []
  if (Array.isArray(currentStory?.pages)) {
    for (let p = 1; p < currentStory.pages.length; p += 1) {
      const url = usable(currentStory.pages[p]?.image)
      if (url) currentRemaining.push(url)
    }
  }

  const upcomingLeads = []
  for (let offset = 1; offset <= lookahead; offset += 1) {
    const nextStory = list[idx + offset]
    if (!nextStory) break
    const url = usable(nextStory?.pages?.[0]?.image)
    if (url) upcomingLeads.push(url)
  }

  const prevStory = idx > 0 ? list[idx - 1] : null
  const previousLead = usable(prevStory?.pages?.[0]?.image) || null

  return {
    lookahead,
    currentRemaining,
    upcomingLeads,
    previousLead,
  }
}

/**
 * Order a preload plan into a prioritized sequential queue:
 * 1. upcomingLeads[0] (next story +1 lead)
 * 2. currentRemaining (remaining photos of current story)
 * 3. upcomingLeads[1..] (story +2 lead)
 * 4. previousLead (story -1 lead)
 */
export function buildPreloadQueue(plan) {
  if (!plan) return []
  const upcoming = Array.isArray(plan.upcomingLeads) ? plan.upcomingLeads : []
  const remaining = Array.isArray(plan.currentRemaining) ? plan.currentRemaining : []
  const raw = [
    ...(upcoming[0] ? [upcoming[0]] : []),
    ...remaining,
    ...upcoming.slice(1),
    ...(plan.previousLead ? [plan.previousLead] : []),
  ]
  const seen = new Set()
  const ordered = []
  for (const url of raw) {
    const clean = String(url || '').trim()
    if (!clean || seen.has(clean)) continue
    seen.add(clean)
    ordered.push(clean)
  }
  return ordered
}

/**
 * Deduplicated background image preload + decode.
 * Uses maxCandidates=1, timeoutMs=8000, cacheFailure=false so a Wikimedia 429
 * or slow load never multiplies fallback requests or poisons photoLoad cache.
 * Failed background attempts are evicted from preloadedAssets so foreground
 * <ArticlePhoto> retries cleanly at fetchPriority="high".
 */
export function preloadImageAsset(
  image,
  {
    fetchPriority = 'low',
    resolvePhotoImpl = resolvePhoto,
    makeImage,
    timeoutMs = BACKGROUND_PRELOAD_TIMEOUT_MS,
    maxCandidates = 1,
    cacheFailure = false,
  } = {}
) {
  const clean = String(image || '').trim()
  if (!clean) return Promise.resolve(null)
  if (preloadedAssets.has(clean)) {
    return preloadedAssets.get(clean)
  }
  const opts = {
    fetchPriority,
    decode: true,
    timeoutMs,
    maxCandidates,
    cacheFailure,
    ...(makeImage ? { makeImage } : {}),
  }
  const work = Promise.resolve(resolvePhotoImpl(clean, opts))
    .catch(() => ({ failed: true }))
    .then(result => {
      if (!result?.url) {
        if (preloadedAssets.get(clean) === work) {
          preloadedAssets.delete(clean)
        }
      }
      return result
    })
  preloadedAssets.set(clean, work)
  return work
}

/**
 * Cancellable sequential preload queue (concurrency = 1) with a polite pause
 * between network requests so Wikimedia Commons is never hit with a parallel burst.
 */
export function startSequentialPreload(
  urls,
  {
    pauseMs = DEFAULT_PRELOAD_PAUSE_MS,
    preloadFn = preloadImageAsset,
    onItemDone,
    sleep,
  } = {}
) {
  const list = Array.isArray(urls) ? urls.filter(Boolean) : []
  let cancelled = false
  let pendingTimer = null
  let pendingResolve = null

  const waitPause = ms => {
    if (cancelled || ms <= 0) return Promise.resolve()
    if (typeof sleep === 'function') return sleep(ms)
    return new Promise(resolve => {
      pendingResolve = resolve
      pendingTimer = setTimeout(() => {
        pendingTimer = null
        pendingResolve = null
        resolve()
      }, ms)
    })
  }

  const cancel = () => {
    cancelled = true
    if (pendingTimer !== null) {
      clearTimeout(pendingTimer)
      pendingTimer = null
    }
    if (pendingResolve) {
      const resolve = pendingResolve
      pendingResolve = null
      resolve()
    }
  }

  const done = (async () => {
    for (let i = 0; i < list.length; i += 1) {
      if (cancelled) break
      const url = list[i]
      const alreadyReady = Boolean(photoResult(url)?.url)
      if (alreadyReady) {
        onItemDone?.(url, photoResult(url), { alreadyReady: true })
        continue
      }
      const result = await preloadFn(url, { fetchPriority: 'low' })
      if (cancelled) break
      onItemDone?.(url, result, { alreadyReady: false })
      if (i < list.length - 1 && !cancelled && pauseMs > 0) {
        await waitPause(pauseMs)
      }
    }
  })()

  return { cancel, done }
}

export function hasPreloadedImage(image) {
  const clean = String(image || '').trim()
  return Boolean(clean && preloadedAssets.has(clean))
}

export function getPreloadCacheSize() {
  return preloadedAssets.size
}

export function clearImagePreloadCache() {
  preloadedAssets.clear()
}
