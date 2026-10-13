import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtemp,mkdir,readFile,writeFile,rm} from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {fingerprintWorldReader,refreshWorldAndPhotos} from '../v22d12-refresh.mjs'

async function fixture(t){
 const base=await mkdtemp(path.join(os.tmpdir(),'d12-refresh-'))
 t.after(()=>rm(base,{recursive:true,force:true}))
 await mkdir(path.join(base,'public','world-reader'),{recursive:true})
 await mkdir(path.join(base,'public','visual-reader'),{recursive:true})
 await writeFile(path.join(base,'public','world-reader','manifest.json'),JSON.stringify({ready:true,feedType:'news',chunks:1}))
 await writeFile(path.join(base,'public','world-reader','0000.json'),JSON.stringify([{sourceUrl:'https://globalvoices.org/story',title:'A World Event',pages:[{text:'Verified prose.'}],publishedAt:'2026-10-10'}]))
 return base
}
const worldUpdate=async()=>({built:{manifest:{ready:true,total:1,sourceCount:3},published:true},collected:{added:0}})
const log={log(){},warn(){}}

test('D12 fingerprint is stable when generated manifest timestamps change',async t=>{
 const base=await fixture(t)
 const before=await fingerprintWorldReader(base)
 await writeFile(path.join(base,'public','world-reader','manifest.json'),JSON.stringify({ready:true,feedType:'news',chunks:1,updatedAt:'tomorrow'}))
 assert.equal(await fingerprintWorldReader(base),before)
})

test('D12 skips network photo service when all validated world content is unchanged',async t=>{
 const base=await fixture(t)
 const hash=await fingerprintWorldReader(base)
 await writeFile(path.join(base,'public','visual-reader','d12-input.sha256'),hash+'\n')
 let calls=0
 const result=await refreshWorldAndPhotos({base,log,worldUpdate,photoCheck:async()=>({total:58}),photoUpdate:async()=>{calls++;return{ready:true}}})
 assert.equal(calls,0)
 assert.equal(result.photos,'unchanged')
})

test('D12 publishes fresh photos after a source change, then persists revision hash',async t=>{
 const base=await fixture(t)
 const result=await refreshWorldAndPhotos({base,log,worldUpdate,photoCheck:async()=>({total:58}),photoUpdate:async()=>({ready:true})})
 assert.equal(result.photos,'updated')
 const stamp=await readFile(path.join(base,'public','visual-reader','d12-input.sha256'),'utf8')
 assert.equal(stamp.trim(),await fingerprintWorldReader(base))
})

test('D12 source image API outage preserves the former release and does not stamp it as refreshed',async t=>{
 const base=await fixture(t)
 const result=await refreshWorldAndPhotos({base,log,worldUpdate,photoCheck:async()=>({total:58}),photoUpdate:async()=>{throw Error('Wikimedia timeout')}})
 assert.equal(result.photos,'preserved-old-release')
 assert.rejects(readFile(path.join(base,'public','visual-reader','d12-input.sha256'),'utf8'),/ENOENT/)
})

test('D12 refuses updating images if text publish quality gate is not ready',async t=>{
 const base=await fixture(t)
 let calls=0
 await assert.rejects(refreshWorldAndPhotos({base,log,worldUpdate:async()=>({built:{manifest:{ready:false}}}),photoUpdate:async()=>{calls++}}),/World reader not ready/)
 assert.equal(calls,0)
})
