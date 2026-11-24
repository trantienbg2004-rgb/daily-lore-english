import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import {queuedUnread,lowOnStories,refreshDue,UNREAD_LOW_WATERMARK,QUEUE_TARGET,LOW_STOCK_POLL_MS,NORMAL_POLL_MS} from '../../src/lib/loreStockPolicy.js'

test('Exactly 30 queued unread articles is low stock; 31 is not',()=>{
 assert.equal(UNREAD_LOW_WATERMARK,30)
 assert.ok(QUEUE_TARGET>UNREAD_LOW_WATERMARK)
 assert.equal(queuedUnread(84,53),30)
 assert.equal(queuedUnread(84,52),31)
 assert.equal(lowOnStories(queuedUnread(84,53)),true)
 assert.equal(lowOnStories(queuedUnread(84,52)),false)
 assert.equal(queuedUnread(0,0),0)
})

test('Low-watermark crossing makes one immediate manifest probe, then 60s polling; otherwise 5m',()=>{
 const at=800000
 assert.equal(refreshDue({remaining:30,checkedAt:at-5000,now:at,justBecameLow:true}),true)
 assert.equal(refreshDue({remaining:30,checkedAt:at-5000,now:at}),false)
 assert.equal(refreshDue({remaining:30,checkedAt:at-LOW_STOCK_POLL_MS,now:at}),true)
 assert.equal(refreshDue({remaining:31,checkedAt:at-LOW_STOCK_POLL_MS,now:at}),false)
 assert.equal(refreshDue({remaining:31,checkedAt:at-NORMAL_POLL_MS,now:at}),true)
})

test('old news and pilot workflows are absent while Auto Wiki Publish stays server-side without exposing secrets in client code',async()=>{
 await assert.rejects(fs.access(new URL('../../.github/workflows/saga-discover-publish.yml',import.meta.url)))
 await assert.rejects(fs.access(new URL('../../.github/workflows/saga-wiki-pilot.yml',import.meta.url)))
 const wiki=await fs.readFile(new URL('../../.github/workflows/auto-wiki-publish.yml',import.meta.url),'utf8')
 const app=await fs.readFile(new URL('../../src/App.jsx',import.meta.url),'utf8')
 assert.match(wiki,/GEMINI_API_KEY/)
 assert.match(wiki,/SAGA_IMAGE_TEST_API_KEY/)
 assert.match(wiki,/node scripts\/publish_wiki_batch\.mjs/)
 assert.match(wiki,/ref:\s*main/)
 assert.ok(!/GITHUB_TOKEN|GH_PAT|SAGA_IMAGE_TEST_API_KEY|GEMINI_API_KEY/.test(app))
})
