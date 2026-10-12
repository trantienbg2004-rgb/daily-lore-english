import test from 'node:test'
import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
import {fetchManifest,scanFeed,newsChunkOrder,readableStory,storyId,validStories} from '../../src/lib/feedQueue.js'
import {photoCandidates} from '../../src/lib/photoPresentation.js'
import {orderEditorial} from '../../src/lib/editorial.js'

const app = readFileSync(new URL('../../src/App.jsx',import.meta.url),'utf8')
const workflow = readFileSync(new URL('../../.github/workflows/daily-stories.yml',import.meta.url),'utf8')
const styles = readFileSync(new URL('../../src/App.css',import.meta.url),'utf8')
const news = n => ({ id:`n-${n}`,title:`News ${n} headline about space science and society`,sourceUrl:`https://e.vnexpress.net/news/${n}`,
  contentType:'news-preview',newsSource:'VnExpress International',category:'WORLD',publishedAt:'2026-10-12T00:00:00Z',
  pages:[{image:'/news-feed/source-card.svg',text:`This is an authentic attributed short news excerpt about number ${n} reported by the original publisher.`}] })
const response=data=>({ok:true,json:async()=>data})

test('V22-B preserves swipe navigation, accessible dictionary and all three tabs, without changing stylesheet',()=>{
 for (const text of ['onTouchEnd=', 'onPointerUp=', 'changePage(', 'changeStory(', 'layoutPages(',
  'lookupWord(', 'saveWord', 'initializeSeenHistory()', "['read', 'book', 'Read']", "['words', 'bookmark', 'Words']", "['review', 'layers', 'Review']"])
  assert.ok(app.includes(text),`Missing previously working feature: ${text}`)
 assert.match(styles,/\.reading-mode \.article-text/)
 assert.match(app,/BUFFER_TARGET = 50/)
 assert.match(app,/BUFFER_REFILL_AT = 30/)
 assert.doesNotMatch(app,/fetch\(`\$\{import\.meta\.env\.BASE_URL\}stories\.json`/)
 assert.doesNotMatch(app,/import initialStories from/)
})
test('V22-B news previews have one real excerpt page; no need to fabricate newspaper full text',()=>{
 assert.equal(readableStory(news(1)),true)
 assert.equal(validStories([news(1)]),true)
 assert.equal(readableStory({...news(1),pages:[{image:'',text:'Too short'}]}),false)
 assert.equal(readableStory({...news(1),sourceUrl:'javascript:evil'}),false)
 const legacy={...news(1),contentType:'encyclopedia',pages:[{image:'',text:'Old encyclopedia entry'}]}
 assert.equal(readableStory(legacy),false)
})
test('V22-A newest articles are in first chunk; V22-B scans 100 unique items without dropping them',async()=>{
 const chunks=Array.from({length:8},(_,i)=>Array.from({length:20},(_,j)=>news(i*20+j)))
 const urls=[]
 const fetchImpl=async url=>{urls.push(url);const m=url.match(/(\d{4})\.json/);return response(chunks[Number(m[1])])}
 const queued=[],loaded=new Set(),seen=new Set()
 const order=newsChunkOrder(chunks.length)
 let cursor=0
 for (let swipe=0;swipe<100;swipe++) {
  if (queued.length<30) {
   const result=await scanFeed({fetchImpl,baseUrl:'/',feedPath:'news-feed',order,cursor,
    loaded,seen,target:50-queued.length,maxChunks:9,concurrency:2,random:()=>0.99})
   result.ids.forEach(id=>loaded.add(id)); queued.push(...result.items);cursor=result.cursor
  }
  const next=queued.shift()
  assert.ok(next,`No real news remaining at swipe ${swipe}`)
  assert.ok(!seen.has(storyId(next)))
  seen.add(storyId(next))
 }
 assert.equal(seen.size,100)
 assert.ok(urls.every(url=>url.startsWith('/news-feed/')))
 assert.ok(queued.length<70)
})
test('V22-B requests verified newsroom manifest, including readiness, never legacy feed manifest',async()=>{
 const requests=[]
 const m=await fetchManifest(async url=>{
  requests.push(url)
  return response({chunks:11,updatedAt:'2026-10-12',feedType:'news',ready:true,sourceCount:3})
 },'/',123,'news-feed')
 assert.equal(m.ready,true)
 assert.equal(m.sourceCount,3)
 assert.deepEqual(newsChunkOrder(3),[0,1,2])
 assert.ok(requests[0].includes('/news-feed/manifest.json'))
 assert.match(app,/manifest\.ready !== true/)
 assert.match(app,/manifest\.sourceCount < 3/)
})
test('V22-B old Wikipedia collector cannot reappear on scheduled runs',()=>{
 assert.match(workflow,/node scripts\/v22a-collect\.mjs/)
 assert.match(workflow,/node scripts\/v22a-check\.mjs --strict/)
 assert.doesNotMatch(workflow,/node scripts\/(update-stories|import-nasa|import-agency-news)\.mjs/)
 assert.match(workflow,/git add -A public\/news-feed\//)
})
test('V22-B allows only shipped neutral source card as a relative image',()=>{
 assert.deepEqual(photoCandidates('/news-feed/source-card.svg'),['/news-feed/source-card.svg'])
 assert.deepEqual(photoCandidates('/feed/private.svg'),[])
 assert.deepEqual(photoCandidates('javascript:alert(1)'),[])
})

test('V22-B shows substantive publisher briefs before NASA seminar announcements',()=>{
 const brief=news(999)
 const event={...brief,contentType:'news',title:'IR STIG Seminar, 13 Oct 2026',pages:Array.from({length:4},()=>({image:'',text:'The institute announced an upcoming seminar on related research activities. '.repeat(8)}))}
 assert.equal(orderEditorial([event,brief])[0],brief)
})
