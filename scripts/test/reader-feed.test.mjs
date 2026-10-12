import test from 'node:test'
import assert from 'node:assert/strict'
import {storyId, readableStory, validStories, shuffle, chunkOrder, fetchManifest, fetchWithTimeout, scanFeed} from '../../src/lib/feedQueue.js'

const word = 'A useful English sentence explains the historical context of this topic to curious readers.'
const article = (i, source = 'wiki') => ({
  title: `Article ${i}`, category: 'KNOWLEDGE', sourceUrl: `https://example.org/${source}/${i}`,
  pages: Array.from({length: 4}, () => ({text: Array.from({length: 5}, () => word).join(' '), image: `https://example.org/img/${i}.jpg`, caption: 'Licensed photo'})),
})
const response = (data, ok = true) => ({ok, status: ok ? 200 : 503, json: async () => data})
const mockFetch = (chunks, {failOnce = new Set(), manifestVersion = '2026-10-12'} = {}) => {
  const requested = []
  const fetchImpl = async url => {
    requested.push(url)
    if (url.includes('manifest.json')) return response({chunks: chunks.length, updatedAt: manifestVersion})
    const match = url.match(/\/([0-9]{4})\.json/)
    if (!match) throw Error(`Unexpected request: ${url}`)
    const n = Number(match[1])
    if (failOnce.has(n)) { failOnce.delete(n); throw Error('Simulated temporary outage') }
    return response(chunks[n])
  }
  return {fetchImpl, requested}
}

test('filters one-page snippets and accepts long readable articles', () => {
  assert.equal(readableStory(article(1)), true)
  assert.equal(readableStory({...article(2), pages: [{text: 'short', image: ''}]}), false)
  assert.equal(validStories([article(3)]), true)
  assert.equal(validStories([{title:'Bad', pages:[{text:'text'}]}]), false)
})

test('source URL provides stable identity and shuffling does not mutate the source', () => {
  assert.equal(storyId(article(1)), 'https://example.org/wiki/1')
  const arr = [1,2,3,4]
  const out = shuffle(arr, () => 0)
  assert.deepEqual(arr, [1,2,3,4]); assert.equal(new Set(out).size, 4)
})

test('newer chunks lead, every chunk is present once', () => {
  for (const count of [0,1,8,24,25,500]) {
    const order = chunkOrder(count, () => 0.4)
    assert.equal(order.length, count)
    assert.equal(new Set(order).size, count)
    if (count > 24) assert.ok(order.slice(0,24).every(n => n >= count - 24))
  }
})

test('manifest rejects invalid chunk counts and uses cache-busting URL', async () => {
  const {fetchImpl,requested} = mockFetch([[]])
  assert.equal((await fetchManifest(fetchImpl, '/', 123)).count, 1)
  assert.ok(requested[0].endsWith('manifest.json?t=123'))
  await assert.rejects(() => fetchManifest(async () => response({chunks:-3}), '/'), /Invalid/)
})

test('keeps scanning past read chunks until it finds unread stories', async () => {
  const chunks = Array.from({length:30}, (_,i) => [article(i)])
  const {fetchImpl} = mockFetch(chunks)
  const seen = new Set(Array.from({length:26}, (_,i) => storyId(article(i))))
  const result = await scanFeed({fetchImpl,baseUrl:'/',order:chunks.map((_,i)=>i),seen,target:4,maxChunks:30})
  assert.equal(result.items.length, 4)
  assert.deepEqual(result.items.map(x=>x.title), ['Article 26','Article 27','Article 28','Article 29'])
  assert.equal(result.done, true)
})

test('does not repeat already queued articles or duplicate IDs inside a chunk', async () => {
  const chunks = [[article(1),article(1),article(2)], [article(2),article(3)]]
  const {fetchImpl} = mockFetch(chunks)
  const result = await scanFeed({fetchImpl,baseUrl:'/',order:[0,1],loaded:new Set([storyId(article(1))])})
  assert.deepEqual(result.items.map(x=>x.title), ['Article 2','Article 3'])
})

