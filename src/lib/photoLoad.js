// DAILY NEWS V20: load and validate images BEFORE they enter the reader's DOM.
// Avoids native broken-image icons, ghost borders and blank frames.
import {photoCandidates} from './photoPresentation.js'

export const FAILURE_TTL_MS = 15000

const verified = new Map()
const pending = new Map()

export function photoResult(image, now = Date.now()) {
  const entry = verified.get(image)
  if (!entry) return null
  if (entry.failed && Number.isFinite(entry.expiresAt) && now >= entry.expiresAt) {
    verified.delete(image)
    return null
  }
  return entry
}
export function evictPhoto(image) {
  if (!image) return
  verified.delete(image)
}
export function clearPhotoCache() { verified.clear(); pending.clear() }

// Inject a fake image loader in tests. In production the browser's Image
// constructor resolves actual pixel dimensions and fires onload/onerror.
export function resolvePhoto(
  image,
  {
    makeImage = () => new Image(),
    timeoutMs = 4000,
    fetchPriority = '',
    decode = true,
    cacheFailure = true,
    maxCandidates = Infinity,
    skipUrls = [],
    now = () => Date.now(),
  } = {}
) {
  if (!image) return Promise.resolve(null)
  const getNow = typeof now === 'function' ? now : () => now
  const cached = photoResult(image, getNow())
  if (cached) return Promise.resolve(cached)

  const inFlight = pending.get(image)
  if (inFlight) {
    // Background callers share any in-flight request; foreground callers share
    // an in-flight foreground request or reuse a successful background load,
    // retrying cleanly if a background-only attempt failed.
    if (!cacheFailure || !inFlight.backgroundOnly) {
      return inFlight.promise
    }
    return inFlight.promise.then(res => {
      if (res?.url) return res
      return resolvePhoto(image, {
        makeImage,
        timeoutMs,
        fetchPriority,
        decode,
        cacheFailure,
        maxCandidates,
        skipUrls,
        now: getNow,
      })
    })
  }

  const allCandidates = photoCandidates(image)
  if (!allCandidates.length) {
    const failed = { failed: true, expiresAt: getNow() + FAILURE_TTL_MS }
    if (cacheFailure) verified.set(image, failed)
    return Promise.resolve({ failed: true })
  }

  const skipSet = new Set(Array.isArray(skipUrls) ? skipUrls.filter(Boolean) : [])
  const filteredCandidates = skipSet.size
    ? allCandidates.filter(url => !skipSet.has(url))
    : allCandidates
  const candidatePool = filteredCandidates.length ? filteredCandidates : allCandidates

  const limit = Number.isFinite(maxCandidates) && maxCandidates > 0
    ? Math.floor(maxCandidates)
    : candidatePool.length
  const candidates = candidatePool.slice(0, limit)

  const work = (async () => {
    for (const url of candidates) {
      const result = await new Promise(resolve => {
        const instance = makeImage()
        let finished = false
        let timer
        const done = success => {
          if (finished) return
          finished = true
          clearTimeout(timer)
          instance.onload = null
          instance.onerror = null
          resolve(
            success
              ? { url, width: instance.naturalWidth, height: instance.naturalHeight, decoded: Boolean(decode) }
              : null
          )
        }
        const finalizeLoaded = () => {
          if (!(instance.naturalWidth > 0 && instance.naturalHeight > 0)) {
            done(false)
            return
          }
          if (decode && typeof instance.decode === 'function') {
            Promise.resolve(instance.decode())
              .catch(() => {})
              .finally(() => done(true))
          } else {
            done(true)
          }
        }
        if (fetchPriority) {
          try { instance.fetchPriority = fetchPriority } catch { /* ignore unsupported browsers */ }
        }
        instance.onload = finalizeLoaded
        instance.onerror = () => done(false)
        timer = setTimeout(() => done(false), timeoutMs)
        instance.src = url
        // Data URLs and cached image resources can finish synchronously.
        if (instance.complete && instance.naturalWidth) finalizeLoaded()
      })
      if (result) { verified.set(image, result); return result }
    }
    const failed = { failed: true, expiresAt: getNow() + FAILURE_TTL_MS }
    if (cacheFailure) verified.set(image, failed)
    return { failed: true }
  })().finally(() => {
    if (pending.get(image)?.promise === work) pending.delete(image)
  })
  pending.set(image, { promise: work, backgroundOnly: !cacheFailure })
  return work
}
