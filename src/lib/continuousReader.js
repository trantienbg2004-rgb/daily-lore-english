/** DAILY LORE: one verified, curated article library. No old newspaper snippets
 * or fabricated placeholder image pool can silently enter the reading stream.
 * Updated manifests are rechecked while the app is open.
 */
import {fetchManifest,newsChunkOrder,scanFeed} from './feedQueue.js'
export const PUBLISHED_POOLS=['lore-reader']
export const REFRESH_INTERVAL_MS=5*60_000
export function eligibleManifest(m,path){
 return path==='lore-reader'&&m?.feedType==='lore'&&m?.ready===true&&m?.editorialVersion===1&&
  Number.isInteger(m.count)&&m.count>=1&&m.count<100000&&m.total>=15&&
  Number(m.withVerifiedPhoto)>=15&&m.sourcePhotosOnly===true
}
export async function refreshCatalog({fetchImpl,baseUrl,pools=[],now=Date.now(),fetchManifestImpl=fetchManifest}){
 const old=new Map(pools.map(p=>[p.path,p])),next=[],failures=[]
 for(const name of PUBLISHED_POOLS){
  try{
   const m=await fetchManifestImpl(fetchImpl,baseUrl,now,name)
   if(!eligibleManifest(m,name))throw Error('curated-release-not-ready')
   const p=old.get(name)
   next.push(p?.version===m.version?p:{path:name,manifest:m,version:m.version,order:newsChunkOrder(m.count),cursor:0,done:false})
  }catch(e){failures.push(`${name}: ${e?.message||e}`);if(old.has(name))next.push(old.get(name))}
 }
 return {pools:next,failures,hasAvailable:next.length>0,checkedAt:now}
}
export async function refillCatalog({fetchImpl,baseUrl,pools,seen=new Set(),loaded=new Set(),target=30,urgent=false,scanFeedImpl=scanFeed,maxChunksPerPool=9}){
 const updated=pools.map(p=>({...p})),items=[],errors=[]
 for(const pool of updated){
  if(pool.done)continue
  let loops=0
  do{
   const r=await scanFeedImpl({fetchImpl,baseUrl,order:pool.order,cursor:pool.cursor,updatedAt:pool.manifest.updatedAt,
    seen,loaded,target:target-items.length,maxChunks:maxChunksPerPool,concurrency:urgent?1:2,feedPath:pool.path})
   for(const id of r.ids)loaded.add(id)
   items.push(...r.items);pool.cursor=r.cursor;pool.done=r.done
   if(r.error){errors.push({path:pool.path,message:String(r.error.message||r.error)});break}
   if(!r.scanned)break
   loops++
  }while(urgent&&!pool.done&&items.length===0&&loops<30)
 }
 return {items,pools:updated,done:updated.length>0&&updated.every(p=>p.done),errors}
}
