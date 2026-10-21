/** A bounded, resumable Wiki batch. The tracked state holds identifiers and
 * decisions, never scraped article text, generated drafts or API secrets. */
import fs from 'node:fs/promises'
import path from 'node:path'
import {discoverWikiCandidates,balanceWikiCandidates,WIKI_TOPICS} from './discovery.mjs'
import {fetchWikipediaPage,fetchWikipediaRevision,verifyPageFigures,WikiApiPause} from './source.mjs'
import {generateWikiDraft,GeminiWikiPause,selectWikiEvidence,repairTargets} from './editor.mjs'
import {assignWikipediaPhotos} from './media.mjs'
import {appendWikiStories,makeWikiStory,readWikiCatalog} from './catalog.mjs'

const fileFor=base=>path.join(base,'data','wiki-pipeline-state.json')
const checkpointFile=(base,pageId)=>path.join(base,'data','wiki-checkpoints',`${pageId}.json`)
const safeText=value=>String(value||'').replace(/[\r\n]+/g,' ').slice(0,140)
export async function readWikiCheckpoint(base,pageId){
 try{return JSON.parse(await fs.readFile(checkpointFile(base,pageId),'utf8'))}
 catch(error){if(error.code==='ENOENT')return null;throw error}
}
export async function writeWikiCheckpoint(base,checkpoint){
 if(!Number.isSafeInteger(checkpoint?.pageId))throw Error('Invalid checkpoint identity')
 const file=checkpointFile(base,checkpoint.pageId);await fs.mkdir(path.dirname(file),{recursive:true})
 const stage=file+'.tmp-'+process.pid
 await fs.writeFile(stage,JSON.stringify({...checkpoint,updatedAt:new Date().toISOString()},null,2)+'\n')
 await fs.rename(stage,file)
 return file
}
export async function writeWikiPending(base,{candidate,source,response,reason}){
 const dir=path.join(base,'reports','saga-wiki-local')
 await fs.mkdir(dir,{recursive:true})
 const file=path.join(dir,`${source.pageId}-${source.sourceRevisionId}.json`)
 const pending={pageId:source.pageId,revisionId:source.sourceRevisionId,sourceUrl:source.sourceRevisionUrl,
  topic:candidate.topic,reason:safeText(reason),draft:response.result,evidence:response.evidence,
  usage:response.usage,createdAt:new Date().toISOString()}
 await fs.writeFile(file,JSON.stringify(pending,null,2)+'\n',{flag:'wx'})
 return file
}
export async function readWikiState(base){
 try{
  const state=JSON.parse(await fs.readFile(fileFor(base),'utf8'))
  if(state.version!==1||!Array.isArray(state.queue)||typeof state.outcomes!=='object')throw Error('Invalid Wiki pipeline state')
  for(const candidate of state.queue)state.outcomes[candidate.pageId]??={status:'PENDING',reason:'queued',revisionId:candidate.revisionId||null,checkedAt:null}
  return state
 }catch(error){if(error.code==='ENOENT')return {version:1,queue:[],outcomes:{},updatedAt:null};throw error}
}
export async function writeWikiState(base,state){
 const file=fileFor(base);await fs.mkdir(path.dirname(file),{recursive:true})
 const stage=file+'.tmp-'+process.pid
 await fs.writeFile(stage,JSON.stringify({...state,updatedAt:new Date().toISOString()},null,2)+'\n')
 await fs.rename(stage,file)
}

