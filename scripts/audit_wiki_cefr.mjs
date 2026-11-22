#!/usr/bin/env node
/**
 * Objective CEFR audit & safe auto-requeue tool for SAGA Wiki articles in public/wiki-reader/.
 *
 * Default (read-only):
 *   node scripts/audit_wiki_cefr.mjs
 *   - Scans all published articles across A1-A2, B1-B2, and C1-C2.
 *   - Prints average FKGL & lexical percentages per level, pass/fail counts,
 *     and top 10 most common over-level words leaking into A1-A2.
 *
 * Safe auto-requeue:
 *   node scripts/audit_wiki_cefr.mjs --apply-requeue [--min-keep=20]
 *   - Removes failing articles while enforcing a safety floor (default: keep at least 20 best-scoring articles live).
 *   - Prepends removed articles to the FRONT of data/wiki_queue.json with status="pending", priority=0 (no duplicates).
 *   - Repacks public/wiki-reader/ shards, manifest.json, and catalog-index-*.json cleanly.
 */
import fs from 'node:fs/promises'
import path from 'node:path'
import {fileURLToPath} from 'node:url'
import {WIKI_TOPICS} from './wiki/discovery.mjs'
import {readWikiCatalog,rewriteWikiCatalog} from './wiki/catalog.mjs'
import {evaluateArticleCEFR} from './wiki/cefrProfiler.mjs'

const ROOT=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..')
const DEFAULT_QUEUE_FILE=path.join(ROOT,'data','wiki_queue.json')
const LEVELS=['A1-A2','B1-B2','C1-C2']
export const DEFAULT_SAFETY_FLOOR=20

const normTitle=title=>String(title||'').trim().toLowerCase()

function summarizeQueue(queue,now=new Date()){
 const counts={pending:0,published:0,skipped_no_image:0,skipped_no_lead_image:0,skipped_quality:0}
 const byTopic=Object.fromEntries(WIKI_TOPICS.map(t=>[t,{pending:0,published:0,skipped_no_image:0,skipped_no_lead_image:0,skipped_quality:0,total:0}]))
 for(const item of queue.items||[]){
  const st=item.status||'pending'
  counts[st]=(counts[st]||0)+1
  if(byTopic[item.topic]){
   byTopic[item.topic][st]=(byTopic[item.topic][st]||0)+1
   byTopic[item.topic].total++
  }
 }
 return {...queue,updatedAt:now.toISOString(),total:(queue.items||[]).length,counts,byTopic}
}

/**
 * Pure CEFR audit over an array of Wiki stories.
 */
