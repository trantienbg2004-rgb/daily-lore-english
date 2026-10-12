import test from 'node:test'
import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
import {photoLabel, photoSourceLink} from '../../src/lib/photoPresentation.js'
import {createEdgeNavigation} from '../../src/lib/edgeNavigation.js'
import {scanFeed,storyId} from '../../src/lib/feedQueue.js'

const app=readFileSync(new URL('../../src/App.jsx',import.meta.url),'utf8')
const css=readFileSync(new URL('../../src/App.css',import.meta.url),'utf8')

const page={image:'https://upload.wikimedia.org/wikipedia/commons/4/49/Koala_climbing_tree.jpg?utm_source=wiki',caption:'Wikipedia / Wikimedia Commons · Attribution and image licensing: see original source'}
test('V19: generic photo caption becomes human-readable filename, never a URL',()=>{
  assert.equal(photoLabel(page),'Koala climbing tree')
  assert.ok(photoSourceLink(page).startsWith('https://commons.wikimedia.org/wiki/File:'))
  assert.ok(!photoLabel(page).includes('http'))
  assert.equal(photoLabel({image:'https://example.org/img/Beautiful_Landscape.png',caption:'Beautiful Landscape.png · Photographer · CC BY-SA 4.0 · Credits: https://commons.wikimedia.org/wiki/File:Beautiful_Landscape.png'}),'Beautiful Landscape')
  assert.equal(photoLabel({image:'',caption:'foo'}),'')
})
test('V20 photo credit and license remain accessible on last page, not overlaying images',()=>{
  assert.match(app,/className="photo-caption" title=\{label\}/)
  assert.match(app,/Sources &amp; credits/)
  assert.match(app,/photoSourceLink\(p\)/)
  assert.match(app,/source-footer/)
  assert.doesNotMatch(app,/className="photo-credits"/)
  assert.match(css,/\.reading-mode \.article-media img\s*\{[^}]*width:auto; height:auto; max-width:100%; max-height:/)
  assert.match(css,/object-fit:contain/)
})
test('V19: visible branding, vocabulary, reading pagination, and existing feed ingestion remain',()=>{
  assert.match(app,/<span className="brand">DAILY NEWS<\/span>/)
  assert.doesNotMatch(app,/DAILY LORE|ISSUE NO\./)
  for(const token of ['lookupWord(', 'saveWord', 'nextReview', 'layoutPages(', 'initializeSeenHistory()', 'onTouchEnd=', 'onPointerUp=', 'photoLabel(']) assert.ok(app.includes(token),token)
  assert.ok(app.includes('BUFFER_TARGET = 30'))
})
test('V19: urgent feed search targets one first unread article and releases without a 36-chunk wait',()=>{
  assert.match(app,/target: urgent \? 1 : BUFFER_TARGET - remaining - appended/)
  assert.match(app,/maxChunks: 9, concurrency: 3/)
  assert.match(app,/if \(!urgent \|\| appended > 0\) break/)
  assert.match(app,/if \(storyIndex < stories.length - 1\) return/)
  assert.match(app,/loadFeed\(\{urgent: true, forceCheck: doneRef.current\}\)/)
})
test('V19: existing Read tab is a fallback Next control at the boundary without another overlay',()=>{
  assert.match(app,/key === 'read' && tab === 'read' && story && storyIndex === stories.length - 1\) changeStory\(1\)/)
  assert.match(app,/waitingForNext \? 'Finding…' : feedDone \? 'Check again' : 'Next ↓'/)
  assert.ok(!app.includes('className="feed-end-indicator"'))
})
test('V19: first unread result of a slow scan immediately fulfills waiting swipe',async()=>{
  let index=0,count=1,requests=0,waiting=false
  let releaseRequest
  const blocker=new Promise(resolve=>releaseRequest=resolve)
  const article = n=>({title:`A ${n}`,sourceUrl:`https://example.com/${n}`,pages:Array.from({length:4},()=>({text:('The world has many places and stories worth reading. ').repeat(12),image:'',caption:''}))})
  const chunks=[[article(1)],[article(2)],[article(3)]]
  const seen=new Set([storyId(chunks[0][0])])
  const controller=createEdgeNavigation({
    advance:d=>{index+=d},onWaitingChange:v=>{waiting=v},
    requestMore:async()=>{
      requests++
      await blocker
      const result=await scanFeed({fetchImpl:async url=>({ok:true,json:async()=>chunks[Number(url.match(/(\d{4})\.json/)[1])]}),baseUrl:'/',order:[0,1,2],cursor:0,seen,loaded:new Set(),target:1,maxChunks:9})
      count+=result.items.length
      controller.onQueueChanged(index,count)
    },
  })
  assert.equal(controller.forward(index,count),'waiting')
  assert.equal(index,0)
  releaseRequest()
  await new Promise(resolve=>setTimeout(resolve,45))
  assert.equal(requests,1)
  assert.equal(index,1)
  assert.equal(waiting,false)
})