export async function discoverWikiQueue({base,topics=WIKI_TOPICS,maxPerTopic=30,seedLimit=1,subcategoryLimit=1,
  maxCategoryPages=3,excludeQueued=false,
  discover=discoverWikiCandidates,readCatalog=readWikiCatalog,readState=readWikiState,writeState=writeWikiState}={}){
 const catalog=await readCatalog(base),state=await readState(base)
 const existingIds=new Set([...catalog.stories.map(story=>story.sourcePageId),
  ...(excludeQueued?state.queue.map(row=>row.pageId):[])])
 const counts=Object.fromEntries(WIKI_TOPICS.map(topic=>[topic,catalog.entries.filter(e=>e.category===topic).length]))
 const groups=[],errors=[]
 for(const topic of topics){
  try{groups.push(await discover({topic,maxCandidates:maxPerTopic,seedLimit,subcategoryLimit,maxCategoryPages,existingIds,topicCounts:counts}))}
  catch(error){if(error instanceof WikiApiPause)throw error;errors.push({topic,reason:safeText(error.message)})}
 }
 const fresh=balanceWikiCandidates(groups,{existingIds,topicCounts:counts,limit:Math.max(100,topics.length*maxPerTopic)})
 const queued=new Map(state.queue.map((item,index)=>[item.pageId,index]))
 for(const candidate of fresh){
  const prior=state.outcomes[candidate.pageId]
  if(['review','rejected'].includes(prior?.status)&&candidate.revisionId&&prior.revisionId&&
   candidate.revisionId!==prior.revisionId)delete state.outcomes[candidate.pageId]
  if(queued.has(candidate.pageId)){
   state.queue[queued.get(candidate.pageId)]={...state.queue[queued.get(candidate.pageId)],revisionId:candidate.revisionId}
   continue
  }
  if(state.outcomes[candidate.pageId]?.status==='rejected')continue
  queued.set(candidate.pageId,state.queue.length);state.queue.push(candidate)
 }
 const regrouped=WIKI_TOPICS.map(topic=>({topic,candidates:state.queue.filter(row=>row.topic===topic)}))
 state.queue=balanceWikiCandidates(regrouped,{topicCounts:counts,limit:state.queue.length})
 for(const candidate of state.queue)state.outcomes[candidate.pageId]??={status:'PENDING',reason:'queued',revisionId:candidate.revisionId||null,checkedAt:null}
 await writeState(base,state)
 return {candidates:state.queue.length,scanned:groups.reduce((n,g)=>n+g.scannedPages,0),errors,byTopic:Object.fromEntries(groups.map(g=>[g.topic,g.candidates.length]))}
}

const ACTIVE_QUEUE_STATUSES=new Set(['PENDING','FETCHED','EVIDENCE_READY','DRAFTED','VALIDATED','NEEDS_REPAIR','RETRY_LATER'])
export async function topUpWikiQueue({base,minPerTopic=8,maxTopics=3,now=new Date(),
 readState=readWikiState,writeState=writeWikiState,discoverQueue=discoverWikiQueue,onPersist=async()=>{}}={}){
 if(!base||!Number.isSafeInteger(minPerTopic)||minPerTopic<1||minPerTopic>30||
  !Number.isSafeInteger(maxTopics)||maxTopics<1||maxTopics>WIKI_TOPICS.length)throw Error('Unsafe Wiki discovery limits')
 const state=await readState(base),day=now.toISOString().slice(0,10),beforeLength=state.queue.length
 if(state.lastAutoDiscoveryDay===day)return {status:'already-checked',added:0}
 const available=Object.fromEntries(WIKI_TOPICS.map(topic=>[topic,state.queue.filter(row=>
  row.topic===topic&&ACTIVE_QUEUE_STATUSES.has(state.outcomes[row.pageId]?.status||'PENDING')).length]))
 const topics=WIKI_TOPICS.filter(topic=>available[topic]<minPerTopic).slice(0,maxTopics)
 if(!topics.length)return {status:'supply-ready',added:0,available}
 try{
  await discoverQueue({base,topics,excludeQueued:true,maxPerTopic:20,seedLimit:2,subcategoryLimit:1,maxCategoryPages:2})
  const updated=await readState(base)
  updated.lastAutoDiscoveryDay=day
  await writeState(base,updated)
  await onPersist()
  return {status:'refilled',topics,added:updated.queue.length-beforeLength}
 }catch(error){
  if(error instanceof WikiApiPause)return {status:'retry-later',topics,added:0,reason:safeText(error.message)}
  throw error
 }
}

