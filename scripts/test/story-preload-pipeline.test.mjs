import test from 'node:test'
import assert from 'node:assert/strict'
import {
  BACKGROUND_PRELOAD_TIMEOUT_MS,
  DEFAULT_LOOKAHEAD,
  DEFAULT_PRELOAD_PAUSE_MS,
  SAVE_DATA_LOOKAHEAD,
  buildPreloadQueue,
  clearImagePreloadCache,
  collectPreloadPlan,
  getPreloadCacheSize,
  getPreloadLookahead,
  hasPreloadedImage,
  isDataSaverEnabled,
  preloadImageAsset,
  startSequentialPreload,
} from '../../src/lib/imagePreload.js'
import { FAILURE_TTL_MS, clearPhotoCache, evictPhoto, photoResult, resolvePhoto } from '../../src/lib/photoLoad.js'
import { createPaginationCache, makePaginationCacheKey } from '../../src/lib/paginationCache.js'
import { hasUnfetchedShards } from '../../src/lib/continuousReader.js'
import {
  clearFullArticleCache,
  fetchFullArticle,
  prefetchFullArticle,
} from '../../src/services/fullArticleService.js'

const mkStory = (id, images) => ({
  id,
  pages: images.map((image, i) => ({ text: `Page ${i + 1}`, image })),
})

test('getPreloadLookahead returns 2 normally and throttles to 1 on saveData, 2g, and slow-2g', () => {
  assert.equal(DEFAULT_LOOKAHEAD, 2)
  assert.equal(DEFAULT_PRELOAD_PAUSE_MS, 250)
  assert.equal(BACKGROUND_PRELOAD_TIMEOUT_MS, 8000)
  assert.equal(getPreloadLookahead(null), DEFAULT_LOOKAHEAD)
  assert.equal(getPreloadLookahead({ saveData: false, effectiveType: '4g' }), 2)
  assert.equal(getPreloadLookahead({ saveData: false, effectiveType: '3g' }), 2)
  assert.equal(isDataSaverEnabled({ saveData: false, effectiveType: '4g' }), false)

  assert.equal(getPreloadLookahead({ saveData: true, effectiveType: '4g' }), SAVE_DATA_LOOKAHEAD)
  assert.equal(getPreloadLookahead({ saveData: false, effectiveType: '2g' }), 1)
  assert.equal(getPreloadLookahead({ saveData: false, effectiveType: 'slow-2g' }), 1)
  assert.equal(isDataSaverEnabled({ saveData: true }), true)
  assert.equal(isDataSaverEnabled({ effectiveType: 'slow-2g' }), true)
})

test('collectPreloadPlan & buildPreloadQueue gather +1..+2 leads, current remaining, -1 lead in priority order', () => {
  const stories = [
    mkStory('s0', ['https://img.test/s0-lead.jpg']),
    mkStory('s1', ['https://img.test/s1-lead.jpg', 'https://img.test/s1-p2.jpg', 'https://img.test/s1-p3.jpg']),
    mkStory('s2', ['https://img.test/s2-lead.jpg']),
    mkStory('s3', ['https://img.test/s3-lead.jpg']),
    mkStory('s4', ['https://img.test/s4-lead.jpg']),
  ]

  const normalPlan = collectPreloadPlan(stories, 1, {
    brokenImages: new Set(),
    connection: { saveData: false, effectiveType: '4g' },
  })
  assert.equal(normalPlan.lookahead, 2)
  assert.deepEqual(normalPlan.currentRemaining, ['https://img.test/s1-p2.jpg', 'https://img.test/s1-p3.jpg'])
  assert.deepEqual(normalPlan.upcomingLeads, ['https://img.test/s2-lead.jpg', 'https://img.test/s3-lead.jpg'])
  assert.equal(normalPlan.previousLead, 'https://img.test/s0-lead.jpg')

  // Queue priority: upcomingLeads[0] -> currentRemaining -> upcomingLeads[1] -> previousLead
  assert.deepEqual(buildPreloadQueue(normalPlan), [
    'https://img.test/s2-lead.jpg',
    'https://img.test/s1-p2.jpg',
    'https://img.test/s1-p3.jpg',
    'https://img.test/s3-lead.jpg',
    'https://img.test/s0-lead.jpg',
  ])

  const filteredPlan = collectPreloadPlan(stories, 1, {
    brokenImages: new Set(['https://img.test/s3-lead.jpg']),
    connection: { saveData: false, effectiveType: '4g' },
  })
  assert.deepEqual(filteredPlan.upcomingLeads, ['https://img.test/s2-lead.jpg'])

  const saveDataPlan = collectPreloadPlan(stories, 1, {
    brokenImages: new Set(),
    connection: { saveData: true, effectiveType: '4g' },
  })
  assert.equal(saveDataPlan.lookahead, 1)
  assert.deepEqual(saveDataPlan.upcomingLeads, ['https://img.test/s2-lead.jpg'])
  assert.equal(saveDataPlan.previousLead, 'https://img.test/s0-lead.jpg')
})

