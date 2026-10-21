import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
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
