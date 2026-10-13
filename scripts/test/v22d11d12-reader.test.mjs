import test from 'node:test'
import assert from 'node:assert/strict'
import {planReadingPages,sentenceUnits} from '../../src/lib/readerPagination.js'
import {refreshCatalog,refillCatalog,eligibleManifest} from '../../src/lib/continuousReader.js'

const story=(text,photos=[])=>({pages:[{text,image:photos[0]||'',caption:'Photo credit'},...photos.slice(1).map(image=>({text:'',image,caption:'Other credit'}))]})
const plain=pages=>pages.map(x=>x.text).join(' ').replace(/\s+/g,' ').trim()
const m=(total,updatedAt='2026-10-13')=>({ready:true,feedType:'news',sourceCount:3,count:total,total,chunks:total,version:updatedAt+':'+total+':'+total,updatedAt,withVerifiedPhoto:58,sourcePhotosOnly:true})

test('D11 never puts an orphan word under a photo when first sentence will not fit',()=>{
 const text='Homeowners across England will gain a clearer picture of flood risks under a new certification plan. Further measures will follow.'
 const pages=planReadingPages(story(text,['/original-reader-media/111111111111111111111111.jpg']),({text:t,image})=>t.split(/\s+/).filter(Boolean).length<=(image?2:20))
 assert.equal(pages[0].text,'')
 assert.ok(pages[0].image)
 assert.match(pages[1].text,/^Homeowners across England/)
 assert.equal(plain(pages),text)
})

test('D11 retains complete sentences and exactly all words when each fits',()=>{
 const text='The first sentence describes the event. The second sentence supplies evidence. The third sentence explains what happens next.'
 const pages=planReadingPages(story(text,['/original-reader-media/111111111111111111111111.jpg']),({text:t,image})=>t.split(/\s+/).filter(Boolean).length <= (image?7:10))
 assert.equal(plain(pages),text)
 for(const p of pages) if(p.text)assert.match(p.text,/[.!?]$/)
 assert.equal(pages[0].text,'The first sentence describes the event.')
})

test('D11 extraordinary long sentences break into clauses before raw words',()=>{
 const text='Flooding has a number of causes, including heavy rain and poorly protected homes, and local councils have issued additional advice.'
 const pages=planReadingPages(story(text),({text:t})=>t.split(/\s+/).filter(Boolean).length<=10)
 assert.equal(plain(pages),text)
 assert.ok(pages[0].text.endsWith(','))
 assert.ok(pages.length>=2)
})

test('D11 handles a very long article without deleting any sentence',()=>{
 const text=Array.from({length:210},(_,i)=>`Paragraph ${i} provides the verified account of an event.`).join(' ')
 const pages=planReadingPages(story(text,['/original-reader-media/111111111111111111111111.jpg']),({text:t,image})=>t.split(/\s+/).filter(Boolean).length<=(image?8:25))
 assert.equal(plain(pages),text)
 assert.ok(pages.length>50)
})

test('D11 places the second contextual photo on a later page, never as a duplicate',()=>{
 const text=Array.from({length:30},(_,i)=>`A complete sentence number ${i} explains part of the event.`).join(' ')
 const pages=planReadingPages(story(text,['photo-one','photo-two']),({text:t})=>t.split(/\s+/).filter(Boolean).length<=12)
 const photos=pages.filter(p=>p.image).map(p=>p.image)
 assert.deepEqual(photos,['photo-one','photo-two'])
 assert.equal(plain(pages),text)
})

test('D11 sentence segmentation does not end on Dr., Mrs., initials or U.S.',()=>{
 const s=sentenceUnits('Dr. Lee consulted Mrs. Chan in the U.S. yesterday. The report was published.')
 assert.equal(s.length,2)
 assert.match(s[0],/^Dr\. Lee consulted Mrs\. Chan/)
})

test('D12 refuses an unverified photo feed',()=>{
 assert.equal(eligibleManifest({...m(3),sourcePhotosOnly:false},'source-visual-reader'),false)
 assert.equal(eligibleManifest(m(3),'source-visual-reader'),true)
 assert.equal(eligibleManifest({...m(3),sourceCount:1},'world-reader'),false)
 assert.equal(eligibleManifest(m(3),'some-random-feed'),false)
})

test('D12 catalog loads both pools and retains a previous verified pool during an outage',async()=>{
 const fetchManifestImpl=async (_f,_b,_t,path)=>{if(path==='world-reader')throw Error('offline');return m(3)}
 const previous=[{path:'world-reader',manifest:m(4),version:m(4).version,order:[0,1,2,3],cursor:2,done:false}]
 const r=await refreshCatalog({fetchImpl:()=>{},baseUrl:'/',pools:previous,fetchManifestImpl})
 assert.deepEqual(r.pools.map(p=>p.path),['source-visual-reader','world-reader'])
 assert.equal(r.pools[1].cursor,2)
 assert.equal(r.failures.length,1)
})

test('D12 changed manifest rewinds just the updated pool, not both',async()=>{
 const p=(path,cursor,version)=>({path,manifest:{...m(4),version},version,order:[0,1,2,3],cursor,done:true})
 const old=[p('source-visual-reader',4,m(4).version),p('world-reader',4,m(4).version)]
 const out=await refreshCatalog({fetchImpl:()=>{},baseUrl:'/',pools:old,fetchManifestImpl:async(_f,_b,_t,path)=>path==='world-reader'?m(5,'2026-10-14'):m(4)})
 assert.equal(out.pools[0].cursor,4)
 assert.equal(out.pools[1].cursor,0)
 assert.equal(out.pools[1].done,false)
})

