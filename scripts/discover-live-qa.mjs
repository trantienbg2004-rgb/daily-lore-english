/** SAGA Discover: read-only, fail-closed QA for real Gemini staging drafts.
 * Reads ONLY reports/saga-discover-local. Never writes public/ or publishes.
 */
import fs from 'node:fs'
import path from 'node:path'
import {pathToFileURL} from 'node:url'
import {DISCOVER_LEVELS} from './discover/geminiLevels.mjs'
import {readableStory,validStories} from '../src/lib/feedQueue.js'

const compact=x=>String(x??'').trim()
const words=x=>compact(x).split(/\s+/u).filter(Boolean).length
const isHttps=x=>{try{return new URL(x).protocol==='https:'}catch{return false}}

export function inspectStagedRelease(report,drafts){
 const issues=[],seen=new Set(),details=[]
 if(!report||report.mode!=='gemini-staging')issues.push('Not a live Gemini staging report')
 if(report?.publishEnabled!==false||report?.publicFilesChanged!==false)issues.push('Staging must never publish')
 if(!Array.isArray(drafts))issues.push('Draft file is not an array')
 const list=Array.isArray(drafts)?drafts:[]
 if(list.length===0)issues.push('No complete three-level drafts; do not publish')
 if(report?.completeThreeLevelDrafts!==list.length)issues.push('Report and draft counts disagree')
 for(const [i,draft] of list.entries()){
  const errors=[]
  const id=compact(draft?.id),url=compact(draft?.sourceUrl)
  if(!id||seen.has(id))errors.push('Missing or repeated story ID')
  seen.add(id)
  if(!isHttps(url))errors.push('Invalid source URL')
  if(!compact(draft?.sourceName)||!compact(draft?.title))errors.push('Missing source or title')
  if(draft?.rights?.textAllowed!==true||draft?.rights?.mode!=='gemini-eligible')errors.push('Rights gate not satisfied')
  if(draft?.imageUrl)errors.push('Unverified source image must not be published')
  if(!draft?.levelVariants||DISCOVER_LEVELS.some(level=>!draft.levelVariants[level]))errors.push('Incomplete three-level variants')
  const counts={}
  for(const level of DISCOVER_LEVELS){
   const variant=draft?.levelVariants?.[level],pages=variant?.pages
   if(!Array.isArray(pages)||pages.length<4||pages.length>6){errors.push(`${level}: not 4–6 source paragraphs`);continue}
   if(!validStories([{title:draft.title,pages}]))errors.push(`${level}: incompatible reader page schema`)
   if(pages.some(p=>p.image||p.caption))errors.push(`${level}: unverified image/caption`)
   const total=pages.reduce((sum,p)=>sum+words(p.text),0)
   counts[level]=total
   if(total<180||total>350)errors.push(`${level}: text length ${total} outside 180–350`)
   if(pages.some(p=>words(p.text)<22||words(p.text)>105))errors.push(`${level}: invalid paragraph length`)
   if(!Array.isArray(variant?.keyVocabulary)||variant.keyVocabulary.length!==3)errors.push(`${level}: vocabulary count not 3`)
   if(!Array.isArray(variant?.evidence)||variant.evidence.length<3)errors.push(`${level}: missing evidence`)
   const candidate={...draft,contentType:'news',readingKind:'full',pages,sourceUrl:url}
   if(!readableStory(candidate))errors.push(`${level}: reader contract rejected story`)
  }
  if(DISCOVER_LEVELS.every(x=>Array.isArray(draft?.levelVariants?.[x]?.pages))){
   const texts=DISCOVER_LEVELS.map(level=>draft.levelVariants[level].pages.map(p=>p.text).join(' ').toLowerCase())
   if(new Set(texts).size!==3)errors.push('Three variants are not distinct')
  }
  details.push({index:i+1,id,sourceId:draft?.sourceId||'',wordCounts:counts,issues:errors})
  issues.push(...errors.map(x=>`Draft ${i+1}: ${x}`))
 }
 return {status:issues.length===0?'PASS':'BLOCKED',sourceCount:report?.sourceCount||0,candidates:report?.candidates||0,
  eligible:report?.eligible||0,geminiCalls:report?.geminiCalls||0,drafts:list.length,
  rejectionCounts:report?.rejected||{},sources:(report?.sourceStatus||[]).map(s=>({source:s.source,feedItems:s.feedItems||0,errors:s.errors||[],error:s.error||''})),
  issues,details,publicFilesChanged:false}
}

export function formatSummary(result){
 const lines=['## SAGA Discover — Live ingestion + Gemini 2.5 Flash QA','',
 '| Check | Result |','|---|---:|',
 `| Status | **${result.status}** |`,
 `| News source adapters | ${result.sourceCount} |`,
 `| RSS candidates | ${result.candidates} |`,
 `| Rights-eligible source articles | ${result.eligible} |`,
 `| Gemini attempts | ${result.geminiCalls} |`,
 `| Complete three-level stories | ${result.drafts} |`,
 '', '**No publication, no deletion of old articles, no main-branch deployment.**',
 '', '### Source results',
 '| Source | Feed items | Errors |','|---|---:|---|',
 ...result.sources.map(s=>`| ${s.source} | ${s.feedItems} | ${[...s.errors,s.error].filter(Boolean).join('; ').replace(/\|/g,'/')||'None'} |`),
 '', '### Gate results',
 ...(result.issues.length?result.issues.map(i=>'- '+i):['- All structural gates passed. Human factual/legal review still required.']),
 '', 'Rejection counts: `'+JSON.stringify(result.rejectionCounts)+'`','']
 return lines.join('\n')
}

export function runStagedQA({base='reports/saga-discover-local',summaryFile=process.env.GITHUB_STEP_SUMMARY}={}){
 const file=path.join(base,'source-report.json'),draftFile=path.join(base,'gemini-drafts.json')
 if(!fs.existsSync(file)||!fs.existsSync(draftFile))throw Error('Missing real staging output; inspect collection step')
 const result=inspectStagedRelease(JSON.parse(fs.readFileSync(file,'utf8')),JSON.parse(fs.readFileSync(draftFile,'utf8')))
 fs.writeFileSync(path.join(base,'quality-report.json'),JSON.stringify(result,null,2)+'\n')
 const summary=formatSummary(result)
 console.log(summary)
 if(summaryFile)fs.appendFileSync(summaryFile,summary+'\n')
 if(result.status!=='PASS')throw Error('SAGA live staging BLOCKED; do not publish')
 return result
}
const isCLI=process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href
if(isCLI){try{runStagedQA()}catch(e){console.error('LIVE QA STOPPED:',e.message);process.exitCode=1}}