export function auditStoriesCEFR(stories,{minKeep=DEFAULT_SAFETY_FLOOR}={}){
 const list=Array.isArray(stories)?stories:[]
 const results=[]
 const overWordCounts=new Map()

 const sums=Object.fromEntries(LEVELS.map(l=>[l,{
  fkgl:0,
  avgSentenceLength:0,
  a1a2Pct:0,
  b1b2Pct:0,
  a1ToB2Pct:0,
  c1c2OrUnlistedPct:0,
  b2PlusC1C2OrUnlistedPct:0
 }]))

 for(const story of list){
  const evaluation=evaluateArticleCEFR(story.levelVariants,{sourceTitle:story.sourceTitle})
  results.push({
   story,
   id:story.id,
   sourcePageId:story.sourcePageId,
   sourceTitle:story.sourceTitle,
   sourceUrl:story.sourceUrl,
   title:story.title,
   category:story.category,
   passed:evaluation.ok,
   penalty:evaluation.penalty,
   errors:evaluation.errors,
   profiles:evaluation.profiles,
   gaps:evaluation.gaps
  })

  for(const level of LEVELS){
   const p=evaluation.profiles[level]
   sums[level].fkgl+=p.fkgl
   sums[level].avgSentenceLength+=p.avgSentenceLength
   sums[level].a1a2Pct+=p.lexicalProfile.a1a2Pct
   sums[level].b1b2Pct+=p.lexicalProfile.b1b2Pct
   sums[level].a1ToB2Pct+=p.lexicalProfile.a1ToB2Pct
   sums[level].c1c2OrUnlistedPct+=p.lexicalProfile.c1c2OrUnlistedPct
   sums[level].b2PlusC1C2OrUnlistedPct+=p.lexicalProfile.b2PlusC1C2OrUnlistedPct
  }

  for(const w of evaluation.profiles['A1-A2'].overLevelWords||[]){
   overWordCounts.set(w,(overWordCounts.get(w)||0)+1)
  }
 }

 const n=list.length
 const avg=val=>n?Number((val/n).toFixed(2)):0
 const averages=Object.fromEntries(LEVELS.map(l=>[l,{
  fkgl:avg(sums[l].fkgl),
  avgSentenceLength:avg(sums[l].avgSentenceLength),
  a1a2Pct:avg(sums[l].a1a2Pct),
  b1b2Pct:avg(sums[l].b1b2Pct),
  a1ToB2Pct:avg(sums[l].a1ToB2Pct),
  c1c2OrUnlistedPct:avg(sums[l].c1c2OrUnlistedPct),
  b2PlusC1C2OrUnlistedPct:avg(sums[l].b2PlusC1C2OrUnlistedPct)
 }]))

 const passed=results.filter(r=>r.passed)
 const failed=results.filter(r=>!r.passed)

 // Safety floor: keep all passed articles + top best-scoring failed articles to meet minKeep
 const rankedFailed=[...failed].sort((a,b)=>
  (a.penalty-b.penalty)||
  (a.errors.length-b.errors.length)||
  (a.profiles['A1-A2'].fkgl-b.profiles['A1-A2'].fkgl)||
  String(a.sourceTitle).localeCompare(String(b.sourceTitle))
 )

 const neededFromFailed=Math.max(0,Math.min(rankedFailed.length,minKeep-passed.length))
 const keptByFloor=rankedFailed.slice(0,neededFromFailed)
 const toRemove=rankedFailed.slice(neededFromFailed)
 const keptIds=new Set([...passed,...keptByFloor].map(r=>r.sourcePageId))
 const keptOrdered=results.filter(r=>keptIds.has(r.sourcePageId))

 const topA1OverLevelWords=[...overWordCounts.entries()]
  .sort((a,b)=>b[1]-a[1]||a[0].localeCompare(b[0]))
  .slice(0,10)
  .map(([word,articles])=>({word,articles}))

 return {
  totalArticles:n,
  passedCount:passed.length,
  failedCount:failed.length,
  safetyFloor:minKeep,
  plannedKeptCount:keptOrdered.length,
  plannedKeptByFloorCount:keptByFloor.length,
  plannedRequeueCount:toRemove.length,
  averages,
  topA1OverLevelWords,
  kept:keptOrdered,
  keptByFloor,
  toRemove,
  results
 }
}

/**
 * Read-only audit of published stories in public/wiki-reader/.
 */
export async function auditWikiCEFR({root=ROOT,minKeep=DEFAULT_SAFETY_FLOOR}={}){
 const catalog=await readWikiCatalog(root)
 return auditStoriesCEFR(catalog.stories||[],{minKeep})
}

/**
 * Apply safe auto-requeue:
 * 1. Keep all CEFR-passing stories + best-scoring fallback stories up to minKeep (default 20).
 * 2. Rewrite public/wiki-reader/ shards, manifest.json, and catalog-index-*.json with kept stories.
 * 3. Prepend all removed stories to the FRONT of data/wiki_queue.json with status="pending", priority=0 (deduplicated).
 */
