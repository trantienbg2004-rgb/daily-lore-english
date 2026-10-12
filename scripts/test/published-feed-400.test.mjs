// Validate V17 against actual published data in this repository, not invented mock stories.
import test from 'node:test'
import assert from 'node:assert/strict'
import {readFile} from 'node:fs/promises'
import {scanFeed,chunkOrder,storyId,readableStory,fetchManifest} from '../../src/lib/feedQueue.js'

const feedDir = new URL('../../public/feed/', import.meta.url)
const readJSON = async relative => JSON.parse(await readFile(new URL(relative, feedDir), 'utf8'))

test('published feed has at least 400 distinct readable articles', async () => {
  const manifest = await readJSON('manifest.json')
  let valid = new Set()
  for (let n = 0; n < manifest.chunks; n++) {
    const batch = await readJSON(`${String(n).padStart(4,'0')}.json`)
    batch.filter(readableStory).forEach(article => valid.add(storyId(article)))
  }
  assert.ok(valid.size >= 400, `Only ${valid.size} readable stories available (target: 400)`)
})

test('real published feed supplies 400 unique swipes without repeating', async () => {
  const manifest = await readJSON('manifest.json')
  let requests = 0
  const fetchImpl = async url => {
    requests++
    if (url.includes('manifest.json')) return {ok:true,json:async()=>manifest}
    const result = url.match(/feed\/(\d{4})\.json/)
    assert.ok(result, `Invalid feed URL: ${url}`)
    return {ok:true, json:async()=>readJSON(result[1] + '.json')}
  }
  const meta = await fetchManifest(fetchImpl, '/')
  const order = chunkOrder(meta.count, () => .42)
  let cursor = 0, buffer = [], seen = new Set(), loaded = new Set(), loops=0
  for (let turn=0; turn<400;turn++) {
    if (buffer.length < 16) {
      const result = await scanFeed({fetchImpl,baseUrl:'/',order,cursor,
        seen,loaded,target:30-buffer.length,maxChunks:36,concurrency:3,random:()=>.42})
      if (result.error) throw result.error
      result.ids.forEach(id=>loaded.add(id))
      buffer.push(...result.items)
      cursor = result.cursor
      loops++
    }
    assert.ok(buffer.length, `Feed exhausted before swipe ${turn+1}`)
    const story=buffer.shift(),id=storyId(story)
    assert.ok(!seen.has(id), `Repeated article: ${id}`)
    seen.add(id)
  }
  assert.equal(seen.size,400)
  assert.ok(requests <= 50, `Too many requests for 400 swipes: ${requests}`)
})
