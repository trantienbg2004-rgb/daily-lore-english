// Existing IndexedDB store and vocabulary storage remain unchanged.
const DB_NAME='dailyNewsReadHistoryV1',STORE='readStoryIds',LEGACY_KEY='dailyLoreSeenV1'
export function readLegacyHistory(storage=localStorage){
 try{const a=JSON.parse(storage.getItem(LEGACY_KEY)||'[]');return new Set(Array.isArray(a)?a.filter(x=>typeof x==='string'):[])}catch{return new Set()}
}
const done=req=>new Promise((resolve,reject)=>{req.onsuccess=()=>resolve(req.result);req.onerror=()=>reject(req.error||Error('IndexedDB error'))})
const txDone=tx=>new Promise((resolve,reject)=>{tx.oncomplete=()=>resolve();tx.onabort=()=>reject(tx.error||Error('Aborted'));tx.onerror=()=>reject(tx.error||Error('Transaction error'))})
export async function initializeSeenHistory({indexedDBImpl=indexedDB,storage=localStorage}={}){
 const legacy=readLegacyHistory(storage);let db
 try{
  const req=indexedDBImpl.open(DB_NAME,1)
  req.onupgradeneeded=()=>{if(!req.result.objectStoreNames.contains(STORE))req.result.createObjectStore(STORE)}
  db=await done(req)
  const store=db.transaction(STORE,'readonly').objectStore(STORE)
  const keysRequest=store.getAllKeys()
  const valuesRequest=typeof store.getAll==='function'?store.getAll():null
  const keys=await done(keysRequest)
  const seen=new Set([...keys,...legacy]),seenAt=new Map()
  // Older mock/browser stores without getAll still work. Legacy markers have no timestamp.
  if(valuesRequest){
   try{const values=await done(valuesRequest);keys.forEach((id,i)=>seenAt.set(id,Number(values[i])>1?Number(values[i]):0))}catch{/* optional recency */}
  }
  if(legacy.size){
   const tx=db.transaction(STORE,'readwrite')
   for(const id of legacy)tx.objectStore(STORE).put(1,id)
   await txDone(tx)
   try{storage.removeItem(LEGACY_KEY)}catch{/* retained, safe */}
  }
  return {seen,db,seenAt}
 }catch(error){
  console.warn('IndexedDB unavailable; using legacy history:',error)
  try{db?.close()}catch{/* no-op */}
  return {seen:legacy,db:null,seenAt:new Map()}
 }
}
export function persistReadMarker(db,id,seen,storage=localStorage,seenAt){
 const time=Date.now();seenAt?.set(id,time)
 if(db){
  try{
   const tx=db.transaction(STORE,'readwrite')
   tx.objectStore(STORE).put(time,id)
   tx.onabort=()=>{try{storage.setItem(LEGACY_KEY,JSON.stringify([...seen]))}catch{/* full */}}
   return
  }catch{/* legacy fallback */}
 }
 try{storage.setItem(LEGACY_KEY,JSON.stringify([...seen]))}catch(error){console.warn('History save failed',error)}
}