test('D12 exhausts illustrated articles then finds additional distinct text articles',async()=>{
 const pools=['source-visual-reader','world-reader'].map(path=>({path,manifest:m(1),version:m(1).version,order:[0],cursor:0,done:false}))
 const loaded=new Set(),seen=new Set()
 const records={'source-visual-reader':['a','b'],'world-reader':['a','c','d']}
 const scanner=async({feedPath,cursor,loaded,seen})=>{
  const list=records[feedPath].filter(k=>!loaded.has(k)&&!seen.has(k)).map(sourceUrl=>({sourceUrl}))
  return {items:list,ids:new Set(list.map(x=>x.sourceUrl)),cursor:cursor+1,done:true,scanned:1,error:null}
 }
 const result=await refillCatalog({fetchImpl:()=>{},baseUrl:'/',pools,loaded,seen,target:20,scanFeedImpl:scanner})
 assert.deepEqual(result.items.map(x=>x.sourceUrl),['a','b','c','d'])
 assert.equal(result.done,true)
})

test('D12 preserves failed cursor, then retries and resumes without repeating already loaded IDs',async()=>{
 const pools=['source-visual-reader','world-reader'].map(path=>({path,manifest:m(2),version:m(2).version,order:[0,1],cursor:0,done:false}))
 let failed=true
 const scanner=async ({feedPath,cursor,loaded}) => {
  if(feedPath==='source-visual-reader'&&failed){failed=false;return {items:[],ids:new Set(),cursor,done:false,scanned:0,error:Error('wifi gone')}}
  const id=`${feedPath}-${cursor}`
  return {items:loaded.has(id)?[]:[{sourceUrl:id}],ids:new Set(loaded.has(id)?[]:[id]),cursor:cursor+1,done:cursor+1>=2,scanned:1,error:null}
 }
 const loaded=new Set()
 const a=await refillCatalog({fetchImpl:()=>{},baseUrl:'/',pools,loaded,target:5,scanFeedImpl:scanner})
 assert.equal(a.errors.length,1)
 assert.equal(a.pools[0].cursor,0)
 const b=await refillCatalog({fetchImpl:()=>{},baseUrl:'/',pools:a.pools,loaded,target:5,scanFeedImpl:scanner,urgent:true})
 assert.ok(b.items.some(x=>x.sourceUrl==='source-visual-reader-0'))
 assert.equal(new Set([...a.items,...b.items].map(x=>x.sourceUrl)).size,a.items.length+b.items.length)
})

test('D12 network outage with no old catalog reports not-ready without fabricating stories',async()=>{
 const r=await refreshCatalog({fetchImpl:()=>{},baseUrl:'/',fetchManifestImpl:async()=>{throw Error('offline')}})
 assert.equal(r.hasAvailable,false)
 assert.deepEqual(r.pools,[])
})

test('D12 full queue integration: 58 publisher-native illustrated plus 117 text articles yields exactly 117 unique stories, then fresh stories appear',async()=>{
 const longText=Array.from({length:30},(_,i)=>`Article section ${i} records several verified developments in the world today.`).join(' ')
 const mkStory=(i,photo=false)=>({sourceUrl:`https://globalvoices.org/2026/10/${String(i+1).padStart(2,'0')}/story-${i}/`,
  title:`An independently checked report ${i}`,contentType:'news',readingKind:'full',
  pages:[{image:photo?`/original-reader-media/${String(i).padStart(24,'a')}.jpg`:'',text:longText},{image:'',text:longText}]})
 const illustrated=Array.from({length:58},(_,i)=>mkStory(i,true))
 const world=Array.from({length:117},(_,i)=>mkStory(i))
 const sources={'source-visual-reader':illustrated,'world-reader':world}
 const fetchImpl=async(url)=>{
  const found=String(url).match(/\/(source-visual-reader|world-reader)\/(manifest|\d{4})\.json/)
  if(!found)return new Response('not found',{status:404})
  const [,source,part]=found
  if(part==='manifest')return new Response(JSON.stringify({ready:true,feedType:'news',sourceCount:3,
    withVerifiedPhoto:58,sourcePhotosOnly:true,updatedAt:'2026-10-13',total:sources[source].length,chunks:Math.ceil(sources[source].length/20)}))
  const start=Number(part)*20
  const rows=sources[source].slice(start,start+20)
  if(!rows.length)return new Response('not found',{status:404})
  return new Response(JSON.stringify(rows))
 }
 let {pools}=await refreshCatalog({fetchImpl,baseUrl:'/'})
 const loaded=new Set(),all=[]
 for(let turn=0;turn<8;turn++){
  const r=await refillCatalog({fetchImpl,baseUrl:'/',pools,loaded,seen:new Set(),target:45})
  pools=r.pools
  all.push(...r.items)
  if(r.done)break
 }
 assert.equal(all.length,117)
 assert.equal(new Set(all.map(x=>x.sourceUrl)).size,117)
 assert.equal(pools.every(x=>x.done),true)
 // A new collection publishes three more verified items in the text reader.
 sources['world-reader'].push(...[117,118,119].map(i=>mkStory(i)))
 const refreshed=await refreshCatalog({fetchImpl,baseUrl:'/',pools,now:Date.now()+60_000})
 // New manifest must change its chunk count. The previously exhausted
 // illustrated pool stays exhausted and the world pool is scanned again.
 assert.equal(refreshed.pools[0].done,true)
 assert.equal(refreshed.pools[1].done,false)
 const more=await refillCatalog({fetchImpl,baseUrl:'/',pools:refreshed.pools,loaded,seen:new Set(),target:10})
 assert.deepEqual(new Set(more.items.map(x=>x.sourceUrl)),new Set([117,118,119].map(i=>mkStory(i).sourceUrl)))
})
