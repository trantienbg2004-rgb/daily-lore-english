/** Automated, zero-cost, strictly audited Wikipedia article fetcher & publisher for SAGA.
 * Supports:
 *   --mode=status    Inspect live catalog counts, topic balance, and run full audit (0 API cost)
 *   --mode=audit     Run strict catalog + release audit and exit non-zero on any failure (0 API cost)
 *   --mode=discover  Discover fresh non-overlapping Wikipedia articles for the lowest-count topics (0 AI cost)
 *   --mode=sync      Discover/topup lowest-count topics, run bounded free-tier batch with auditWikiStory gate,
 *                    rebuild catalog-index.json, and verify zero audit errors.
 */
import path from 'node:path'
import {fileURLToPath,pathToFileURL} from 'node:url'
import {WIKI_TOPICS} from './wiki/discovery.mjs'
import {readWikiCatalog,WIKI_TARGET_PER_TOPIC,WIKI_TARGET_STORIES} from './wiki/catalog.mjs'
import {auditWikiCatalog} from './wiki/audit.mjs'
import {discoverWikiQueue,runWikiBatch} from './wiki/runner.mjs'
import {selectAvailableWikiModel} from './wiki/model-availability.mjs'
import {verifyWikiRelease} from './build-reader-index.mjs'

const DEFAULT_BASE=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..')
const VALID_MODES=new Set(['status','audit','discover','sync'])

export function parseAutoArgs(argv=[]){
 const parsed={mode:'sync',count:3,maxCalls:12,topic:null,dryRun:false,model:null}
 for(const raw of argv){
  const item=String(raw||'')
  if(item==='--dry-run'){parsed.dryRun=true;continue}
  const match=item.match(/^--([a-z-]+)=(.*)$/)
  if(!match)throw Error(`Unsupported option: ${item}`)
  const [,key,value]=match
  if(key==='mode'){
   if(!VALID_MODES.has(value))throw Error(`Invalid --mode=${value}. Expected status|audit|discover|sync`)
   parsed.mode=value
  }else if(key==='count'){
   const n=Number(value)
   if(!Number.isSafeInteger(n)||n<1||n>25)throw Error('Invalid --count (1..25)')
   parsed.count=n
  }else if(key==='max-calls'){
   const n=Number(value)
   if(!Number.isSafeInteger(n)||n<0||n>20)throw Error('Invalid --max-calls (0..20)')
   parsed.maxCalls=n
  }else if(key==='topic'){
   if(!WIKI_TOPICS.includes(value))throw Error(`Unknown --topic=${value}`)
   parsed.topic=value
  }else if(key==='model'){
   parsed.model=value.trim()||null
  }else{
   throw Error(`Unknown option: --${key}`)
  }
 }
 return parsed
}

export function summarizeCatalogTopics(stories=[]){
 const byTopic=Object.fromEntries(WIKI_TOPICS.map(topic=>[topic,0]))
 for(const story of stories){
  if(byTopic[story.category]!==undefined)byTopic[story.category]++
 }
 return byTopic
}

export function planAutoSyncTopics(byTopic,{topic=null,maxTopics=3}={}){
 if(topic)return [topic]
 return [...WIKI_TOPICS]
  .sort((a,b)=>(byTopic[a]??0)-(byTopic[b]??0)||WIKI_TOPICS.indexOf(a)-WIKI_TOPICS.indexOf(b))
  .slice(0,Math.max(1,Math.min(maxTopics,WIKI_TOPICS.length)))
}

