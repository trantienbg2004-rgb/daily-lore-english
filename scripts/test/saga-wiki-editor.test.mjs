import test from 'node:test'
import assert from 'node:assert/strict'
import {selectWikiEvidence,wikiStoryPrompt,validateWikiDraft,validateWikiAudit,generateWikiDraft,
 callFreeWikiGemini,GeminiWikiPause} from '../wiki/editor.mjs'

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

test('a late source caveat survives the evidence budget and the prompt preserves uncertainty',()=>{
 const rows=Array.from({length:24},(_,i)=>({heading:`Section ${i}`,
  text:Array.from({length:12},()=>`Researchers described the ancient device and its surviving bronze gears in section ${i}.`).join(' ')}))
 rows[23].text='There is debate as to whether the device displayed the positions of all planets. No complete planetary gearing survives, so proposed displays remain hypothetical reconstructions.'
 const example={...source,paragraphDetails:rows}
 const picked=selectWikiEvidence(example)
 assert.ok(picked.some(row=>row.text.includes('There is debate as to whether')))
 assert.match(wikiStoryPrompt(example,'Science & Technology',picked),/must remain proposed or debated in EVERY level/)
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
 assert.equal(budget.usageUnknown,true)
 await assert.rejects(callFreeWikiGemini('prompt',{apiKey:'test-key',freeTierConfirmed:true,budget,
  fetchImpl:async()=>{calls++;return {status:200,ok:true}}}),/budget exhausted/)
 assert.equal(calls,1)
 const networkBudget={maxCalls:1,usedCalls:0}
 await assert.rejects(callFreeWikiGemini('prompt',{apiKey:'test-key',freeTierConfirmed:true,
  budget:networkBudget,fetchImpl:async()=>{throw Error('offline')}}),GeminiWikiPause)
 assert.equal(networkBudget.usageUnknown,true)
})

test('successive free-tier editorial requests respect the per-minute spacing',async()=>{
 let time=10000,calls=0,waited=0
 const budget={maxCalls:2,usedCalls:0}
 const options={apiKey:'test-key',freeTierConfirmed:true,budget,now:()=>time,
  waitImpl:async ms=>{waited+=ms;time+=ms},fetchImpl:async()=>{calls++;return {ok:true,status:200,
   json:async()=>({candidates:[{content:{parts:[{text:'{}'}]}}]})}}}
 await callFreeWikiGemini('first',options)
 await callFreeWikiGemini('second',options)
 assert.equal(calls,2);assert.equal(waited,5000)
})

test('editorial audit rejects unsupported claims and malformed reviews',()=>{
 assert.equal(validateWikiAudit({accepted:true,issues:[]}).accepted,true)
 assert.equal(validateWikiAudit({accepted:false,issues:[{level:'C1-C2',page:4,
  reason:'The simulation result is attributed to the original device'}]}).accepted,false)
 assert.throws(()=>validateWikiAudit({accepted:true,issues:'none'}),GeminiWikiPause)
})

test('a structurally valid story still fails when the separate source audit finds an unsupported claim',async()=>{
 let calls=0
 const result=await generateWikiDraft({source,topic:'Economy',apiKey:'test-key',freeTierConfirmed:true,
  budget:{maxCalls:2,usedCalls:0},waitImpl:async()=>{},now:()=>10000,
  fetchImpl:async()=>{
   calls++
   const body=calls===1?draft:{accepted:false,issues:[{level:'B1-B2',page:2,
    reason:'The named trade agreement is absent from the cited passage'}]}
   return {ok:true,status:200,json:async()=>({candidates:[{content:{parts:[{text:JSON.stringify(body)}]}}],
    usageMetadata:{promptTokenCount:100,candidatesTokenCount:50,totalTokenCount:150}})}
  }})
 assert.equal(calls,2)
 assert.equal(result.validation.accepted,false)
 assert.match(result.validation.errors[0],/audit/)
 assert.equal(result.usage.total,300)
})
