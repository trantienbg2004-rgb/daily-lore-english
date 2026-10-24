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
const TERMINAL_QUEUE_STATUSES=new Set(['published','PUBLISHED','rejected','REJECTED','review','NEEDS_REVIEW'])
const retryableTechnicalReview=outcome=>outcome?.status==='NEEDS_REVIEW'&&
 ['no-verified-lead-photo','no-verified-photo-placement','license-url-canonicalization-needed',
  'Targeted repair changed an unrelated sentence'].includes(outcome.reason)
const MODEL_503_COOLDOWN_MS=6*60*60*1000
const coolingAfterModel503=(outcome,now)=>{
 if(outcome?.status!=='RETRY_LATER'||!/^Gemini HTTP 503\b/.test(outcome.reason||''))return false
 const elapsed=now-Date.parse(outcome.checkedAt)
 return Number.isFinite(elapsed)&&elapsed>=0&&elapsed<MODEL_503_COOLDOWN_MS
}
export const wikiQuotaDay=(date=new Date())=>{
 const parts=new Intl.DateTimeFormat('en-US',{timeZone:'America/Los_Angeles',year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(date)
 const value=type=>parts.find(part=>part.type===type).value
 return `${value('year')}-${value('month')}-${value('day')}`
}
export async function topUpWikiQueue({base,minPerTopic=8,maxTopics=3,now=new Date(),
 readState=readWikiState,writeState=writeWikiState,discoverQueue=discoverWikiQueue,onPersist=async()=>{}}={}){
 if(!base||!Number.isSafeInteger(minPerTopic)||minPerTopic<1||minPerTopic>30||
  !Number.isSafeInteger(maxTopics)||maxTopics<1||maxTopics>WIKI_TOPICS.length)throw Error('Unsafe Wiki discovery limits')
 const state=await readState(base),beforeLength=state.queue.length
 const cooldownMs=6*60*60*1000
 const discoveryVersion=2
 const available=Object.fromEntries(WIKI_TOPICS.map(topic=>[topic,state.queue.filter(row=>
  row.topic===topic&&ACTIVE_QUEUE_STATUSES.has(state.outcomes[row.pageId]?.status||'PENDING')).length]))
 const low=WIKI_TOPICS.filter(topic=>available[topic]<minPerTopic)
 if(!low.length)return {status:'supply-ready',added:0,available}
 const topics=low.filter(topic=>{
  const last=state.autoDiscoveryVersion===discoveryVersion?
   Date.parse(state.lastAutoDiscoveryAtByTopic?.[topic]||''):NaN
  return !Number.isFinite(last)||now.getTime()-last>=cooldownMs
 }).slice(0,maxTopics)
 if(!topics.length)return {status:'cooldown',added:0,available}
 try{
  await discoverQueue({base,topics,excludeQueued:true,maxPerTopic:20,seedLimit:2,subcategoryLimit:1,maxCategoryPages:2})
  const afterNarrow=await readState(base)
  const stillLow=topics.filter(topic=>afterNarrow.queue.filter(row=>row.topic===topic&&
   ACTIVE_QUEUE_STATUSES.has(afterNarrow.outcomes[row.pageId]?.status||'PENDING')).length<minPerTopic)
  if(stillLow.length)await discoverQueue({base,topics:stillLow,excludeQueued:true,
   maxPerTopic:30,seedLimit:3,subcategoryLimit:2,maxCategoryPages:3})
  const updated=await readState(base)
  updated.autoDiscoveryVersion=discoveryVersion
  updated.lastAutoDiscoveryAtByTopic={...updated.lastAutoDiscoveryAtByTopic,
   ...Object.fromEntries(topics.map(topic=>[topic,now.toISOString()]))}
  await writeState(base,updated)
  await onPersist()
  return {status:'refilled',topics,added:updated.queue.length-beforeLength}
 }catch(error){
  if(error instanceof WikiApiPause)return {status:'retry-later',topics,added:0,reason:safeText(error.message)}
  throw error
 }
}

export async function runWikiBatch({base,maxCalls=0,maxCandidates=5,pageId=null,apiKey='',freeTierConfirmed=false,model='gemini-3.5-flash-lite',models=[],now=new Date(),
 readCatalog=readWikiCatalog,readState=readWikiState,writeState=writeWikiState,
 readCheckpoint=readWikiCheckpoint,writeCheckpoint=writeWikiCheckpoint,onPersist=async()=>{},
 fetchPage=fetchWikipediaPage,fetchRevision=fetchWikipediaRevision,verifyFigures=verifyPageFigures,generate=generateWikiDraft,
 assign=assignWikipediaPhotos,makeStory=makeWikiStory,append=appendWikiStories}={}){
 if(!base||!Number.isSafeInteger(maxCalls)||maxCalls<0||maxCalls>20||
  !Number.isSafeInteger(maxCandidates)||maxCandidates<1||maxCandidates>100)throw Error('Unsafe Wiki batch limits')
 if(maxCalls>0&&(!freeTierConfirmed||!apiKey))throw Error('Free-tier confirmation and key required before Gemini calls')
 const modelCandidates=[...new Set(models.length?models:[model])]
 if(modelCandidates.length>4)throw Error('Unsafe Wiki model fallback list')
 const state=await readState(base),catalog=await readCatalog(base)
 const existingIds=new Set(catalog.stories.map(story=>story.sourcePageId))
 const usedUrls=new Set(catalog.stories.flatMap(story=>story.pages.map(page=>page.image).filter(Boolean)))
 const today=wikiQuotaDay(now)
 if(state.dailyUsage?.day!==today)state.dailyUsage={day:today,calls:0,tokens:0,usageUnknown:false,tokenAccountingUnavailable:false}
 state.dailyUsage.modelCalls??={}
 state.dailyUsage.legacyUnattributedCalls??=Object.keys(state.dailyUsage.modelCalls).length?0:state.dailyUsage.calls
 const persistDurably=async()=>{try{await onPersist()}catch(error){error.checkpointFailure=true;throw error}}
 const initialTokens=state.dailyUsage.tokens
 const budget={maxCalls,usedCalls:0,dailyCalls:state.dailyUsage.calls,dailyTokens:initialTokens,
  dailyModelCalls:{...state.dailyUsage.modelCalls},legacyUnattributedCalls:state.dailyUsage.legacyUnattributedCalls,
  tokenAccountingUnavailable:!!state.dailyUsage.tokenAccountingUnavailable,maxDailyCalls:900,maxTokens:3000000,
  onRequest:async current=>{state.dailyUsage.calls=current.dailyCalls;state.dailyUsage.modelCalls={...current.dailyModelCalls};
   await writeState(base,state);await persistDurably()},
  onUsage:async current=>{current.dailyTokens=initialTokens+current.usage.total;state.dailyUsage.tokens=current.dailyTokens;await writeState(base,state);await persistDurably()}}
 const stats={attempted:0,published:0,review:0,rejected:0,prepared:0,paused:false,apiCalls:0,usage:{input:0,output:0,total:0},decisions:[]}
 const candidates=state.queue.filter(row=>pageId===null||row.pageId===pageId)
 const topicCounts=Object.fromEntries(WIKI_TOPICS.map(topic=>[topic,catalog.stories.filter(story=>story.category===topic).length]))
 const checkpointCache=new Map()
 const checkpointFor=async row=>{
  if(!checkpointCache.has(row.pageId))checkpointCache.set(row.pageId,await readCheckpoint(base,row.pageId))
  return checkpointCache.get(row.pageId)
 }
 const active=candidates.filter(row=>{
  const status=state.outcomes[row.pageId]?.status
  return !coolingAfterModel503(state.outcomes[row.pageId],Date.now())&&
   (!TERMINAL_QUEUE_STATUSES.has(status)||retryableTechnicalReview(state.outcomes[row.pageId])||
    existingIds.has(row.pageId)&&status!=='PUBLISHED')
 })
 const ranked=await Promise.all(active.map(async row=>{
  const checkpoint=await checkpointFor(row)
  const rights=checkpoint?.rights?.filter(item=>item.photo).length||0
  const priority=(checkpoint?.validation?.accepted?10000:checkpoint?.draft?8000:
   checkpoint?.evidence&&rights?6000:0)+Math.min(rights,20)*10+(row.hasThumbnail?5:0)+(row.score||0)
  return {row,priority}
 }))
 const ordered=pageId===null?balanceWikiCandidates(WIKI_TOPICS.map(topic=>({topic,candidates:ranked
  .filter(item=>item.row.topic===topic).sort((a,b)=>b.priority-a.priority)
  .map(item=>item.row)})),{topicCounts,limit:ranked.length}):active
 for(const candidate of ordered){
  if(stats.attempted>=maxCandidates)break
  const prior=state.outcomes[candidate.pageId]
  if(existingIds.has(candidate.pageId)){
   if(prior?.status!=='PUBLISHED'){
    state.outcomes[candidate.pageId]={status:'PUBLISHED',reason:'catalog already contains article',revisionId:prior?.revisionId||null,checkedAt:new Date().toISOString()}
    await writeState(base,state);await persistDurably()
   }
   continue
  }
  if(TERMINAL_QUEUE_STATUSES.has(prior?.status)&&!retryableTechnicalReview(prior))continue
  let checkpoint=await checkpointFor(candidate)||{pageId:candidate.pageId,title:candidate.title,topic:candidate.topic,status:'PENDING'}
  const validNewLengths=['A1-A2','B1-B2','C1-C2'].every(level=>{
   const length=checkpoint.draft?.variants?.[level]?.pages?.length
   return length===5||length===6
  })
  const cachedValidation=checkpoint.validation?.accepted&&validNewLengths&&
   (checkpoint.status==='VALIDATED'||retryableTechnicalReview(prior))
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
   let response=cachedValidation
    ?{result:checkpoint.draft,validation:checkpoint.validation,evidence:checkpoint.evidence,usage:null}:null
   if(!response)for(const [index,currentModel] of modelCandidates.entries()){
    try{
     response=await generate({source,topic:candidate.topic,apiKey,freeTierConfirmed,budget,model:currentModel,
      draft:checkpoint.draft||null,repairAttempts:checkpoint.repairAttempts||0,savedEvidence:checkpoint.evidence,
      priorValidation:checkpoint.validation?.errors?.some(error=>error.includes(':audit-'))?checkpoint.validation:null,
      onDraft:async({result,repairAttempts,usage,evidence:currentEvidence})=>{
       checkpoint.draft=result;checkpoint.repairAttempts=repairAttempts;checkpoint.lastUsage=usage||null
       checkpoint.validation=null
       checkpoint.evidence=currentEvidence.map(({id,hash,heading,text})=>({id,hash,heading,excerpt:text.slice(0,140),revisionUrl:source.sourceRevisionUrl}))
       await mark('DRAFTED','draft durably saved before validation')
      }})
     break
    }catch(error){
     if(!(error instanceof GeminiWikiPause)||![404,503,'MODEL_QUOTA'].includes(error.status)||
      index===modelCandidates.length-1||budget.maxCalls-budget.usedCalls<(checkpoint.draft?1:2)||
      budget.tokenAccountingUnavailable)throw error
     // A model-specific 404/503 need not disable a separately listed free model.
     budget.circuitOpen=false;budget.circuitStatus=null;budget.serviceFailures=0;budget.transientRetries=0
     console.log(`Wiki Gemini ${currentModel} HTTP ${error.status}; trying ${modelCandidates[index+1]}`)
    }
   }
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
    if(error.status==='INVALID_JSON'){await mark('RETRY_LATER',error.message)}
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