test('V19: REAL gesture handlers from App convert one upward touch at the end into a pending advance',async()=>{
  // Evaluate the actual handlers extracted from App.jsx, not only the pure
  // edge controller in isolation. This caught the missing integration in V18.
  const navigationBlock=app.slice(app.indexOf('  const changeStory = '),app.indexOf('  const nextReview = '))
  const touchBlock=app.slice(app.indexOf('  const startGesture = '),app.indexOf('  const onWordClick = '))
  assert.ok(navigationBlock.startsWith('  const changeStory = '))
  assert.ok(touchBlock.startsWith('  const startGesture = '))
  const factory=new Function('refs',`const {edgeControllerRef,storyIndexRef,storiesRef,selected,gesture,suppressWordClick,pointerGesture,lastNavigationGesture,changePage} = refs;
    ${navigationBlock}\n${touchBlock}\nreturn {startGesture,endGesture,startPointer,endPointer,changeStory}`)
  let navigations=0,waiting=false
  const storyIndexRef={current:0}; const storiesRef={current:[{title:'First'}]}
  const edgeControllerRef={current:createEdgeNavigation({
    advance:d=>{storyIndexRef.current+=d;navigations++},
    onWaitingChange:v=>{waiting=v},
    requestMore:()=>{},
  })}
  const handlers=factory({edgeControllerRef,storyIndexRef,storiesRef,selected:'',gesture:{current:null},suppressWordClick:{current:false},pointerGesture:{current:null},lastNavigationGesture:{current:0},changePage:()=>{}})
  const target={closest:()=>null}
  handlers.startGesture({touches:[{clientX:150,clientY:380}],target})
  handlers.endGesture({changedTouches:[{clientX:150,clientY:190}]})
  assert.equal(waiting,true)
  assert.equal(navigations,0)
  storiesRef.current.push({title:'Next'})
  edgeControllerRef.current.onQueueChanged(storyIndexRef.current,storiesRef.current.length)
  assert.equal(storyIndexRef.current,1)
  assert.equal(waiting,false)
  assert.equal(navigations,1)
})

test('V19: pointerup plus touchend from same swipe cannot accidentally skip two articles',()=>{
  const nav=app.slice(app.indexOf('  const changeStory = '),app.indexOf('  const nextReview = '))
  const touch=app.slice(app.indexOf('  const startGesture = '),app.indexOf('  const onWordClick = '))
  let count=0;const storyIndexRef={current:0};const storiesRef={current:Array.from({length:5},(_,i)=>({title:String(i)}))}
  const edgeControllerRef={current:createEdgeNavigation({advance:d=>{storyIndexRef.current+=d;count++},requestMore:()=>{},onWaitingChange:()=>{}})}
  const factory=new Function('refs',`const {edgeControllerRef,storyIndexRef,storiesRef,selected,gesture,suppressWordClick,pointerGesture,lastNavigationGesture,changePage} = refs;${nav}\n${touch}\nreturn {startGesture,endGesture,startPointer,endPointer}`)
  const reader=factory({edgeControllerRef,storyIndexRef,storiesRef,selected:'',gesture:{current:null},suppressWordClick:{current:false},pointerGesture:{current:null},lastNavigationGesture:{current:0},changePage:()=>{}})
  const target={closest:()=>null}
  reader.startGesture({touches:[{clientX:100,clientY:400}],target})
  reader.startPointer({pointerType:'touch',pointerId:1,clientX:100,clientY:400,target})
  reader.endPointer({pointerId:1,clientX:100,clientY:180})
  reader.endGesture({changedTouches:[{clientX:100,clientY:180}]})
  assert.equal(count,1)
  assert.equal(storyIndexRef.current,1)
})
