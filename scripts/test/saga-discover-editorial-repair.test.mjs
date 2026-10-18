import test from 'node:test'
import assert from 'node:assert/strict'
import {generateThreeLevels,buildThreeLevelRequest,validateLevelDrafts,DISCOVER_LEVELS} from '../discover/geminiLevels.mjs'
import {collectDiscover,rankNewsCandidates,balanceNewsSources,selectNewsCandidates} from '../discover-collect.mjs'
import {licensedDraft,isJournalismStory} from '../discover/bridge.mjs'
import {extractArticle} from '../discover/article.mjs'
import {rightsDecision} from '../discover/rights.mjs'
import {source as rhinoceros} from '../discover/sources/rhinoceros.mjs'
import {source as horizon} from '../discover/sources/horizon.mjs'
import {SOURCES} from '../discover/sources/index.mjs'
import {isFocusedNews} from '../discover/newsFocus.mjs'
import {commonsQueryFor} from '../discover/commonsMedia.mjs'
import {runAutoNews} from '../auto-news.mjs'
import {sourceNewsHeadline} from '../discover/headline.mjs'

test('reviewed newsroom title shortenings remain source-backed and phone sized',()=>{
 const cases=[
  ['How two elections reshaped the India–Bangladesh border','Two elections reshaped India-Bangladesh border'],
  ['How Cambodia’s law on ‘freedom parks’ curtailed people’s right to protest','Cambodia law curtailed right to protest'],
  ['Indigenous plants offer Ghanaians an alternative to costly Western medicine','Plants offer Ghanaians a medicine alternative'],
  ['How Croatian communities are taking on planned poultry slaughterhouses','Croatian communities fight slaughterhouse plans'],
 ]
 for(const [title,expected] of cases)assert.equal(sourceNewsHeadline(title,title),expected)
})

test('push publication rotates batches and stops when Gemini quota is exhausted',async()=>{
 const batches=[],skipped=[]
 const results=await runAutoNews({apiKey:'fake',rounds:3,runNumber:10,log:{log(){},warn(){}},
  publish:async({candidateBatch,skipSourceUrls})=>{
   batches.push(candidateBatch);skipped.push([...skipSourceUrls]);return {published:true,attemptedSourceUrls:['url-'+batches.length],quotaExhausted:batches.length===2}
  }})
 assert.deepEqual(batches,[0,0])
 assert.deepEqual(skipped,[[],['url-1']])
 assert.equal(results.length,2)
 await assert.rejects(runAutoNews({apiKey:'fake',rounds:4,publish:async()=>({})}),/between 1 and 3/)
})

test('world politics and economy news are considered before lifestyle items',()=>{
 const day='2026-10-16T12:00:00Z'
 const rows=[{title:'A new local poetry book',publishedAt:day},{title:'Global trade summit reaches new agreement',publishedAt:day}]
 assert.equal(rankNewsCandidates(rows)[0].title,rows[1].title)
})

test('new verified newsroom receives an early attempt without blocking established feeds',()=>{
 const rows=[...Array.from({length:4},(_,i)=>({sourceId:'global-voices',sourceName:'Global Voices',id:'g'+i})),
  ...Array.from({length:2},(_,i)=>({sourceId:'rhinoceros',sourceName:'Rhinoceros Media',id:'r'+i}))]
 assert.deepEqual(balanceNewsSources(rows,[{publisher:'Global Voices'}]).map(x=>x.id),['r0','g0','r1','g1','g2','g3'])
})

test('within each newsroom, articles with multiple licensed original photos reach Gemini first',()=>{
 const rows=[{sourceId:'global-voices',sourceName:'Global Voices',id:'plain',title:'World economy report',publishedAt:'2026-10-18',verifiedPhotos:[]},
  {sourceId:'global-voices',sourceName:'Global Voices',id:'pictured',title:'World economy investigation',publishedAt:'2026-10-17',verifiedPhotos:[{},{}]}]
 assert.equal(selectNewsCandidates(rows,[],1)[0].id,'pictured')
})