export async function applyCEFRRequeue({
 root=ROOT,
 queueFile=DEFAULT_QUEUE_FILE,
 minKeep=DEFAULT_SAFETY_FLOOR,
 now=new Date()
}={}){
 const audit=await auditWikiCEFR({root,minKeep})
 if(audit.plannedRequeueCount===0){
  return {
   applied:false,
   audit,
   keptCount:audit.plannedKeptCount,
   requeuedCount:0,
   requeuedTitles:[],
   catalogResult:null
  }
 }

 const keptStories=audit.kept.map(r=>r.story)
 const catalogResult=await rewriteWikiCatalog(root,keptStories,{now})

 // Load and update data/wiki_queue.json: prepend removed items at the FRONT with status='pending' & priority=0
 const queueRaw=JSON.parse(await fs.readFile(queueFile,'utf8'))
 const existingItems=Array.isArray(queueRaw.items)?queueRaw.items:[]
 const byPageId=new Map()
 const byTitle=new Map()
 for(const item of existingItems){
  if(Number.isSafeInteger(item?.pageId))byPageId.set(item.pageId,item)
  if(item?.title)byTitle.set(normTitle(item.title),item)
 }

 const removedPageIds=new Set()
 const removedTitles=new Set()
 const prepended=[]

 // Order worst-failing first so the biggest CEFR upgrades are rewritten first
 const removedWorstFirst=[...audit.toRemove].sort((a,b)=>b.penalty-a.penalty||String(a.sourceTitle).localeCompare(String(b.sourceTitle)))
 for(const row of removedWorstFirst){
  const pid=row.sourcePageId
  const tNorm=normTitle(row.sourceTitle)
  if((Number.isSafeInteger(pid)&&removedPageIds.has(pid))||removedTitles.has(tNorm))continue
  if(Number.isSafeInteger(pid))removedPageIds.add(pid)
  removedTitles.add(tNorm)

  const prev=(Number.isSafeInteger(pid)?byPageId.get(pid):null)||byTitle.get(tNorm)||null
  const topic=WIKI_TOPICS.includes(row.category)?row.category:(prev?.topic||'History & Geography')
  const entry={
   title:row.sourceTitle,
   pageId:pid,
   topic,
   source:prev?.source||'cefr_requeue',
   priority:0,
   sourceUrl:row.sourceUrl||prev?.sourceUrl||`https://en.wikipedia.org/wiki/${encodeURIComponent(String(row.sourceTitle).replace(/ /g,'_'))}`,
   hasLeadImage:true,
   ...(Number.isFinite(prev?.views)?{views:prev.views}:{}),
   status:'pending',
   addedAt:prev?.addedAt||now.toISOString(),
   requeuedAt:now.toISOString(),
   requeuedReason:'cefr_upgrade'
  }
  prepended.push(entry)
 }

 const remainingItems=existingItems.filter(item=>{
  if(Number.isSafeInteger(item?.pageId)&&removedPageIds.has(item.pageId))return false
  if(item?.title&&removedTitles.has(normTitle(item.title)))return false
  return true
 })

 const nextQueue=summarizeQueue({...queueRaw,items:[...prepended,...remainingItems]},now)
 const tmp=`${queueFile}.tmp-${process.pid}`
 await fs.writeFile(tmp,JSON.stringify(nextQueue,null,2)+'\n','utf8')
 await fs.rename(tmp,queueFile)

 return {
  applied:true,
  audit,
  keptCount:keptStories.length,
  keptPassedCount:audit.passedCount,
  keptByFloorCount:audit.plannedKeptByFloorCount,
  requeuedCount:prepended.length,
  requeuedTitles:prepended.map(p=>p.title),
  catalogResult,
  queueTotal:nextQueue.total,
  queuePending:nextQueue.counts.pending
 }
}

