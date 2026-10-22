import test from 'node:test'
import assert from 'node:assert/strict'
import {selectAvailableWikiModel} from '../wiki/model-availability.mjs'

const response=(models,status=200)=>({ok:status===200,status,json:async()=>({models})})
const model=name=>({name:`models/${name}`,supportedGenerationMethods:['generateContent']})

test('prefers higher-capacity listed free Lite model and excludes 2.5 after generation 404',async()=>{
 let url,options
 const selected=await selectAvailableWikiModel({apiKey:'test-key',fetchImpl:async(u,o)=>{
  url=u;options=o;return response([model('gemini-2.5-flash-lite'),model('gemini-3.6-flash'),
   model('gemini-3.8-flash'),model('gemini-3.1-flash-lite'),model('gemini-3.5-flash-lite')])
 }})
 assert.equal(selected.model,'gemini-3.5-flash-lite')
 assert.deepEqual(selected.models,['gemini-3.5-flash-lite','gemini-3.1-flash-lite','gemini-3.8-flash','gemini-3.6-flash'])
 assert.equal(selected.available,true)
 assert.match(url,/\/models\?pageSize=1000$/)
 assert.equal(options.method,undefined)
})

test('uses only an approved available fallback',async()=>{
 const selected=await selectAvailableWikiModel({apiKey:'test-key',fetchImpl:async()=>response([
  model('gemini-3.5-flash-lite'),model('gemini-3.5-flash')])})
 assert.equal(selected.model,'gemini-3.5-flash-lite')
 assert.deepEqual(selected.models,['gemini-3.5-flash-lite'])
})

test('pauses AI work when model access cannot be confirmed',async()=>{
 for(const fetchImpl of [async()=>response([model('gemini-3.5-flash')]),async()=>response([],403),
  async()=>{throw Error('offline')}]){
  const selected=await selectAvailableWikiModel({apiKey:'test-key',fetchImpl})
  assert.equal(selected.available,false)
  assert.equal(selected.model,null)
  assert.deepEqual(selected.models,[])
 }
})