test('selection reserves most Gemini candidates for another eligible newsroom across batches',()=>{
 const rows=[...Array.from({length:30},(_,i)=>({sourceId:'global-voices',sourceName:'Global Voices',id:'g'+i})),
  ...Array.from({length:8},(_,i)=>({sourceId:'rhinoceros',sourceName:'Rhinoceros Media',id:'r'+i}))]
 for(const batch of [0,1,19]){
  const selected=selectNewsCandidates(rows,[{publisher:'Global Voices'}],10,batch)
  assert.equal(selected.length,10)
  assert.equal(selected.filter(item=>item.sourceId==='rhinoceros').length,7)
  assert.equal(new Set(selected.map(item=>item.id)).size,10)
 }
 const draft={sourceId:'rhinoceros',sourceUrl:'https://rhinocerosmedia.org/lansing-tax-debt-dashboard',
  rights:{textAllowed:true,mode:'gemini-eligible',licenseUrl:'https://creativecommons.org/licenses/by/4.0/'}}
 assert.equal(licensedDraft(draft),true)
 assert.equal(isJournalismStory(draft),true)
})

test('Rhinoceros text requires a CC BY notice on the individual article',()=>{
 const body='<article>'+Array.from({length:12},(_,i)=>`<p>Local reporters checked public records and interviewed residents about decision ${i} affecting their neighborhood, city government, and taxes this month.</p>`).join('')+'</article>'
 const licensed=extractArticle('<meta name="author" content="Rhinoceros Newsroom">'+body+'<p>Free to republish and remix under <a href="https://creativecommons.org/licenses/by/4.0/">CC BY 4.0</a></p>','rhinoceros')
 assert.equal(rightsDecision(rhinoceros,licensed).textAllowed,true)
 assert.equal(rightsDecision(rhinoceros,extractArticle(body,'rhinoceros')).textAllowed,false)
 assert.equal(commonsQueryFor('Lansing city government election'),'Lansing')
})

test('stale VOA feeds are inactive and local Michigan articles cannot enter the new queue',()=>{
 assert.equal(SOURCES.some(source=>source.id==='voa'),false)
 assert.equal(isFocusedNews({sourceId:'rhinoceros',title:'Lansing City Council Meeting: October 12, 2026'}),false)
 assert.equal(isFocusedNews({sourceId:'rhinoceros',title:'BWL data centers in Michigan'}),false)
 assert.equal(isFocusedNews({sourceId:'global-voices',title:'International trade sanctions reshape Asian markets'}),true)
 assert.equal(isFocusedNews({sourceId:'global-voices',title:'New poetry collection celebrates a local artist'}),false)
})

test('Horizon article needs its own republish control and named journalist',()=>{
 const body='<article>'+Array.from({length:12},(_,i)=>`<p>European researchers explain how bioeconomy investments affect industry and supply chains across the continent in report ${i}, with public evidence and context.</p>`).join('')+'</article>'
 const byline='<span class="article--author_name uppercase">Anthony King</span>'
 const republish='<a href="/en/article/modal/15311" class="use-ajax republish">Republish</a>'
 const article=extractArticle(republish+byline+body,'horizon')
 assert.equal(article.author,'Anthony King')
 assert.equal(rightsDecision(horizon,article).textAllowed,true)
 assert.equal(rightsDecision(horizon,extractArticle(byline+body,'horizon')).textAllowed,false)
 assert.equal(rightsDecision(horizon,extractArticle(republish+body,'horizon')).textAllowed,false)
})

const quote='Researchers invited families to study the new science report in local schools.'
const note='They explained the evidence from community meetings, and shared what the study could show to people who were interested in the findings.'
const source={title:'Science in local schools',sourceName:'Global Voices',sourceUrl:'https://globalvoices.org/2026/10/16/local-schools/',publishedAt:'2026-10-16T00:00:00Z',text:Array(15).fill(quote+' '+note).join(' '),rights:{textAllowed:true,mode:'gemini-eligible'}}
const words='Families and researchers talked about science in their schools. They discussed what the local report meant for people in their community. The researchers explained the evidence and described what the current study could show. The families also talked about how scientific ideas can be presented to students.'
const paragraphs=Array(5).fill(words)
const valid=()=>({headline:'Science report from local schools',variants:DISCOVER_LEVELS.map((level,i)=>({level,headline:['Science helps people in local schools','Local schools discuss science findings','Science inquiry reframes local schools'][i],paragraphs:[...paragraphs.slice(0,4),paragraphs[4]+' '+['These ideas can help people learn from each other.','Their discussion provided a useful context for reading the evidence.','The discussion provided a more nuanced account of the scientific findings.'][i]],keyVocabulary:[{word:'science',meaningVi:'khoa học'},{word:'school',meaningVi:'trường học'},{word:'research',meaningVi:'nghiên cứu'}],evidence:[quote,quote,quote]}))})
const collectorValid=()=>({...valid(),headline:'Community research report',variants:valid().variants.map((variant,i)=>({...variant,headline:['Community research report helps families','Climate community research report explained','Community research report informs climate debate'][i]}))})
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