test('preloadImageAsset deduplicates URLs, passes fetchPriority=low, maxCandidates=1, timeoutMs=8000, cacheFailure=false, and awaits img.decode()', async () => {
  clearImagePreloadCache()
  clearPhotoCache()

  let createdCount = 0
  let decodedCount = 0
  let lastPriority = ''

  const makeImage = () => {
    createdCount += 1
    const img = {
      naturalWidth: 1200,
      naturalHeight: 800,
      complete: false,
      fetchPriority: '',
      onload: null,
      onerror: null,
      decode() {
        decodedCount += 1
        return Promise.resolve()
      },
      set src(val) {
        lastPriority = this.fetchPriority
        this._src = val
        queueMicrotask(() => this.onload?.())
      },
      get src() {
        return this._src
      },
    }
    return img
  }

  const url = 'https://upload.wikimedia.org/wikipedia/commons/example-preload.jpg'
  const [r1, r2, r3] = await Promise.all([
    preloadImageAsset(url, { fetchPriority: 'low', makeImage }),
    preloadImageAsset(url, { fetchPriority: 'low', makeImage }),
    preloadImageAsset(url, { fetchPriority: 'high', makeImage }),
  ])

  assert.equal(createdCount, 1, 'same image URL must be fetched strictly once')
  assert.equal(decodedCount, 1, 'img.decode() must run once')
  assert.equal(lastPriority, 'low')
  assert.equal(r1.url, url)
  assert.equal(r2.url, url)
  assert.equal(r3.url, url)
  assert.equal(r1.decoded, true)
  assert.equal(hasPreloadedImage(url), true)
  assert.equal(getPreloadCacheSize(), 1)
  assert.equal(photoResult(url)?.width, 1200)

  // Verify resolvePhoto still resolves cleanly even if img.decode() rejects
  const fallbackUrl = 'https://upload.wikimedia.org/wikipedia/commons/example-decode-reject.jpg'
  const rejectedDecodeRes = await resolvePhoto(fallbackUrl, {
    fetchPriority: 'high',
    decode: true,
    makeImage: () => ({
      naturalWidth: 800,
      naturalHeight: 600,
      complete: false,
      decode: () => Promise.reject(new Error('decode unsupported')),
      set src(v) {
        this._src = v
        queueMicrotask(() => this.onload?.())
      },
    }),
  })
  assert.equal(rejectedDecodeRes?.width, 800)

  clearImagePreloadCache()
  clearPhotoCache()
})

