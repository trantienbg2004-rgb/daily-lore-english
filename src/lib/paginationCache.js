// SAGA Layer 3 pagination cache: remembers measured layoutPages() results per
// (storyId, readingLevel, rounded viewport size) to eliminate post-swipe reflow.

export function makePaginationCacheKey({
  storyId = '',
  readingLevel = '',
  colWidth = 0,
  colHeight = 0,
  brokenKey = '',
  mediaSig = '',
  contentSig = '',
  fontVersion = 0,
} = {}) {
  const id = String(storyId || '').trim()
  const level = String(readingLevel || '').trim()
  const w = Math.round(Number(colWidth) || 0)
  const h = Math.round(Number(colHeight) || 0)
  let key = `${id}|${level}|${w}x${h}`
  if (brokenKey) key += `|b:${brokenKey}`
  if (mediaSig) key += `|m:${mediaSig}`
  if (contentSig) key += `|c:${contentSig}`
  if (fontVersion) key += `|f:${fontVersion}`
  return key
}

export function createPaginationCache(maxEntries = 120) {
  const limit = Math.max(8, Number(maxEntries) || 120)
  const store = new Map()

  return {
    get(key) {
      if (!key || !store.has(key)) return null
      const value = store.get(key)
      // Refresh LRU recency
      store.delete(key)
      store.set(key, value)
      return value
    },
    set(key, pages) {
      if (!key || !Array.isArray(pages)) return
      if (store.has(key)) store.delete(key)
      store.set(key, pages)
      while (store.size > limit) {
        const oldest = store.keys().next().value
        store.delete(oldest)
      }
    },
    has(key) {
      return Boolean(key && store.has(key))
    },
    delete(key) {
      return store.delete(key)
    },
    clear() {
      store.clear()
    },
    get size() {
      return store.size
    },
  }
}
