import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {verifyWikiRelease} from '../build-reader-index.mjs'

test('the Wiki branch ships no old news or lore articles',async()=>{
 await assert.rejects(fs.access(new URL('../../public/lore-reader/',import.meta.url)))
 await assert.rejects(fs.access(new URL('../../.github/workflows/saga-discover-publish.yml',import.meta.url)))
})

test('Wiki release verification reports its actual count and never invents readiness',async()=>{
 const result=await verifyWikiRelease()
 assert.ok(result.total>=0)
 assert.equal(result.ready,result.total>0)
 if(result.total<50)assert.equal(result.targetMet,false)
 if(result.ready){
  assert.ok(result.total>=1)
 }
 if(result.targetMet){
  assert.ok(result.total>=50)
  assert.ok(Object.values(result.byTopic).every(count=>count>=5))
 }
})

test('production accepts the approved 200-story target when a staged catalog is promoted',async()=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'saga-wiki-target-'))
 try{
  const dir=path.join(root,'public','wiki-reader')
  await fs.cp(new URL('../../public/wiki-reader/',import.meta.url),dir,{recursive:true})
  const file=path.join(dir,'manifest.json'),manifest=JSON.parse(await fs.readFile(file,'utf8'))
  manifest.targetStories=200;manifest.targetPerTopic=15;manifest.targetMet=false
  await fs.writeFile(file,JSON.stringify(manifest))
  assert.equal((await verifyWikiRelease(root)).total,manifest.total)
  manifest.targetStories=999
  await fs.writeFile(file,JSON.stringify(manifest))
  await assert.rejects(verifyWikiRelease(root),/readiness mismatch/)
 }finally{await fs.rm(root,{recursive:true,force:true})}
})
