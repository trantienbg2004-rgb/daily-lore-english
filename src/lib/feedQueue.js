// DAILY NEWS V17: feed scanning is separate from React so it can be tested
// against thousands of articles without rendering or calling external APIs.
export const storyId = item => item.sourceUrl || item.sourceTitle || `${item.category}:${item.title}`

export const readableStory = item => Array.isArray(item?.pages) && item.pages.length >= 3 &&
  item.pages.reduce((sum, page) => sum + (typeof page.text === 'string'
    ? page.text.trim().split(/\s+/).filter(Boolean).length : 0), 0) >= 200

export const validStories = data => Array.isArray(data) && data.every(item =>
  item && typeof item.title === 'string' && Array.isArray(item.pages) && item.pages.length > 0 &&
  item.pages.every(p => typeof p.text === 'string' && typeof p.image === 'string'))

export function shuffle(values, random = Math.random) {
  const copy = [...values]
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1))
    ;[copy[i], copy[j]] = [copy[j], copy[i]]
  }
  return copy
}

// Newest 24 chunks are inspected first, but older unread content is not lost.
export function chunkOrder(count, random = Math.random) {
  if (!Number.isSafeInteger(count) || count < 0) throw new Error('Invalid chunk count')
  const recent = Math.min(24, count)
  // V21: check freshly published newsroom chunks first, then diversify.
  // Historic content remains reachable; the permanent seen set still wins.
  const newest = Math.min(4, recent)
  return [
    ...Array.from({length: newest}, (_, i) => count - 1 - i),
    ...shuffle(Array.from({length: recent - newest}, (_, i) => count - recent + i), random),
    ...shuffle(Array.from({length: count - recent}, (_, i) => i), random),
  ]
}

export async function fetchWithTimeout(fetchImpl, url, options = {}, timeoutMs = 12000) {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), timeoutMs)
  try {
    return await fetchImpl(url, {...options, signal: controller.signal})
  } finally {
    clearTimeout(timeout)
  }
}

export async function fetchManifest(fetchImpl, baseUrl, nonce = Date.now()) {
  const response = await fetchWithTimeout(fetchImpl, `${baseUrl}feed/manifest.json?t=${nonce}`, {cache: 'no-store'})
  if (!response.ok) throw new Error(`Feed manifest HTTP ${response.status}`)
  const manifest = await response.json()
  const count = Number(manifest?.chunks)
  if (!Number.isSafeInteger(count) || count < 0 || count > 100000) throw new Error('Invalid feed manifest')
  return {count, version: `${manifest.updatedAt || ''}:${count}`, updatedAt: manifest.updatedAt || ''}
}

async function fetchChunk(fetchImpl, baseUrl, chunkNumber, updatedAt) {
  const url = `${baseUrl}feed/${String(chunkNumber).padStart(4, '0')}.json?v=${encodeURIComponent(updatedAt)}`
  const response = await fetchWithTimeout(fetchImpl, url, {cache: 'no-cache'})
  if (!response.ok) throw new Error(`Feed chunk ${chunkNumber} HTTP ${response.status}`)
  const items = await response.json()
  if (!validStories(items)) throw new Error(`Invalid feed chunk ${chunkNumber}`)
  return items
}

// Parallel fetches speed up the long archive scan; only contiguous successful
// chunks advance the cursor, so a network error cannot silently skip stories.
export async function scanFeed({fetchImpl, baseUrl, order, cursor = 0, updatedAt = '',
  seen = new Set(), loaded = new Set(), target = 30, maxChunks = 36,
  concurrency = 3, random = Math.random}) {
  if (!Array.isArray(order) || cursor < 0 || cursor > order.length) throw new Error('Invalid scan position')
  const items = []
  const ids = new Set()
  let next = cursor
  let error = null
  while (next < order.length && next - cursor < maxChunks && items.length < target) {
    const width = Math.min(concurrency, maxChunks - (next - cursor), order.length - next)
    const batch = order.slice(next, next + width)
    const results = await Promise.allSettled(batch.map(number => fetchChunk(fetchImpl, baseUrl, number, updatedAt)))
    let failed = false
    for (let i = 0; i < results.length; i++) {
      const result = results[i]
      if (result.status === 'rejected') {
        error = result.reason
        failed = true
        break
      }
      for (const item of shuffle(result.value, random)) {
        const id = storyId(item)
        if (readableStory(item) && !seen.has(id) && !loaded.has(id) && !ids.has(id)) {
          ids.add(id)
          items.push(item)
        }
      }
      next++
    }
    if (failed) break
  }
  return {items, ids, cursor: next, done: next >= order.length, error, scanned: next - cursor}
}