test('a rejected headline is repaired without throwing away three valid levels',async()=>{
 let calls=0,requests=[]
 const first={...valid(),headline:'A very long and unsupported headline about unrelated discoveries elsewhere'}
 const result=await generateThreeLevels({source,apiKey:'fake',fetchImpl:async(_url,options)=>{
  calls++;requests.push(JSON.parse(options.body));return fakeRes(calls===1?first:{headline:'Science report from local schools'})
 }})
 assert.equal(calls,2)
 assert.equal(result.headline,'Science report from local schools')
 assert.equal(result.requestCount,2)
 assert.equal(Object.keys(result.levelVariants).length,3)
 assert.ok(requests[0].contents[0].parts[0].text.includes('sourceEvidenceSpans'))
 assert.deepEqual(Object.keys(requests[1].generationConfig.responseSchema.properties),['headline'])
})

test('an unrepairable headline does not regenerate valid reading levels',async()=>{
 let calls=0
 await assert.rejects(generateThreeLevels({source,apiKey:'fake',fetchImpl:async()=>{
  calls++
  return fakeRes(calls===1?{...valid(),headline:'An unrelated and unsupported display title'}:{headline:'Another unrelated title'})
 }}),/editorial validation failed after 2 request\(s\): Headline is too long or unsupported by source/)
 assert.equal(calls,2)
})

