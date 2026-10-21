/** A bounded, resumable Wiki batch. The tracked state holds identifiers and
 * decisions, never scraped article text, generated drafts or API secrets. */
import fs from 'node:fs/promises'
import path from 'node:path'
import {discoverWikiCandidates,balanceWikiCandidates,WIKI_TOPICS} from './discovery.mjs'
import {fetchWikipediaPage,verifyPageFigures,WikiApiPause} from './source.mjs'
import {generateWikiDraft,GeminiWikiPause} from './editor.mjs'
import {assignWikipediaPhotos} from './media.mjs'
import {appendWikiStories,makeWikiStory,readWikiCatalog} from './catalog.mjs'

const fileFor=base=>path.join(base,'data','wiki-pipeline-state.json')
const safeText=value=>String(value||'').replace(/[\r\n]+/g,' ').slice(0,140)
export async function readWikiState(base){
 try{
  const state=JSON.parse(await fs.readFile(fileFor(base),'utf8'))
  if(state.version!==1||!Array.isArray(state.queue)||typeof state.outcomes!=='object')throw Error('Invalid Wiki pipeline state')
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
  maxCategoryPages=3,
  discover=discoverWikiCandidates,readCatalog=readWikiCatalog,readState=readWikiState,writeState=writeWikiState}={}){
 const catalog=await readCatalog(base),state=await readState(base)
 const existingIds=new Set(catalog.stories.map(story=>story.sourcePageId))
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
 await writeState(base,state)
 return {candidates:state.queue.length,scanned:groups.reduce((n,g)=>n+g.scannedPages,0),errors,byTopic:Object.fromEntries(groups.map(g=>[g.topic,g.candidates.length]))}
}

export async function runWikiBatch({base,maxCalls=0,maxCandidates=5,pageId=null,apiKey='',freeTierConfirmed=false,
 readCatalog=readWikiCatalog,readState=readWikiState,writeState=writeWikiState,
 fetchPage=fetchWikipediaPage,verifyFigures=verifyPageFigures,generate=generateWikiDraft,
 assign=assignWikipediaPhotos,makeStory=makeWikiStory,append=appendWikiStories}={}){
 if(!base||!Number.isSafeInteger(maxCalls)||maxCalls<0||maxCalls>20||
  !Number.isSafeInteger(maxCandidates)||maxCandidates<1||maxCandidates>100)throw Error('Unsafe Wiki batch limits')
 if(maxCalls>0&&(!freeTierConfirmed||!apiKey))throw Error('Free-tier confirmation and key required before Gemini calls')
 const state=await readState(base),catalog=await readCatalog(base)
 const existingIds=new Set(catalog.stories.map(story=>story.sourcePageId))
 const usedUrls=new Set(catalog.stories.flatMap(story=>story.pages.map(page=>page.image).filter(Boolean)))
 const budget={maxCalls,usedCalls:0},stats={attempted:0,published:0,review:0,rejected:0,paused:false,apiCalls:0,usage:{input:0,output:0,total:0},decisions:[]}
 for(const candidate of state.queue.filter(row=>pageId===null||row.pageId===pageId)){
  if(stats.attempted>=maxCandidates||maxCalls>0&&maxCalls-budget.usedCalls<2)break
  if(existingIds.has(candidate.pageId)||state.outcomes[candidate.pageId]?.status==='published')continue
  // Stable rejected candidates are skipped. REVIEW candidates may be rechecked
  // only if their source revision has changed in a later discovery batch.
  if(['rejected','review'].includes(state.outcomes[candidate.pageId]?.status))continue
  stats.attempted++
  const mark=async(status,reason,revisionId=null)=>{
   state.outcomes[candidate.pageId]={status,reason:safeText(reason),revisionId,checkedAt:new Date().toISOString()}
   stats.decisions.push({pageId:candidate.pageId,status,reason:safeText(reason)})
   await writeState(base,state)
  }
  try{
   const source=await fetchPage(candidate.title)
   if(source.pageId!==candidate.pageId){await mark('rejected','source-page-id-changed',source.sourceRevisionId);stats.rejected++;continue}
   if(source.wordCount<650||source.figures.length<1){await mark('rejected','insufficient-source-text-or-embedded-images',source.sourceRevisionId);stats.rejected++;continue}
   const rights=await verifyFigures(source)
   const photos=rights.filter(row=>row.status==='REVIEW'&&row.photo&&!usedUrls.has(row.photo.url))
   if(!photos.length){await mark('review','no-rights-verified-embedded-image',source.sourceRevisionId);stats.review++;continue}
   if(maxCalls===0){await mark('source-verified',`${photos.length} rights-verified embedded images; editorial call pending`,source.sourceRevisionId);continue}
   const response=await generate({source,topic:candidate.topic,apiKey,freeTierConfirmed,budget})
   if(response.usage)for(const key of ['input','output','total'])stats.usage[key]+=Number(response.usage[key]||0)
   if(!response.validation.accepted){await mark('review','editorial: '+response.validation.errors.join(','),source.sourceRevisionId);stats.review++;continue}
   const selected=assign(rights,source,response.result.variants,{usedUrls})
   if(selected.status!=='VERIFIED'){await mark('review',selected.reason,source.sourceRevisionId);stats.review++;continue}
   const story=makeStory({source,topic:candidate.topic,draft:{variants:selected.levelVariants},photos:selected.photos,evidence:response.evidence})
   await append(base,[story]);existingIds.add(source.pageId)
   for(const page of story.pages)if(page.image)usedUrls.add(page.image)
   await mark('published',`${selected.photos.length} verified embedded images`,source.sourceRevisionId)
   stats.published++
  }catch(error){
   if(error instanceof GeminiWikiPause||error instanceof WikiApiPause){
    stats.paused=true;await mark('paused',error.message);break
   }
   await mark('review',error.message);stats.review++
  }
 }
 stats.apiCalls=budget.usedCalls
 if(budget.usageUnknown)stats.usage=null
 else if(budget.usage)stats.usage=budget.usage
 return stats
}
