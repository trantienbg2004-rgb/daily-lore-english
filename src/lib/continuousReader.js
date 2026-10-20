/** Global indexed feed; V1 shard scanning remains a safe compatibility fallback. */
import {fetchManifest,newsChunkOrder,scanFeed,fetchWithTimeout,validStories,readableStory,storyId} from './feedQueue.js'
import {pickGlobalCandidates} from './recommendationEngine.js'
export const PUBLISHED_POOLS=['wiki-reader']
const WIKI_POOL='wiki-reader'
export const REFRESH_INTERVAL_MS=3*60_000
export function eligibleManifest(m,path){
 if(path===WIKI_POOL)return m?.ready===true&&m?.feedType==='wiki'&&m?.editorialVersion===2&&
  Number.isInteger(m.count)&&m.count>=20&&m.total>=200&&m.withVerifiedPhoto===m.total&&
  ['Politics','Economy','Conflict & Security','Society','Culture','Science & Technology',
   'Environment','Health','History & Geography','Sports'].every(topic=>(m.byTopic?.[topic]||0)>=15)
 return false
}
async function getIndex(fetchImpl,baseUrl,path,manifest,now){
 if(!manifest.indexFile)return null
 const url=`${baseUrl}${path}/${manifest.indexFile}?t=${now}`
 const res=await fetchWithTimeout(fetchImpl,url,{cache:'no-store'})
 if(!res.ok)throw Error(`Global index HTTP ${res.status}`)
 const data=await res.json()
 if(data.version!==(path===WIKI_POOL?3:2)||data.total!==manifest.total||!Array.isArray(data.entries)||data.entries.length!==manifest.total||
  data.contentHash!==(manifest.contentHash||''))throw Error('Global index mismatch')
 return data.entries
}
export async function refreshCatalog({fetchImpl,baseUrl,pools=[],now=Date.now(),fetchManifestImpl=fetchManifest}){
 const old=new Map(pools.map(p=>[p.path,p])),next=[],failures=[],newIds=[]
 let wikiReady=false
 let wikiDeclaredReady=false
 try{
  const m=await fetchManifestImpl(fetchImpl,baseUrl,now,WIKI_POOL)
  wikiDeclaredReady=m?.ready===true&&m?.feedType==='wiki'
  if(eligibleManifest(m,WIKI_POOL)){
   const index=await getIndex(fetchImpl,baseUrl,WIKI_POOL,m,now)
   const p=old.get(WIKI_POOL),known=new Set(p?.index?.map(entry=>entry.id)||[])
   for(const entry of index)if(entry.contentType==='wiki'&&!known.has(entry.id))newIds.push(entry.id)
   next.push(p?.version===m.version?p:{path:WIKI_POOL,manifest:m,version:m.version,index,
    order:newsChunkOrder(m.count),cursor:0,done:false,cache:new Map()})
   wikiReady=true
  }else if(old.has(WIKI_POOL)){next.push(old.get(WIKI_POOL));wikiReady=true;failures.push('wiki-reader: new release not ready; retaining verified prior catalog')}
 }catch(error){
  if(old.has(WIKI_POOL)){next.push(old.get(WIKI_POOL));wikiReady=true;failures.push(`wiki-reader: ${error?.message||error}`)}
  else if(wikiDeclaredReady)return {pools:[],failures:[`wiki-reader: ${error?.message||error}`],newIds:[],hasAvailable:false,checkedAt:now}
 }
 if(!wikiReady&&!failures.length)failures.push('wiki-reader: approved 200-story release not ready')
 return {pools:next,failures,newIds,hasAvailable:wikiReady,checkedAt:now}
}
async function refillGlobal({pool,fetchImpl,baseUrl,seen,loaded,seenAt,profile,recent,target,random,maxShards=10,newsOnly=false,priorityIds=new Set()}){
 const type=pool.path===WIKI_POOL?'wiki':newsOnly||pool.manifest.newsOnly?'news':null
 const candidates=type?pool.index.filter(e=>e.contentType===type):pool.index
 const selected=pickGlobalCandidates(candidates,{seen,loaded,seenAt,profile,recent,count:Math.max(target*3,90),random,
  avoidSameDay:pool.path===WIKI_POOL})
 const priority=candidates.filter(e=>priorityIds.has(e.id)&&!seen.has(e.id)&&!loaded.has(e.id))
 const selection=[...priority,...selected.items.filter(e=>!priorityIds.has(e.id))]
 const chosen=[],used=new Set()
 for(const entry of selection){if(!used.has(entry.shard)){if(used.size>=maxShards)continue;used.add(entry.shard)}chosen.push(entry)}
 const byShard=new Map(),errors=[]
 const results=await Promise.allSettled([...used].map(async shard=>{
  if(pool.cache?.has(shard))return [shard,pool.cache.get(shard)]
  if(!/^\d{4,}$/.test(shard))throw Error('Unsafe shard name')
  const url=`${baseUrl}${pool.path}/${shard}.json?v=${encodeURIComponent(pool.manifest.contentHash||pool.manifest.updatedAt||'')}`
  const response=await fetchWithTimeout(fetchImpl,url,{cache:'no-cache'})
  if(!response.ok)throw Error(`Shard ${shard} HTTP ${response.status}`)
  const items=await response.json()
  if(!validStories(items))throw Error(`Corrupt shard ${shard}`)
  if(!pool.cache)pool.cache=new Map()
  pool.cache.set(shard,items)
  if(pool.cache.size>12)pool.cache.delete(pool.cache.keys().next().value)
  return [shard,items]
 }))
 results.forEach((r,i)=>{if(r.status==='fulfilled')byShard.set(...r.value);else errors.push({path:pool.path,message:String(r.reason?.message||r.reason)})})
 const indexed=new Map()
 for(const [shard,stories] of byShard)for(const story of stories)indexed.set(`${shard}:${storyId(story)}`,story)
 const items=[]
 for(const entry of chosen){
  const story=indexed.get(`${entry.shard}:${entry.id}`)
  if(story&&(!type||story.contentType===type)&&readableStory(story)&&!loaded.has(entry.id)&&items.length<target){loaded.add(entry.id);items.push(story)}
 }
 // Global mode does not permanently end: earlier read stories can re-enter
 // after the complete unseen library is exhausted and leave the active queue.
 return {items,errors,done:candidates.length===0||selected.items.length===0,fallback:selected.fallback}
}
export async function refillCatalog({fetchImpl,baseUrl,pools,seen=new Set(),loaded=new Set(),seenAt=new Map(),profile={categories:{}},recent=[],target=30,urgent=false,
 scanFeedImpl=scanFeed,maxChunksPerPool=9,random=Math.random,newsOnly=false,priorityIds=new Set()}){
 const updated=pools.map(p=>({...p})),items=[],errors=[]
 for(const pool of updated){
  if(pool.index){
   const result=await refillGlobal({pool,fetchImpl,baseUrl,seen,loaded,seenAt,profile,recent,target:target-items.length,random,maxShards:Math.max(urgent?3:10,priorityIds.size),newsOnly,priorityIds})
   items.push(...result.items);errors.push(...result.errors)
   pool.done=result.done;pool.fallback=result.fallback
   continue
  }
  if(pool.done)continue
  // Never scan legacy shards in production news-only mode.
  if(newsOnly||pool.manifest.newsOnly){pool.done=true;errors.push({path:pool.path,message:'News-only index unavailable'});continue}
  let loops=0
  do{
   const r=await scanFeedImpl({fetchImpl,baseUrl,order:pool.order,cursor:pool.cursor,updatedAt:pool.manifest.updatedAt,seen,loaded,
    target:target-items.length,maxChunks:maxChunksPerPool,concurrency:urgent?1:2,feedPath:pool.path,random})
   for(const id of r.ids)loaded.add(id)
   items.push(...r.items);pool.cursor=r.cursor;pool.done=r.done
   if(r.error){errors.push({path:pool.path,message:String(r.error.message||r.error)});break}
   if(!r.scanned)break
   loops++
  }while(urgent&&!pool.done&&items.length===0&&loops<30)
 }
 return {items,pools:updated,done:updated.length>0&&updated.every(p=>p.done),errors}
}
