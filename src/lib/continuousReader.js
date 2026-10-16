/** Global indexed feed; V1 shard scanning remains a safe compatibility fallback. */
import {fetchManifest,newsChunkOrder,scanFeed,fetchWithTimeout,validStories,readableStory,storyId} from './feedQueue.js'
import {pickGlobalCandidates} from './recommendationEngine.js'
export const PUBLISHED_POOLS=['lore-reader']
export const REFRESH_INTERVAL_MS=5*60_000
export function eligibleManifest(m,path){
 return path==='lore-reader'&&m?.feedType==='lore'&&m?.ready===true&&m?.editorialVersion===1&&
 Number.isInteger(m.count)&&m.count>=1&&m.count<100000&&m.total>=15&&Number(m.withVerifiedPhoto)>=15&&m.sourcePhotosOnly===true
}
async function getIndex(fetchImpl,baseUrl,path,manifest){
 if(!manifest.indexFile)return null
 const url=`${baseUrl}${path}/${manifest.indexFile}?v=${encodeURIComponent(manifest.indexHash||manifest.contentHash||'')}`
 const res=await fetchWithTimeout(fetchImpl,url,{cache:'no-cache'})
 if(!res.ok)throw Error(`Global index HTTP ${res.status}`)
 const data=await res.json()
 if(data.version!==2||data.total!==manifest.total||!Array.isArray(data.entries)||data.entries.length!==manifest.total||
  data.contentHash!==(manifest.contentHash||''))throw Error('Global index mismatch')
 return data.entries
}
export async function refreshCatalog({fetchImpl,baseUrl,pools=[],now=Date.now(),fetchManifestImpl=fetchManifest}){
 const old=new Map(pools.map(p=>[p.path,p])),next=[],failures=[]
 for(const name of PUBLISHED_POOLS){
  try{
   const m=await fetchManifestImpl(fetchImpl,baseUrl,now,name)
   if(!eligibleManifest(m,name))throw Error('curated-release-not-ready')
   const p=old.get(name)
   if(p?.version===m.version){next.push(p);continue}
   let index=null
   if(m.indexFile){try{index=await getIndex(fetchImpl,baseUrl,name,m)}catch(e){console.warn('Global index unavailable; using existing shard scanner:',e?.message||e)}}
   next.push({path:name,manifest:m,version:m.version,index,order:newsChunkOrder(m.count),cursor:0,done:false,cache:new Map()})
  }catch(e){failures.push(`${name}: ${e?.message||e}`);if(old.has(name))next.push(old.get(name))}
 }
 return {pools:next,failures,hasAvailable:next.length>0,checkedAt:now}
}
async function refillGlobal({pool,fetchImpl,baseUrl,seen,loaded,seenAt,profile,recent,target,random,maxShards=10}){
 const selected=pickGlobalCandidates(pool.index,{seen,loaded,seenAt,profile,recent,count:Math.max(target*3,90),random})
 const chosen=[],used=new Set()
 for(const entry of selected.items){if(!used.has(entry.shard)){if(used.size>=maxShards)continue;used.add(entry.shard)}chosen.push(entry)}
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
  if(story&&readableStory(story)&&!loaded.has(entry.id)&&items.length<target){loaded.add(entry.id);items.push(story)}
 }
 // Global mode does not permanently end: earlier read stories can re-enter
 // after the complete unseen library is exhausted and leave the active queue.
 return {items,errors,done:pool.index.length===0||(!selected.items.length&&!selected.fallback),fallback:selected.fallback}
}
export async function refillCatalog({fetchImpl,baseUrl,pools,seen=new Set(),loaded=new Set(),seenAt=new Map(),profile={categories:{}},recent=[],target=30,urgent=false,
 scanFeedImpl=scanFeed,maxChunksPerPool=9,random=Math.random}){
 const updated=pools.map(p=>({...p})),items=[],errors=[]
 for(const pool of updated){
  if(pool.index){
   const result=await refillGlobal({pool,fetchImpl,baseUrl,seen,loaded,seenAt,profile,recent,target:target-items.length,random,maxShards:urgent?3:10})
   items.push(...result.items);errors.push(...result.errors)
   pool.done=result.done;pool.fallback=result.fallback
   continue
  }
  if(pool.done)continue
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
