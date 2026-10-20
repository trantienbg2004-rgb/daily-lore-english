import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import {CURATED_TOPICS,scheduledTopics} from '../lore/topics.mjs'
import {chooseTopics,keyFor,loadProgress,markDecision,saveProgress} from '../lore/state.mjs'
import {getJson,WikipediaRateLimitError} from '../lore/wiki.mjs'
import {collectLore} from '../lore-collect.mjs'

test('Curated catalogue has broad coverage; every item is explicitly labelled',()=>{
 assert.ok(CURATED_TOPICS.length>=650)
 assert.equal(new Set(CURATED_TOPICS.map(keyFor)).size,CURATED_TOPICS.length)
 for(const category of ['History','Culture','Society','Geography','Economics','Science','Civilizations','People & Ideas']){
  assert.ok(CURATED_TOPICS.filter(t=>t.category===category).length>=75,category)
 }
})
test('Progress rotates instead of restarting at first entry; skips known rejects temporarily',()=>{
 const topics=scheduledTopics({count:CURATED_TOPICS.length}),now=new Date('2026-10-14T12:00:00Z')
 const state={version:1,cursor:4,decisions:{}}
 markDecision(state,topics[5],{reason:'short-or-non-narrative'},now)
 const picked=chooseTopics(topics,state,new Set([keyFor(topics[4])]),now,4)
 assert.equal(picked.topics.length,4)
 assert.ok(!picked.topics.some(x=>keyFor(x)===keyFor(topics[5])))
 assert.ok(!picked.topics.some(x=>keyFor(x)===keyFor(topics[4])))
 assert.equal(keyFor(picked.topics[0]),keyFor(topics[6]))
 const afterThirtyOneDays=chooseTopics(topics,{cursor:5,decisions:state.decisions},new Set(),new Date('2026-11-15T12:00:00Z'),1)
 assert.equal(keyFor(afterThirtyOneDays.topics[0]),keyFor(topics[5]))
})
test('Progress is preserved and corrupt progress is rejected instead of silently reset',async()=>{
 const base=await fs.mkdtemp(path.join(os.tmpdir(),'lore-progress-'))
 try{
  const s=await loadProgress(base);s.cursor=37;markDecision(s,CURATED_TOPICS[0],{reason:'no-embedded-images'},new Date('2026-10-14'))
  await saveProgress(base,s)
  assert.deepEqual(await loadProgress(base),s)
  await fs.writeFile(path.join(base,'reports','DAILY_LORE_SOURCE_STATE.json'),'{bad json')
  await assert.rejects(loadProgress(base),/Invalid DAILY LORE progress state/)
 }finally{await fs.rm(base,{recursive:true,force:true})}
})
test('Wikimedia 429 stops repeated queries with defined backoff, not a fake successful response',async()=>{
 const requests=[],waits=[]
 const fetchImpl=async()=>{requests.push(1);return {ok:false,status:429,headers:{get:()=> '9'}}}
 await assert.rejects(getJson('https://en.wikipedia.org/w/api.php',{fetchImpl,attempts:3,waitImpl:async ms=>{waits.push(ms)}}),WikipediaRateLimitError)
 assert.equal(requests.length,3)
 assert.deepEqual(waits,[9000,16000])
})
test('On rate limit collector preserves its existing good release and saves retry position',async()=>{
 const base=await fs.mkdtemp(path.join(os.tmpdir(),'lore-429-'))
 try{
  const attempted=[]
  const collector=async topic=>{attempted.push(topic);const error=new WikipediaRateLimitError();throw error}
  await assert.rejects(collectLore({base,limit:100,collector,log:{log(){}}}),/Quality gate blocks release/)
  assert.equal(attempted.length,1)
  const state=await loadProgress(base)
  assert.equal(state.cursor,1)
  assert.equal(Object.keys(state.decisions).length,0)
  // Underfilled publications cannot be made to look ready.
  await assert.rejects(fs.access(path.join(base,'public/lore-reader/manifest.json')))
 }finally{await fs.rm(base,{recursive:true,force:true})}
})
