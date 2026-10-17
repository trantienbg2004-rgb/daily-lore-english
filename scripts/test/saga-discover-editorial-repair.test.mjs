import test from 'node:test'
import assert from 'node:assert/strict'
import {generateThreeLevels,buildThreeLevelRequest,validateLevelDrafts,DISCOVER_LEVELS} from '../discover/geminiLevels.mjs'
import {collectDiscover,rankNewsCandidates} from '../discover-collect.mjs'

test('world politics and economy news are considered before lifestyle items',()=>{
 const day='2026-10-16T12:00:00Z'
 const rows=[{title:'A new local poetry book',publishedAt:day},{title:'Global trade summit reaches new agreement',publishedAt:day}]
 assert.equal(rankNewsCandidates(rows)[0].title,rows[1].title)
})

const quote='Researchers invited families to study the new science report in local schools.'
const note='They explained the evidence from community meetings, and shared what the study could show to people who were interested in the findings.'
const source={title:'Science in local schools',sourceName:'Global Voices',sourceUrl:'https://globalvoices.org/2026/10/16/local-schools/',publishedAt:'2026-10-16T00:00:00Z',text:Array(15).fill(quote+' '+note).join(' '),rights:{textAllowed:true,mode:'gemini-eligible'}}
const words='Families and researchers talked about science in their schools. They discussed what the local report meant for people in their community. The researchers explained the evidence and described what the current study could show. The families also talked about how scientific ideas can be presented to students.'
const paragraphs=Array(5).fill(words)
const valid=()=>({variants:DISCOVER_LEVELS.map((level,i)=>({level,paragraphs:[...paragraphs.slice(0,4),paragraphs[4]+' '+['These ideas can help people learn from each other.','Their discussion provided a useful context for reading the evidence.','The discussion provided a more nuanced account of the scientific findings.'][i]],keyVocabulary:[{word:'science',meaningVi:'khoa học'},{word:'school',meaningVi:'trường học'},{word:'research',meaningVi:'nghiên cứu'}],evidence:[quote,quote,quote]}))})
const fakeRes=data=>({ok:true,status:200,json:async()=>({candidates:[{content:{parts:[{text:JSON.stringify(data)}]}}],usageMetadata:{totalTokenCount:777}})})

test('numeric claim is rejected, even if the number occurs only in a publication date',()=>{
 const v=valid();v.variants[1].paragraphs[1]+=' The survey reached 987654 families.'
 assert.throws(()=>validateLevelDrafts(v,source),/Unverified numeric fact: B1-B2/)
})

test('Gemini regenerates a rejected draft once, checking all three levels again',async()=>{
 const bad=valid();bad.variants[1].paragraphs[2]+=' The survey reached 987654 families.'
 let calls=0;const requests=[]
 const result=await generateThreeLevels({source,apiKey:'fake',fetchImpl:async(_u,opts)=>{calls++;requests.push(JSON.parse(opts.body));return fakeRes(calls===1?bad:valid())},waitImpl:async()=>{}})
 assert.equal(calls,2)
 assert.equal(result.requestCount,2)
 assert.equal(result.editorialRepaired,true)
 assert.equal(Object.keys(result.levelVariants).length,3)
 assert.match(requests[1].contents[0].parts[0].text,/Unverified numeric fact: B1-B2/)
 assert.match(requests[1].contents[0].parts[0].text,/allowedNumerals/)
 assert.ok(!JSON.stringify(result.levelVariants).includes('987654'))
})

test('persistent hallucinated numbers never escape the quality gate; bounded requests',async()=>{
 const bad=valid();bad.variants[2].paragraphs[0]+=' The count increased to 987654.'
 let calls=0
 await assert.rejects(generateThreeLevels({source,apiKey:'fake',fetchImpl:async()=>{calls++;return fakeRes(bad)}}),/editorial validation failed after 2 request\(s\): Unverified numeric fact: C1-C2/)
 assert.equal(calls,2)
})

test('HTTP 401/403 is never mistaken for an editorial problem and never regenerated',async()=>{
 let calls=0
 await assert.rejects(generateThreeLevels({source,apiKey:'fake',fetchImpl:async()=>{calls++;return {ok:false,status:403}}}),/HTTP 403/)
 assert.equal(calls,1)
})

test('rate limit waits/retries only the API error, not an editorial regeneration',async()=>{
 let calls=0,waits=[]
 const r=await generateThreeLevels({source,apiKey:'fake',fetchImpl:async()=>{calls++;return calls===1?{ok:false,status:429,headers:{get:()=> '0'}}:fakeRes(valid())},waitImpl:async ms=>{waits.push(ms)}})
 assert.equal(calls,2)
 assert.deepEqual(waits,[3000])
 assert.equal(r.editorialRepaired,false)
})

test('one invalid news article moves to next eligible article and stops after a good three-level draft',async()=>{
 const publishers=[{id:'voa',name:'VOA Learning English',feedUrls:['https://learningenglish.voanews.com/feed/'],hosts:['learningenglish.voanews.com'],fetchFullText:true,policyUrl:'https://learningenglish.voanews.com/p/6861.html'}]
 const urls=['https://learningenglish.voanews.com/a/first/','https://learningenglish.voanews.com/a/second/','https://learningenglish.voanews.com/a/third/']
 const feed='<rss version="2.0"><channel>'+urls.map((u,i)=>`<item><title>Community research report ${['Alpha','Beta','Gamma'][i]}</title><link>${u}</link><pubDate>Fri, 16 Oct 2026 12:00:00 GMT</pubDate></item>`).join('')+'</channel></rss>'
 const html='<html><body><article>'+Array.from({length:16},(_,i)=>'<p>'+quote+' '+note+' The discussion included a different classroom activity called lesson'+i+'.</p>').join('')+'</article></body></html>'
 const fetchImpl=async u=>({ok:true,status:200,url:u,headers:{get:()=>u.includes('/feed/')?'application/rss+xml':'text/html'},text:async()=>u.includes('/feed/')?feed:html})
 let aiCalls=0
 const failed=valid();failed.variants[0].paragraphs[0]+=' It involved 999999 students.'
 const r=await collectDiscover({sources:publishers,fetchImpl,geminiFetchImpl:async()=>{aiCalls++;return fakeRes(aiCalls<=2?failed:valid())},now:new Date('2026-10-17T00:00:00Z'),apiKey:'fake',useGemini:true,maxGemini:3,targetDrafts:1,writeFiles:false,log:{log(){}}})
 assert.equal(r.report.candidates,3)
 assert.equal(r.report.eligible,3)
 assert.equal(r.report.geminiCandidateAttempts,2)
 assert.equal(r.report.geminiCalls,3)
 assert.equal(r.report.completeThreeLevelDrafts,1)
 assert.equal(r.drafts.length,1)
 assert.equal(aiCalls,3)
 assert.equal(r.report.rejected['gemini-rejected'],1)
 assert.equal(r.report.publishEnabled,false)
 assert.equal(r.report.publicFilesChanged,false)
 aiCalls=0
 const capped=await collectDiscover({sources:publishers,fetchImpl,geminiFetchImpl:async()=>{aiCalls++;return fakeRes(failed)},
  now:new Date('2026-10-17T00:00:00Z'),apiKey:'fake',useGemini:true,maxGemini:3,maxGeminiCalls:2,targetDrafts:2,
  geminiIntervalMs:0,writeFiles:false,log:{log(){}}})
 assert.equal(aiCalls,2)
 assert.equal(capped.report.geminiCalls,2)
 assert.equal(capped.report.geminiCandidateAttempts,1)
 assert.equal(capped.drafts.length,0)
})