test('background preload failure does NOT poison photoResult or block subsequent foreground resolvePhoto, and tries maxCandidates=1', async () => {
  clearImagePreloadCache()
  clearPhotoCache()

  // Wikimedia URL that produces multiple fallback candidates in photoCandidates()
  const wikiUrl = 'https://upload.wikimedia.org/wikipedia/commons/thumb/a/ab/Nuclear_Plant.jpg/960px-Nuclear_Plant.jpg'
  let bgAttempts = 0
  const failingBgMakeImage = () => {
    bgAttempts += 1
    return {
      naturalWidth: 0,
      naturalHeight: 0,
      complete: false,
      onload: null,
      onerror: null,
      set src(val) {
        this._src = val
        queueMicrotask(() => this.onerror?.())
      },
    }
  }

  const bgResult = await preloadImageAsset(wikiUrl, {
    fetchPriority: 'low',
    makeImage: failingBgMakeImage,
  })
  assert.equal(bgResult?.failed, true)
  assert.equal(bgAttempts, 1, 'background preload must try at most 1 candidate (maxCandidates=1)')
  assert.equal(photoResult(wikiUrl), null, 'background preload failure must NOT poison photoResult cache')
  assert.equal(hasPreloadedImage(wikiUrl), false, 'failed background preload must be evicted from preloadedAssets')

  // Foreground resolvePhoto subsequently succeeds at fetchPriority="high"
  let fgPriority = ''
  const fgResult = await resolvePhoto(wikiUrl, {
    fetchPriority: 'high',
    decode: true,
    cacheFailure: true,
    makeImage: () => ({
      naturalWidth: 960,
      naturalHeight: 640,
      complete: false,
      fetchPriority: '',
      onload: null,
      onerror: null,
      decode: () => Promise.resolve(),
      set src(val) {
        fgPriority = this.fetchPriority
        this._src = val
        queueMicrotask(() => this.onload?.())
      },
    }),
  })
  assert.equal(fgPriority, 'high')
  assert.equal(fgResult?.url, wikiUrl)
  assert.equal(fgResult?.width, 960)
  assert.equal(photoResult(wikiUrl)?.width, 960)

  // Foreground failure has a short TTL (15s) instead of poisoning the whole session
  const transientUrl = 'https://upload.wikimedia.org/wikipedia/commons/transient-429.jpg'
  let fakeNow = 100000
  const fgFail = await resolvePhoto(transientUrl, {
    cacheFailure: true,
    now: () => fakeNow,
    makeImage: () => ({
      naturalWidth: 0,
      naturalHeight: 0,
      complete: false,
      set src(v) {
        this._src = v
        queueMicrotask(() => this.onerror?.())
      },
    }),
  })
  assert.equal(fgFail?.failed, true)
  assert.equal(photoResult(transientUrl, fakeNow + 1000)?.failed, true, 'cached within 15s TTL')
  assert.equal(photoResult(transientUrl, fakeNow + FAILURE_TTL_MS + 1), null, 'expires after 15s TTL so retry succeeds')

  // evictPhoto + skipUrls advances to the next candidate cleanly after an <img> error
  evictPhoto(wikiUrl)
  assert.equal(photoResult(wikiUrl), null, 'evictPhoto removes cached entry immediately')
  const triedUrls = []
  const retryRes = await resolvePhoto(wikiUrl, {
    fetchPriority: 'high',
    skipUrls: [wikiUrl],
    makeImage: () => ({
      naturalWidth: 960,
      naturalHeight: 640,
      complete: false,
      decode: () => Promise.resolve(),
      set src(v) {
        triedUrls.push(v)
        this._src = v
        queueMicrotask(() => this.onload?.())
      },
    }),
  })
  assert.equal(triedUrls.length, 1)
  assert.notEqual(triedUrls[0], wikiUrl, 'skipUrls must skip the failed candidate and try the next Wikimedia candidate')
  assert.equal(retryRes?.url, triedUrls[0])

  clearImagePreloadCache()
  clearPhotoCache()
})

test('startSequentialPreload enforces concurrency=1 with pause and cancels queued items immediately on story switch', async () => {
  clearImagePreloadCache()
  clearPhotoCache()

  const urls = [
    'https://upload.wikimedia.org/wikipedia/commons/seq-1.jpg',
    'https://upload.wikimedia.org/wikipedia/commons/seq-2.jpg',
    'https://upload.wikimedia.org/wikipedia/commons/seq-3.jpg',
  ]
  let inFlight = 0
  let maxConcurrent = 0
  const started = []
  const pauses = []

  const controller1 = startSequentialPreload(urls, {
    pauseMs: 250,
    sleep: ms => {
      pauses.push(ms)
      return Promise.resolve()
    },
    preloadFn: async url => {
      started.push(url)
      inFlight += 1
      maxConcurrent = Math.max(maxConcurrent, inFlight)
      await new Promise(resolve => setTimeout(resolve, 10))
      inFlight -= 1
      return { url, width: 800, height: 600, decoded: true }
    },
  })

  await controller1.done
  assert.equal(maxConcurrent, 1, 'sequential preload must never exceed concurrency=1')
  assert.deepEqual(started, urls, 'must process URLs in exact priority order')
  assert.deepEqual(pauses, [250, 250], 'must pause 250ms between each request')

  // Cancellation on story switch stops remaining queued URLs immediately
  const startedBeforeCancel = []
  let releaseFirst
  const controller2 = startSequentialPreload(urls, {
    pauseMs: 250,
    preloadFn: url => {
      startedBeforeCancel.push(url)
      return new Promise(resolve => {
        releaseFirst = () => resolve({ url, width: 800, height: 600, decoded: true })
      })
    },
  })

  // First item is in-flight; user swipes to next story -> cancel
  await new Promise(resolve => setTimeout(resolve, 5))
  controller2.cancel()
  releaseFirst()
  await controller2.done
  assert.deepEqual(startedBeforeCancel, [urls[0]], 'cancelled queue must not start remaining URLs')

  clearImagePreloadCache()
  clearPhotoCache()
})