export async function runWikiAuto({
 base=DEFAULT_BASE,
 mode='sync',
 count=3,
 maxCalls=12,
 topic=null,
 dryRun=false,
 model=null,
 apiKey=process.env.SAGA_WIKI_GEMINI_KEY||process.env.GEMINI_API_KEY||'',
 freeTierConfirmed=process.env.SAGA_WIKI_FREE_TIER_CONFIRMED==='1',
 readCatalog=readWikiCatalog,
 discoverQueue=discoverWikiQueue,
 selectModel=selectAvailableWikiModel,
 runBatch=runWikiBatch,
 verifyRelease=verifyWikiRelease,
 auditCatalog=auditWikiCatalog,
}={}){
 if(!VALID_MODES.has(mode))throw Error(`Invalid mode: ${mode}`)
 const catalog=await readCatalog(base)
 const byTopic=summarizeCatalogTopics(catalog.stories)
 const priorityTopics=planAutoSyncTopics(byTopic,{topic,maxTopics:topic?1:Math.min(count,WIKI_TOPICS.length)})
 const preAudit=auditCatalog(catalog.stories,{
  targetStories:WIKI_TARGET_STORIES,
  targetPerTopic:WIKI_TARGET_PER_TOPIC,
 })

 if(mode==='status'){
  return {
   mode,
   total:catalog.stories.length,
   byTopic,
   priorityTopics,
   audit:{passed:preAudit.passed,failed:preAudit.failed,targetMet:preAudit.targetMet,uniqueImages:preAudit.uniqueImages},
  }
 }

 if(mode==='audit'){
  const release=await verifyRelease(base)
  return {
   mode,
   total:catalog.stories.length,
   byTopic,
   release,
   audit:{
    passed:preAudit.passed,
    failed:preAudit.failed,
    targetMet:preAudit.targetMet,
    uniqueImages:preAudit.uniqueImages,
    sampleFailures:preAudit.failures.slice(0,5),
   },
  }
 }

 if(dryRun){
  return {
   mode,
   dryRun:true,
   total:catalog.stories.length,
   byTopic,
   priorityTopics,
   plannedCandidates:count,
   plannedMaxCalls:apiKey&&freeTierConfirmed?maxCalls:0,
   audit:{passed:preAudit.passed,failed:preAudit.failed,targetMet:preAudit.targetMet},
  }
 }

 const discovery=await discoverQueue({
  base,
  topics:priorityTopics,
  maxPerTopic:Math.max(8,count*3),
  seedLimit:1,
  subcategoryLimit:1,
  maxCategoryPages:2,
  excludeQueued:true,
 })

 if(mode==='discover'){
  return {
   mode,
   total:catalog.stories.length,
   priorityTopics,
   discovery,
  }
 }

 let modelPlan={available:false,model:null,models:[],reason:'no-free-tier-key'}
 let effectiveCalls=0
 if(apiKey&&freeTierConfirmed&&maxCalls>0){
  const envModels=(process.env.SAGA_WIKI_MODELS||'').split(',').map(s=>s.trim()).filter(Boolean).slice(0,4)
  const envModel=(process.env.SAGA_WIKI_MODEL||'').trim()
  if(model){
   modelPlan={available:true,model,models:[model],reason:'explicit-model'}
   effectiveCalls=maxCalls
  }else if(envModels.length){
   modelPlan={available:true,model:envModel||envModels[0],models:envModels,reason:'workflow-probed-models'}
   effectiveCalls=maxCalls
  }else{
   modelPlan=await selectModel({apiKey})
   if(modelPlan.available)effectiveCalls=maxCalls
  }
 }

 const batch=await runBatch({
  base,
  maxCalls:effectiveCalls,
  maxCandidates:Math.max(count,effectiveCalls>0?count*2:count),
  apiKey:effectiveCalls>0?apiKey:'',
  freeTierConfirmed:effectiveCalls>0?freeTierConfirmed:false,
  model:modelPlan.model||'gemini-2.5-flash',
  models:modelPlan.models||[],
 })

 const afterCatalog=await readCatalog(base)
 const postAudit=auditCatalog(afterCatalog.stories,{
  targetStories:WIKI_TARGET_STORIES,
  targetPerTopic:WIKI_TARGET_PER_TOPIC,
 })
 const release=await verifyRelease(base)
 return {
  mode,
  priorityTopics,
  discovery,
  modelPlan:{available:modelPlan.available,model:modelPlan.model,reason:modelPlan.reason},
  batch,
  total:afterCatalog.stories.length,
  byTopic:summarizeCatalogTopics(afterCatalog.stories),
  release,
  audit:{
   passed:postAudit.passed,
   failed:postAudit.failed,
   targetMet:postAudit.targetMet,
   uniqueImages:postAudit.uniqueImages,
   sampleFailures:postAudit.failures.slice(0,5),
  },
 }
}

if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
 try{
  const args=parseAutoArgs(process.argv.slice(2))
  const report=await runWikiAuto(args)
  console.log(JSON.stringify(report,null,2))
  if(report.audit&&!report.audit.passed)process.exitCode=1
 }catch(error){
  console.error(JSON.stringify({status:'error',reason:String(error?.message||error).slice(0,220)}))
  process.exitCode=1
 }
}
