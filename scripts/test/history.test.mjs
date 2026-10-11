import test from 'node:test'
import assert from 'node:assert/strict'
import {initializeSeenHistory,persistReadMarker,readLegacyHistory} from '../../src/lib/seenHistory.js'

function memoryStorage() {
  const records=new Map()
  return {getItem:key=>records.get(key)||null,setItem:(key,value)=>records.set(key,value),removeItem:key=>records.delete(key)}
}

function mockIndexedDB() {
  const data=new Map()
  const db={
    objectStoreNames:{contains:()=>true},close(){},
    transaction(_name,mode) {
      const tx={
        error:null,
        objectStore(){return {
          getAllKeys(){
            const req={error:null}
            queueMicrotask(()=>{req.result=[...data.keys()];req.onsuccess?.()})
            return req
          },
          put(value,key){data.set(key,value)}
        }}
      }
      if(mode==='readwrite')queueMicrotask(()=>tx.oncomplete?.())
      return tx
    }
  }
  return {open(){
    const req={result:db}
    queueMicrotask(()=>req.onsuccess?.())
    return req
  },data}
}

test('reading history migrates 93 legacy reads and preserves 400 new unique reads',async()=>{
  const storage=memoryStorage()
  const initial=Array.from({length:93},(_,i)=>`https://en.wikipedia.org/wiki/Old_${i}`)
  storage.setItem('dailyLoreSeenV1',JSON.stringify(initial))
  const indexedDBImpl=mockIndexedDB()
  const first=await initializeSeenHistory({indexedDBImpl,storage})
  assert.equal(first.seen.size,93)
  assert.equal(storage.getItem('dailyLoreSeenV1'),null)
  for(let i=0;i<400;i++){
    const id=`https://en.wikipedia.org/wiki/New_${i}`
    first.seen.add(id)
    persistReadMarker(first.db,id,first.seen,storage)
  }
  const after=await initializeSeenHistory({indexedDBImpl,storage})
  assert.equal(after.seen.size,493)
  assert.ok(initial.every(id=>after.seen.has(id)))
  assert.equal(storage.getItem('dailyLoreSeenV1'),null)
})

test('fallback retains reading history if IndexedDB is unavailable',async()=>{
  const storage=memoryStorage()
  storage.setItem('dailyLoreSeenV1',JSON.stringify(['seen-one']))
  const unavailable={open(){throw new Error('Blocked in private mode')}}
  const result=await initializeSeenHistory({indexedDBImpl:unavailable,storage})
  assert.ok(result.seen.has('seen-one'))
  assert.equal(result.db,null)
  persistReadMarker(null,'seen-two',new Set(['seen-one','seen-two']),storage)
  assert.deepEqual([...readLegacyHistory(storage)].sort(),['seen-one','seen-two'])
})