export async function runWikiBatch({base,maxCalls=0,maxCandidates=5,pageId=null,apiKey='',freeTierConfirmed=false,model='gemini-3.5-flash-lite',
 readCatalog=readWikiCatalog,readState=readWikiState,writeState=writeWikiState,
 readCheckpoint=readWikiCheckpoint,writeCheckpoint=writeWikiCheckpoint,onPersist=async()=>{},
 fetchPage=fetchWikipediaPage,fetchRevision=fetchWikipediaRevision,verifyFigures=verifyPageFigures,generate=generateWikiDraft,
 assign=assignWikipediaPhotos,makeStory=makeWikiStory,append=appendWikiStories}={}){
 if(!base||!Number.isSafeInteger(maxCalls)||maxCalls<0||maxCalls>20||
  !Number.isSafeInteger(maxCandidates)||maxCandidates<1||maxCandidates>100)throw Error('Unsafe Wiki batch limits')
 if(maxCalls>0&&(!freeTierConfirmed||!apiKey))throw Error('Free-tier confirmation and key required before Gemini calls')
 const state=await readState(base),catalog=await readCatalog(base)
 const existingIds=new Set(catalog.stories.map(story=>story.sourcePageId))
 const usedUrls=new Set(catalog.stories.flatMap(story=>story.pages.map(page=>page.image).filter(Boolean)))
 const today=new Date().toISOString().slice(0,10)
 if(state.dailyUsage?.day!==today)state.dailyUsage={day:today,calls:0,tokens:0,usageUnknown:false,tokenAccountingUnavailable:false}
 const persistDurably=async()=>{try{await onPersist()}catch(error){error.checkpointFailure=true;throw error}}
 const initialTokens=state.dailyUsage.tokens
 const budget={maxCalls,usedCalls:0,dailyCalls:state.dailyUsage.calls,dailyTokens:initialTokens,
  tokenAccountingUnavailable:!!state.dailyUsage.tokenAccountingUnavailable,maxDailyCalls:100,maxTokens:250000,
  onRequest:async current=>{state.dailyUsage.calls=current.dailyCalls;await writeState(base,state);await persistDurably()},
  onUsage:async current=>{current.dailyTokens=initialTokens+current.usage.total;state.dailyUsage.tokens=current.dailyTokens;await writeState(base,state);await persistDurably()}}
 const stats={attempted:0,published:0,review:0,rejected:0,prepared:0,paused:false,apiCalls:0,usage:{input:0,output:0,total:0},decisions:[]}
 for(const candidate of state.queue.filter(row=>pageId===null||row.pageId===pageId)){
  if(stats.attempted>=maxCandidates)break
  const prior=state.outcomes[candidate.pageId]
  if(existingIds.has(candidate.pageId)){
   if(prior?.status!=='PUBLISHED'){
    state.outcomes[candidate.pageId]={status:'PUBLISHED',reason:'catalog already contains article',revisionId:prior?.revisionId||null,checkedAt:new Date().toISOString()}
    await writeState(base,state);await persistDurably()
   }
   continue
  }
  if(['published','PUBLISHED'].includes(prior?.status))continue
  if(['rejected','review','REJECTED','NEEDS_REVIEW'].includes(prior?.status))continue
  let checkpoint=await readCheckpoint(base,candidate.pageId)||{pageId:candidate.pageId,title:candidate.title,topic:candidate.topic,status:'PENDING'}
  const cachedValidation=checkpoint.status==='VALIDATED'&&checkpoint.validation?.accepted
  if(!cachedValidation&&(maxCalls===0||budget.circuitOpen||budget.tokenAccountingUnavailable||budget.maxCalls-budget.usedCalls<2)&&checkpoint.evidence&&checkpoint.rights)continue
  stats.attempted++
  const persist=async()=>{await writeCheckpoint(base,checkpoint);await writeState(base,state);await persistDurably()}
  const mark=async(status,reason,revisionId=checkpoint.revisionId||null)=>{
   checkpoint={...checkpoint,status,reason:safeText(reason),revisionId}
   state.dailyUsage.usageUnknown=state.dailyUsage.usageUnknown||!!budget.usageUnknown
   state.dailyUsage.tokenAccountingUnavailable=state.dailyUsage.tokenAccountingUnavailable||!!budget.tokenAccountingUnavailable
   state.outcomes[candidate.pageId]={status,reason:safeText(reason),revisionId,checkedAt:new Date().toISOString()}
   stats.decisions.push({pageId:candidate.pageId,status,reason:safeText(reason)})
   await persist()
  }
  try{
   const source=checkpoint.revisionId?await fetchRevision({pageId:candidate.pageId,title:candidate.title,revisionId:checkpoint.revisionId}):await fetchPage(candidate.title)
   if(source.pageId!==candidate.pageId){await mark('REJECTED','source-page-id-changed',source.sourceRevisionId);stats.rejected++;continue}
   if(!checkpoint.revisionId){checkpoint.revisionId=source.sourceRevisionId;checkpoint.sourceRevisionUrl=source.sourceRevisionUrl;await mark('FETCHED','pinned-source-ready')}
   if(source.wordCount<650||source.figures.length<1){await mark('REJECTED','insufficient-source-text-or-embedded-images');stats.rejected++;continue}
   const evidence=selectWikiEvidence(source)
   const rights=checkpoint.rights||await verifyFigures(source)
   const photos=rights.filter(row=>row.status==='REVIEW'&&row.photo&&!usedUrls.has(row.photo.url))
   if(!photos.length){await mark('NEEDS_REVIEW','no-rights-verified-embedded-image');stats.review++;continue}
   checkpoint.rights=rights
   checkpoint.evidence??=evidence.map(({id,hash,heading,text})=>({id,hash,heading,excerpt:text.slice(0,140),revisionUrl:source.sourceRevisionUrl}))
   await mark('EVIDENCE_READY',`${photos.length} rights-verified embedded images`);stats.prepared++
   if(maxCalls===0&&!cachedValidation)continue
   if(!cachedValidation&&(budget.circuitOpen||budget.tokenAccountingUnavailable||budget.maxCalls-budget.usedCalls<2)){
    await mark('RETRY_LATER',budget.tokenAccountingUnavailable?'Gemini token usage unavailable':budget.circuitOpen?'Gemini circuit open':'editorial call budget exhausted');stats.paused=true;continue
   }
   const response=cachedValidation
    ?{result:checkpoint.draft,validation:checkpoint.validation,evidence:checkpoint.evidence,usage:null}
    :await generate({source,topic:candidate.topic,apiKey,freeTierConfirmed,budget,model,
    draft:checkpoint.draft||null,repairAttempts:checkpoint.repairAttempts||0,savedEvidence:checkpoint.evidence,
    priorValidation:checkpoint.validation?.errors?.some(error=>error.includes(':audit-'))?checkpoint.validation:null,
    onDraft:async({result,repairAttempts,usage,evidence:currentEvidence})=>{
     checkpoint.draft=result;checkpoint.repairAttempts=repairAttempts;checkpoint.lastUsage=usage||null
     checkpoint.validation=null
     checkpoint.evidence=currentEvidence.map(({id,hash,heading,text})=>({id,hash,heading,excerpt:text.slice(0,140),revisionUrl:source.sourceRevisionUrl}))
     await mark('DRAFTED','draft durably saved before validation')
    }})
   if(response.usage&&!budget.usage)for(const key of ['input','output','total'])stats.usage[key]+=Number(response.usage[key]||0)
   // Injected generators in tests may return directly; still checkpoint their output.
   if(!checkpoint.draft){checkpoint.draft=response.result;checkpoint.repairAttempts=response.repairAttempts||0;await mark('DRAFTED','draft saved')}
   if(!response.validation.accepted){
    checkpoint.validation=response.validation
    const repairable=(checkpoint.repairAttempts||0)<2&&Object.keys(repairTargets(response.validation.errors)).length>0
    await mark(repairable?'NEEDS_REPAIR':'NEEDS_REVIEW','editorial: '+response.validation.errors.join(','))
    stats.review++;continue
   }
   checkpoint.validation=response.validation
   await mark('VALIDATED','local factual, style, length, structure and source audit passed')
   const selected=assign(rights,source,response.result.variants,{usedUrls})
   if(selected.status!=='VERIFIED'){await mark('NEEDS_REVIEW',selected.reason);stats.review++;continue}
   const story=makeStory({source,topic:candidate.topic,draft:{variants:selected.levelVariants},photos:selected.photos,evidence:response.evidence})
   await append(base,[story]);existingIds.add(source.pageId)
   for(const page of story.pages)if(page.image)usedUrls.add(page.image)
   await mark('PUBLISHED',`${selected.photos.length} verified embedded images`);stats.published++
  }catch(error){
   if(error.checkpointFailure)throw error
   if(error instanceof GeminiWikiPause){
    stats.paused=true
    if(error.status==='INVALID_JSON'){await mark('NEEDS_REVIEW',error.message);stats.review++}
    else {budget.circuitOpen=true;await mark('RETRY_LATER',error.message)}
    continue
   }
   if(error instanceof WikiApiPause){stats.paused=true;await mark('RETRY_LATER',error.message);break}
   await mark('NEEDS_REVIEW',error.message);stats.review++
  }
 }
 stats.apiCalls=budget.usedCalls
 state.dailyUsage.usageUnknown=state.dailyUsage.usageUnknown||!!budget.usageUnknown
 state.dailyUsage.tokenAccountingUnavailable=state.dailyUsage.tokenAccountingUnavailable||!!budget.tokenAccountingUnavailable
 if(budget.usageUnknown)stats.usage=null
 else if(budget.usage)stats.usage=budget.usage
 await writeState(base,state);await persistDurably()
 return stats
}