test('temporary chunk failure preserves cursor and earlier results for retry', async () => {
  const chunks = [[article(0)], [article(1)], [article(2)], [article(3)]]
  const {fetchImpl} = mockFetch(chunks,{failOnce:new Set([1])})
  const first = await scanFeed({fetchImpl,baseUrl:'/',order:[0,1,2,3],concurrency:3})
  assert.equal(first.cursor, 1)
  assert.equal(first.items.length, 1)
  assert.ok(first.error)
  const second = await scanFeed({fetchImpl,baseUrl:'/',order:[0,1,2,3],cursor:first.cursor,loaded:first.ids,concurrency:3})
  assert.equal(second.items.length, 3)
  assert.equal(second.done, true)
  assert.equal(new Set([...first.ids,...second.ids]).size, 4)
})

test('preserves cursor if first chunk is unavailable', async () => {
  const {fetchImpl} = mockFetch([[article(0)]], {failOnce:new Set([0])})
  const first = await scanFeed({fetchImpl,baseUrl:'/',order:[0]})
  assert.equal(first.cursor, 0)
  assert.ok(first.error)
  const next = await scanFeed({fetchImpl,baseUrl:'/',order:[0],cursor:first.cursor})
  assert.equal(next.items.length, 1)
})

test('keeps the last article in the buffer while appending new articles', async () => {
  const chunks = Array.from({length:30},(_,i)=>Array.from({length:20},(_,j)=>article(i*20+j)))
  const {fetchImpl} = mockFetch(chunks)
  const loaded = new Set(), received = []
  let cursor = 0
  for (let n=0;n<25;n++) {
    const r = await scanFeed({fetchImpl,baseUrl:'/',order:chunks.map((_,i)=>i),cursor,loaded,target:25,maxChunks:4})
    r.ids.forEach(id=>loaded.add(id))
    received.push(...r.items)
    cursor = r.cursor
    if (r.done) break
  }
  assert.equal(received.length, 600)
  assert.equal(loaded.size, 600)
  assert.equal(cursor, 30)
})

test('simulates 400 different articles read with a 30-story prefetch target', async () => {
  const chunks = Array.from({length:30},(_,i)=>Array.from({length:20},(_,j)=>article(i*20+j)))
  const {fetchImpl,requested} = mockFetch(chunks)
  const loaded = new Set(), seen = new Set(), queue = []
  let cursor = 0
  for (let read=0;read<400;read++) {
    if (queue.length < 16) {
      const result = await scanFeed({fetchImpl,baseUrl:'/',order:chunks.map((_,i)=>i),cursor,loaded,seen,target:30-queue.length,maxChunks:36})
      result.ids.forEach(id=>loaded.add(id))
      queue.push(...result.items)
      cursor = result.cursor
    }
    assert.ok(queue.length > 0, `Reader ran out of articles at swipe ${read}`)
    const next = queue.shift()
    assert.ok(!seen.has(storyId(next)))
    seen.add(storyId(next))
  }
  assert.equal(seen.size,400)
  assert.ok(requested.length <= 50, `Excessive requests: ${requested.length}`)
})

test('new manifest with appended chunk can supply new articles after archive exhaustion', async () => {
  const chunks = [[article(1)]]
  const first = mockFetch(chunks)
  const a = await scanFeed({fetchImpl:first.fetchImpl,baseUrl:'/',order:[0]})
  assert.equal(a.done,true)
  chunks.push([article(2)])
  const b = await scanFeed({fetchImpl:first.fetchImpl,baseUrl:'/',order:chunkOrder(2,()=>0),seen:new Set(a.ids)})
  assert.deepEqual(b.items.map(x=>x.title), ['Article 2'])
})

test('hung network requests abort and reject rather than stalling the reader', async () => {
  let wasAborted = false
  const stalledFetch = (_url, {signal}) => new Promise((resolve, reject) => {
    signal.addEventListener('abort', () => { wasAborted = true; reject(new Error('aborted')) }, {once:true})
  })
  await assert.rejects(() => fetchWithTimeout(stalledFetch, '/feed/0000.json', {}, 10), /aborted/)
  assert.equal(wasAborted, true)
})