test('paginationCache keys round viewport dimensions, separate levels/stories, and evict LRU entries', () => {
  const k1 = makePaginationCacheKey({ storyId: 'nuclear-power', readingLevel: 'B1-B2', colWidth: 389.6, colHeight: 740.4 })
  const k2 = makePaginationCacheKey({ storyId: 'nuclear-power', readingLevel: 'B1-B2', colWidth: 390.2, colHeight: 739.7 })
  const kLevel = makePaginationCacheKey({ storyId: 'nuclear-power', readingLevel: 'C1-C2', colWidth: 390, colHeight: 740 })
  const kResize = makePaginationCacheKey({ storyId: 'nuclear-power', readingLevel: 'B1-B2', colWidth: 430, colHeight: 740 })

  assert.equal(k1, k2, 'subpixel rounding must resolve to identical cache key')
  assert.notEqual(k1, kLevel, 'different reading levels must produce distinct cache keys')
  assert.notEqual(k1, kResize, 'resized viewport must produce distinct cache keys')

  const cache = createPaginationCache(8)
  for (let i = 0; i < 8; i += 1) {
    cache.set(`s${i}|B1-B2|390x740`, [{ text: `story ${i}` }])
  }
  // Touch s0 so s1 becomes LRU
  assert.deepEqual(cache.get('s0|B1-B2|390x740'), [{ text: 'story 0' }])
  cache.set('s8|B1-B2|390x740', [{ text: 'story 8' }])
  assert.equal(cache.size, 8)
  assert.equal(cache.has('s0|B1-B2|390x740'), true, 'recently read entry retained')
  assert.equal(cache.has('s1|B1-B2|390x740'), false, 'oldest untouched entry evicted')
})

test('hasUnfetchedShards detects uncached shards in index or legacy order', () => {
  const uncachedPool = {
    done: true,
    index: [{ id: 'a', shard: '0001' }, { id: 'b', shard: '0002' }],
    cache: new Map([['0001', []]]),
  }
  assert.equal(hasUnfetchedShards([uncachedPool]), true)

  const cachedPool = {
    done: true,
    index: [{ id: 'a', shard: '0001' }],
    cache: new Map([['0001', []]]),
  }
  assert.equal(hasUnfetchedShards([cachedPool]), false)
})

test('prefetchFullArticle shares in-flight Wikipedia fetch with fetchFullArticle and swallows errors silently', async () => {
  clearFullArticleCache()
  const originalFetch = globalThis.fetch
  let fetchCalls = 0
  let resolveFetch

  globalThis.fetch = () => {
    fetchCalls += 1
    return new Promise(resolve => {
      resolveFetch = resolve
    })
  }

  try {
    const p1 = prefetchFullArticle({ sourceTitle: 'Nuclear power' })
    const p2 = fetchFullArticle({ sourceTitle: 'Nuclear power' })

    resolveFetch({
      ok: true,
      json: async () => ({
        query: {
          pages: [{
            pageid: 21523,
            title: 'Nuclear power',
            description: 'Use of nuclear reactions to produce electricity',
            extract: 'Nuclear power is the use of nuclear reactions to produce electricity.',
          }],
        },
      }),
    })

    const [r1, r2] = await Promise.all([p1, p2])
    assert.equal(fetchCalls, 1, 'prefetch and open must share a single in-flight fetch')
    assert.equal(r1.title, 'Nuclear power')
    assert.equal(r2.title, 'Nuclear power')

    // Silent error handling on prefetch
    clearFullArticleCache()
    globalThis.fetch = async () => ({ ok: false, status: 503 })
    const failed = await prefetchFullArticle({ sourceTitle: 'Broken article' })
    assert.equal(failed, null)
  } finally {
    globalThis.fetch = originalFetch
    clearFullArticleCache()
  }
})