test('a short publisher clause avoids a second AI call for the headline',async()=>{
 const titledSource={...source,title:'Science report reaches local schools, but teachers seek more details'}
 let calls=0
 const result=await generateThreeLevels({source:titledSource,apiKey:'fake',fetchImpl:async()=>{
  calls++;return fakeRes({...valid(),headline:'An unrelated and unsupported display title'})
 }})
 assert.equal(result.headline,'Science report reaches local schools')
 assert.equal(result.requestCount,1)
 assert.equal(calls,1)
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

test('persistent 503 switches to the free fallback model within the call budget',async()=>{
 const urls=[]
 const result=await generateThreeLevels({source,apiKey:'fake',fetchImpl:async url=>{
  urls.push(url)
  return urls.length<=3?{ok:false,status:503,headers:{get:()=>null}}:fakeRes(valid())
 },waitImpl:async()=>{}})
 assert.equal(urls.length,4)
 assert.ok(urls.slice(0,3).every(url=>url.includes('/gemini-2.5-flash:')))
 assert.match(urls[3],/gemini-2\.5-flash-lite:/)
 assert.equal(result.model,'gemini-2.5-flash-lite')
})

test('temporary network failure retries once before accepting a valid draft',async()=>{
 let calls=0
 const result=await generateThreeLevels({source,apiKey:'fake',fetchImpl:async()=>{
  calls++
  if(calls===1)throw new TypeError('temporary fetch failure')
  return fakeRes(valid())
 },waitImpl:async()=>{}})
 assert.equal(calls,2)
 assert.equal(result.requestCount,2)
})

test('one invalid news article moves to next eligible article and stops after a good three-level draft',async()=>{
 const publishers=[{id:'voa',name:'VOA Learning English',feedUrls:['https://learningenglish.voanews.com/feed/'],hosts:['learningenglish.voanews.com'],fetchFullText:true,policyUrl:'https://learningenglish.voanews.com/p/6861.html'}]
 const urls=['https://learningenglish.voanews.com/a/first/','https://learningenglish.voanews.com/a/second/','https://learningenglish.voanews.com/a/third/']
 const feed='<rss version="2.0"><channel>'+urls.map((u,i)=>`<item><title>Climate community research report ${['Alpha','Beta','Gamma'][i]}</title><link>${u}</link><pubDate>Fri, 16 Oct 2026 12:00:00 GMT</pubDate></item>`).join('')+'</channel></rss>'
 const html=u=>'<html><body><article><figure><img src="'+u+'climate-community.jpg" alt="Climate community research report" width="800" height="500"><figcaption>Photo by Mira, <a href="https://creativecommons.org/licenses/by/4.0/">CC BY 4.0</a></figcaption></figure>'+Array.from({length:16},(_,i)=>'<p>'+quote+' '+note+' The discussion included a different classroom activity called lesson'+i+'.</p>').join('')+'</article></body></html>'
 const fetchImpl=async u=>({ok:true,status:200,url:u,headers:{get:()=>u.includes('/feed/')?'application/rss+xml':'text/html'},text:async()=>u.includes('/feed/')?feed:html(u)})
 let aiCalls=0
 const failed=valid();failed.variants[0].paragraphs[0]+=' It involved 999999 students.'
 const r=await collectDiscover({sources:publishers,fetchImpl,geminiFetchImpl:async()=>{aiCalls++;return fakeRes(aiCalls<=2?failed:collectorValid())},now:new Date('2026-10-17T00:00:00Z'),apiKey:'fake',useGemini:true,maxGemini:3,targetDrafts:1,writeFiles:false,log:{log(){}}})
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
 const unavailable=await collectDiscover({sources:publishers,fetchImpl,
  geminiFetchImpl:async()=>{aiCalls++;return aiCalls<=6?{ok:false,status:503,headers:{get:()=>null}}:fakeRes(collectorValid())},
  now:new Date('2026-10-17T00:00:00Z'),apiKey:'fake',useGemini:true,maxGemini:3,maxGeminiCalls:8,targetDrafts:1,
  geminiIntervalMs:0,geminiWaitImpl:async()=>{},writeFiles:false,log:{log(){}}})
 assert.equal(unavailable.report.geminiCalls,7)
 assert.equal(unavailable.report.geminiCandidateAttempts,2)
 assert.equal(unavailable.report.quotaExhausted,false)
 assert.equal(unavailable.report.drafts,1)
 assert.equal(unavailable.report.sourceStatus.find(x=>x.statusCode===503)?.errorStatus,'UNAVAILABLE')
 aiCalls=0
 const capped=await collectDiscover({sources:publishers,fetchImpl,geminiFetchImpl:async()=>{aiCalls++;return fakeRes(failed)},
  now:new Date('2026-10-17T00:00:00Z'),apiKey:'fake',useGemini:true,maxGemini:3,maxGeminiCalls:2,targetDrafts:2,
  geminiIntervalMs:0,writeFiles:false,log:{log(){}}})
 assert.equal(aiCalls,2)
 assert.equal(capped.report.geminiCalls,2)
 assert.equal(capped.report.geminiCandidateAttempts,1)
 assert.equal(capped.drafts.length,0)
 assert.equal(capped.report.quotaExhausted,false)
 const rotated=await collectDiscover({sources:publishers,fetchImpl,geminiFetchImpl:async()=>fakeRes(collectorValid()),
  now:new Date('2026-10-17T00:00:00Z'),apiKey:'fake',useGemini:true,maxGemini:1,candidateBatch:1,targetDrafts:1,
  geminiIntervalMs:0,writeFiles:false,log:{log(){}}})
 assert.equal(rotated.report.candidateBatch,1)
 assert.equal(rotated.drafts[0]?.sourceUrl,urls[1].replace(/\/$/,''))
 let commonsCalls=0
 const noPhotoFetch=async url=>{if(String(url).includes('commons.wikimedia.org')){commonsCalls++;return {ok:true,json:async()=>({query:{pages:{}}})}}const response=await fetchImpl(url);return String(url).includes('/feed/')?response:{...response,text:async()=>html(url).replace(/<figure>[\s\S]*?<\/figure>/,'')}}
 let wastedGeminiCalls=0
 const noPhoto=await collectDiscover({sources:publishers,fetchImpl:noPhotoFetch,
  geminiFetchImpl:async()=>{wastedGeminiCalls++;return fakeRes(collectorValid())},
  now:new Date('2026-10-17T00:00:00Z'),apiKey:'fake',useGemini:true,maxGemini:1,targetDrafts:1,
  geminiIntervalMs:0,writeFiles:false,log:{log(){}}})
 assert.equal(noPhoto.drafts.length,0)
 assert.equal(noPhoto.report.awaitingVerifiedLeadPhoto,3)
 assert.equal(noPhoto.report.geminiCalls,0)
 assert.equal(wastedGeminiCalls,0)
 assert.equal(commonsCalls,0)
})
