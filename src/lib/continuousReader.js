/** D12: two independent, licensed reader pools. The illustrated pool is
 * preferred; the world text pool supplies NEW unread stories once the photo
 * pool runs out. Never silently loop an exhausted finite library.
 */
import {fetchManifest, newsChunkOrder, scanFeed} from './feedQueue.js'

export const PUBLISHED_POOLS = ['source-visual-reader', 'world-reader']
export const REFRESH_INTERVAL_MS = 5 * 60_000

export function eligibleManifest(manifest, path) {
  if (!manifest || manifest.feedType !== 'news' || manifest.ready !== true || manifest.count < 1 || manifest.count > 100000) return false
  if (!Number.isInteger(manifest.sourceCount) || manifest.sourceCount < (path === 'source-visual-reader' ? 1 : 3)) return false
  if (path === 'source-visual-reader' && (manifest.sourcePhotosOnly !== true || manifest.withVerifiedPhoto < 1)) return false
  return PUBLISHED_POOLS.includes(path)
}

export async function refreshCatalog({fetchImpl, baseUrl, pools = [], now = Date.now(), fetchManifestImpl = fetchManifest}) {
  const old = new Map(pools.map(p => [p.path, p]))
  const settled = await Promise.allSettled(PUBLISHED_POOLS.map(path => fetchManifestImpl(fetchImpl, baseUrl, now, path)))
  const next = [], failures = []
  for (let i = 0; i < PUBLISHED_POOLS.length; i++) {
    const path = PUBLISHED_POOLS[i], result = settled[i]
    if (result.status !== 'fulfilled' || !eligibleManifest(result.value, path)) {
      failures.push(`${path}: ${result.status === 'fulfilled' ? 'incomplete-manifest' : String(result.reason?.message || result.reason)}`)
      // Existing validated data can still be scanned if the manifest request
      // temporarily fails. Never accept a new, unvalidated manifest.
      if (old.has(path)) next.push(old.get(path))
      continue
    }
    const manifest = result.value, prior = old.get(path)
    if (prior?.version === manifest.version) next.push(prior)
    else next.push({path, manifest, version:manifest.version, order:newsChunkOrder(manifest.count), cursor:0, done:false})
  }
  // If both network requests fail, preserve known catalog rather than blanking UI.
  return {pools:next, failures, hasAvailable:next.length > 0, checkedAt:now}
}

export async function refillCatalog({fetchImpl, baseUrl, pools, seen = new Set(), loaded = new Set(),
  target = 30, urgent = false, scanFeedImpl = scanFeed, maxChunksPerPool = 9}) {
  const updated = pools.map(p => ({...p})), items = [], errors = []
  // Look at each source; don't let one corrupt or blocked pool starve the other.
  for (const pool of updated) {
    if (items.length >= target) break
    if (pool.done) continue
    let loops = 0
    do {
      const result = await scanFeedImpl({fetchImpl,baseUrl,order:pool.order,cursor:pool.cursor,
        updatedAt:pool.manifest.updatedAt,seen,loaded,target:target-items.length,
        maxChunks:maxChunksPerPool,concurrency:urgent?1:2,feedPath:pool.path})
      for (const id of result.ids) loaded.add(id)
      items.push(...result.items)
      pool.cursor = result.cursor
      pool.done = result.done
      if (result.error) {errors.push({path:pool.path,message:String(result.error.message||result.error)});break}
      if (!result.scanned) break
      // While at the edge, keep scanning through already seen chunks so one
      // upward swipe eventually receives the next unread story.
      loops++
    } while (urgent && !pool.done && items.length === 0 && loops < 20)
  }
  return {items,pools:updated,done:updated.length>0 && updated.every(p=>p.done),errors}
}
