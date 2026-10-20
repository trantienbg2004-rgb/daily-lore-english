import test from 'node:test'
import assert from 'node:assert/strict'
import {selectWikiEvidence,validateWikiDraft,callFreeWikiGemini,GeminiWikiPause} from '../wiki/editor.mjs'

const source={pageId:42,sourceTitle:'Silk Road',sourceRevisionId:99,paragraphDetails:Array.from({length:9},(_,i)=>({
 heading:i<3?'Trade routes':`Period ${i}`,
 text:Array.from({length:6},(_,n)=>`Merchants carried silk and ideas through connected Asian trading cities during the historical period ${i+n}.`).join(' ')
}))}
const evidence=selectWikiEvidence(source)
const sentence='Merchants connected distant Asian cities and traded silk along routes that helped ideas travel between communities.'
const page=(_,index)=>({text:Array.from({length:index===0?3:4},()=>sentence).join(' '),evidenceIds:[evidence[0].id]})
const draft={variants:Object.fromEntries(['A1-A2','B1-B2','C1-C2'].map((level,i)=>[level,{headline:[
 'Silk Roads Linked Distant Cities','How the Silk Road Connected Asian Trade','Silk Road Networks Reshaped Eurasian Exchange'][i],pages:Array.from({length:5},page)}]))}

test('one prompt can retain source IDs for three distinct 5-page versions',()=>{
 assert.ok(evidence.length>=5)
 const checked=validateWikiDraft(draft,{source,topic:'Economy',evidence})
 assert.deepEqual(checked.errors,[])
 assert.equal(checked.accepted,true)
})

test('fabricated numbers and missing evidence fail without an API call',()=>{
 const wrong=structuredClone(draft)
 wrong.variants['B1-B2'].pages[2].text+=' An unsupported report counted 999999 events.'
 wrong.variants['C1-C2'].pages[1].evidenceIds=['P999']
 const checked=validateWikiDraft(wrong,{source,topic:'Economy',evidence})
 assert.equal(checked.accepted,false)
 assert.ok(checked.errors.some(reason=>reason.includes('unsupported-number-999999')))
 assert.ok(checked.errors.some(reason=>reason.includes('evidence-id')))
})

test('free-tier gate, 503 and spent budget stop after at most one request',async()=>{
 let calls=0
 const budget={maxCalls:1,usedCalls:0}
 await assert.rejects(callFreeWikiGemini('prompt',{apiKey:'test-key',budget,fetchImpl:async()=>{calls++;return {ok:true}}}),GeminiWikiPause)
 assert.equal(calls,0)
 await assert.rejects(callFreeWikiGemini('prompt',{apiKey:'test-key',freeTierConfirmed:true,budget,
  fetchImpl:async()=>{calls++;return {status:503,ok:false}}}),GeminiWikiPause)
 assert.equal(calls,1);assert.equal(budget.usedCalls,1)
 await assert.rejects(callFreeWikiGemini('prompt',{apiKey:'test-key',freeTierConfirmed:true,budget,
  fetchImpl:async()=>{calls++;return {status:200,ok:true}}}),/budget exhausted/)
 assert.equal(calls,1)
})
