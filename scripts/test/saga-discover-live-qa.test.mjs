import test from 'node:test'
import assert from 'node:assert/strict'
import {inspectStagedRelease,formatSummary} from '../discover-live-qa.mjs'
const para='Community researchers shared clear information with local teachers and families while collecting careful observations from residents during a public education project. They explained the results in simple language and encouraged everyone to ask questions before making decisions.'
const pages=()=>Array.from({length:5},(_,i)=>({text:(para+' '+(i?'People discussed what the information meant for their daily lives.':'Students asked questions and checked the main findings together.')),image:'',caption:''}))
const variant=()=>({pages:pages(),keyVocabulary:[{word:'community',meaningVi:'cộng đồng'},{word:'researcher',meaningVi:'nhà nghiên cứu'},{word:'observation',meaningVi:'quan sát'}],evidence:['Community researchers shared clear information with local teachers','People discussed what the information meant for their daily lives','Students asked questions and checked the main findings together'],wordCount:180})
const report=()=>({mode:'gemini-staging',publishEnabled:false,publicFilesChanged:false,completeThreeLevelDrafts:1,sourceCount:5,candidates:9,eligible:1,geminiCalls:1,rejected:{},sourceStatus:[{source:'voa',feedItems:4,errors:[]}]})
const draft=()=>({id:'news-1',sourceId:'voa',sourceName:'VOA Learning English',title:'A community education project',sourceUrl:'https://learningenglish.voanews.com/a/example',rights:{textAllowed:true,mode:'gemini-eligible'},imageUrl:'',levelVariants:{'A1-A2':variant(),'B1-B2':variant(),'C1-C2':variant()}})
function valid(){const d=draft();for(const [i,l] of ['A1-A2','B1-B2','C1-C2'].entries())d.levelVariants[l].pages[0].text+=' '.repeat(1)+['Easy reading.','Intermediate reading.','Advanced reading.'][i];return d}
test('a complete rights-eligible three-level story passes without publishing',()=>{
 const r=inspectStagedRelease(report(),[valid()]);assert.equal(r.status,'PASS');assert.equal(r.drafts,1)
 assert.match(formatSummary(r),/No publication/)
})
test('empty real output is blocked instead of silently calling it successful',()=>{
 const r=inspectStagedRelease({...report(),completeThreeLevelDrafts:0},[]);assert.equal(r.status,'BLOCKED');assert.match(r.issues.join(' '),/No complete/)
})
test('missing or duplicate CEFR band is blocked',()=>{
 const d=valid();delete d.levelVariants['C1-C2'];assert.equal(inspectStagedRelease(report(),[d]).status,'BLOCKED')
})
test('image with no independently verified license is blocked',()=>{
 const d=valid();d.levelVariants['B1-B2'].pages[0].image='https://example.com/photo.jpg';assert.equal(inspectStagedRelease(report(),[d]).status,'BLOCKED')
})
test('metadata-only or restricted content is blocked',()=>{
 const d=valid();d.rights={textAllowed:false,mode:'discovery-only'};assert.equal(inspectStagedRelease(report(),[d]).status,'BLOCKED')
})
test('reader contract detects malformed page and incomplete source',()=>{
 const d=valid();d.levelVariants['A1-A2'].pages[0].text='Hi.';assert.equal(inspectStagedRelease(report(),[d]).status,'BLOCKED')
})
test('staging cannot be confused with public publishing',()=>{
 const r=inspectStagedRelease({...report(),publicFilesChanged:true},[valid()]);assert.equal(r.status,'BLOCKED')
})