function printReport(report){
 console.log('=================================================================')
 console.log('SAGA WIKI OBJECTIVE CEFR AUDIT REPORT (FKGL + LEXICAL PROFILER)')
 console.log('=================================================================')
 console.log(`Total articles scanned:            ${report.totalArticles}`)
 console.log(`CEFR gate PASS:                    ${report.passedCount}`)
 console.log(`CEFR gate FAIL:                    ${report.failedCount}`)
 console.log(`Safety floor (min kept live):      ${report.safetyFloor} (planned kept: ${report.plannedKeptCount}, requeue: ${report.plannedRequeueCount})`)
 console.log('-----------------------------------------------------------------')
 console.log('Level averages:')
 for(const level of LEVELS){
  const a=report.averages[level]
  console.log(`  ${level}: FKGL=${a.fkgl} | avgSent=${a.avgSentenceLength}w | A1-A2=${a.a1a2Pct}% | B1-B2=${a.b1b2Pct}% | A1-B2=${a.a1ToB2Pct}% | C1-C2/unlisted=${a.c1c2OrUnlistedPct}% | B2+C1-C2=${a.b2PlusC1C2OrUnlistedPct}%`)
 }
 console.log('-----------------------------------------------------------------')
 console.log('Top 10 most common over-level words leaking into A1-A2:')
 if(!report.topA1OverLevelWords.length){
  console.log('  (none)')
 }else{
  report.topA1OverLevelWords.forEach((item,idx)=>{
   console.log(`  ${String(idx+1).padStart(2,' ')}. ${item.word} (${item.articles} article${item.articles===1?'':'s'})`)
  })
 }
 console.log('=================================================================')
}

function parseArgs(argv){
 const opts={applyRequeue:false,asJson:false,minKeep:DEFAULT_SAFETY_FLOOR,queueFile:DEFAULT_QUEUE_FILE}
 for(const arg of argv){
  if(arg==='--apply-requeue')opts.applyRequeue=true
  else if(arg==='--json')opts.asJson=true
  else if(arg.startsWith('--min-keep=')){
   const v=Number(arg.split('=')[1])
   if(Number.isFinite(v)&&v>=1)opts.minKeep=Math.floor(v)
  }else if(arg.startsWith('--queue-file=')){
   opts.queueFile=path.resolve(arg.slice('--queue-file='.length))
  }
 }
 return opts
}

if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 const opts=parseArgs(process.argv.slice(2))
 if(opts.applyRequeue){
  applyCEFRRequeue({root:ROOT,queueFile:opts.queueFile,minKeep:opts.minKeep})
   .then(res=>{
    if(opts.asJson){
     console.log(JSON.stringify({
      applied:res.applied,
      keptCount:res.keptCount,
      keptPassedCount:res.keptPassedCount,
      keptByFloorCount:res.keptByFloorCount,
      requeuedCount:res.requeuedCount,
      queueTotal:res.queueTotal,
      queuePending:res.queuePending,
      catalogResult:res.catalogResult
     },null,2))
    }else{
     printReport(res.audit)
     console.log('\n[APPLY-REQUEUE SUMMARY]')
     console.log(`  Kept live in public/wiki-reader/: ${res.keptCount} (${res.keptPassedCount} passed + ${res.keptByFloorCount} best-scoring safety floor)`)
     console.log(`  Removed & prepended to FRONT of data/wiki_queue.json: ${res.requeuedCount}`)
     if(res.catalogResult){
      console.log(`  Repacked shards: ${res.catalogResult.chunks} | index: ${res.catalogResult.catalogIndex} | verifiedImages: ${res.catalogResult.verifiedImageCount}`)
     }
     console.log(`  Queue totals: ${res.queueTotal} total, ${res.queuePending} pending`)
    }
   })
   .catch(err=>{
    console.error('CEFR requeue failed:',err.message)
    process.exit(1)
   })
 }else{
  auditWikiCEFR({root:ROOT,minKeep:opts.minKeep})
   .then(report=>{
    if(opts.asJson){
     const compact={
      totalArticles:report.totalArticles,
      passedCount:report.passedCount,
      failedCount:report.failedCount,
      safetyFloor:report.safetyFloor,
      plannedKeptCount:report.plannedKeptCount,
      plannedRequeueCount:report.plannedRequeueCount,
      averages:report.averages,
      topA1OverLevelWords:report.topA1OverLevelWords
     }
     console.log(JSON.stringify(compact,null,2))
    }else{
     printReport(report)
    }
   })
   .catch(err=>{
    console.error('CEFR audit failed:',err.message)
    process.exit(1)
   })
 }
}
