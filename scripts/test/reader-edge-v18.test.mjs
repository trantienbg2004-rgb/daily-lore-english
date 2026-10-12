import test from 'node:test'
import assert from 'node:assert/strict'
import {createEdgeNavigation} from '../../src/lib/edgeNavigation.js'
import {scanFeed, storyId} from '../../src/lib/feedQueue.js'

const word = 'Every article explains its subject clearly using precise useful information in readable English.'
const article = i => ({
  title: `Story ${i}`, sourceUrl: `https://example.org/${i}`,
  pages: Array.from({length:4},()=>({text:Array(5).fill(word).join(' '), image:'', caption:''})),
})
const response = body => ({ok:true,json:async()=>body})
const tick = () => new Promise(resolve => setImmediate(resolve))
const make = ({load = () => {}} = {}) => {
  let index = 0
  let total = 1
  let waiting = false
  let navigations = 0
  let requests = 0
  const controller = createEdgeNavigation({
    advance: direction => {index += direction; navigations++},
    requestMore: () => {requests++; load()},
    onWaitingChange: value => {waiting = value},
  })
  return {
    controller,
    forward: () => controller.forward(index,total),
    back: () => controller.backward(index),
    append: n => {total += n; controller.onQueueChanged(index,total)},
    read: () => ({index,total,waiting,navigations,requests}),
  }
}

test('V18: a swipe at the last loaded story is remembered, then advances once when next story appears', () => {
  const reader = make()
  assert.equal(reader.forward(), 'waiting')
  assert.deepEqual(reader.read(), {index:0,total:1,waiting:true,navigations:0,requests:1})
  reader.append(4)
  assert.deepEqual(reader.read(), {index:1,total:5,waiting:false,navigations:1,requests:1})
  reader.append(3)
  assert.equal(reader.read().navigations,1, 'a resolved swipe must not repeat')
})

test('V18: waiting survives an empty prefetch and a delayed response', async () => {
  const reader = make()
  reader.forward()
  await tick()
  reader.append(0) // a batch with only previously-read articles
  assert.equal(reader.read().waiting,true)
  await tick()
  reader.append(2)
  assert.equal(reader.read().index,1)
})

test('V18: swiping back cancels pending advance; no unrequested jump on delayed arrival', () => {
  const reader = make()
  reader.forward()
  reader.back()
  reader.append(4)
  assert.equal(reader.read().index,0)
  assert.equal(reader.read().navigations,0)
  assert.equal(reader.read().waiting,false)
})

test('V18: exhausted archive stops waiting; a later refresh can find new content', () => {
  const reader = make()
  reader.forward()
  reader.controller.noMore()
  assert.equal(reader.read().waiting,false)
  reader.append(1)
  assert.equal(reader.read().index,0)
  assert.equal(reader.forward(),'advanced')
  assert.equal(reader.read().index,1)
})

test('V18: repeated edge swipes do not cause double navigation', () => {
  const reader = make()
  reader.forward(); reader.forward(); reader.forward()
  reader.append(1)
  assert.equal(reader.read().index,1)
  assert.equal(reader.read().navigations,1)
})

test('V18: new story is found after >36 chunks full of already-read material', async () => {
  const chunks = Array.from({length:93},(_,i)=>[article(i)])
  const fetchImpl = async url => {
    const number = Number(url.match(/(\d{4})\.json/)[1])
    await tick()
    return response(chunks[number])
  }
  const seen = new Set(chunks.slice(0,88).flat().map(storyId))
  const loaded = new Set()
  const reader = make()
  reader.forward()
  let cursor = 0
  let scanned = 0
  while (cursor < chunks.length) {
    const result = await scanFeed({fetchImpl,baseUrl:'/',order:chunks.map((_,i)=>i),cursor,seen,loaded,target:30,maxChunks:36})
    result.ids.forEach(id=>loaded.add(id))
    cursor=result.cursor
    scanned+=result.scanned
    reader.append(result.items.length)
    if (result.items.length) break
  }
  assert.ok(scanned>36)
  assert.equal(reader.read().index,1)
  assert.equal(reader.read().waiting,false)
})

test('V18: brand, dictionary and pagination are not changed by edge controller', async () => {
  const {readFile} = await import('node:fs/promises')
  const app = await readFile(new URL('../../src/App.jsx',import.meta.url),'utf8')
  assert.match(app, /<span className="brand">DAILY NEWS<\/span>/)
  assert.match(app, /word-token/)
  assert.match(app, /layoutPages\(/)
  assert.match(app, /onTouchEnd=/)
  assert.match(app, /edgeControllerRef\.current\.onQueueChanged\(storyIndex, stories\.length\)/)
  assert.match(app, /urgent: true/)
  assert.doesNotMatch(app, /DAILY LORE|ISSUE NO\./)
})
