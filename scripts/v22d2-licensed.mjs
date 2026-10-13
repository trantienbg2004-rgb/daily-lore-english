/** Builds an ISOLATED staging feed using only per-page CC-BY-evidenced Global Voices text.
 * Existing public/full-feed and world-news discovery are never modified.
 */
import fs from 'node:fs/promises'
import path from 'node:path'
import {fileURLToPath} from 'node:url'
import {parseLicensedGlobalVoices,balancedLicensedOrder,htmlReadingDiagnostics} from './lib/v22d2-licensed.mjs'

const folder=base=>path.join(base,'public','world-reader-pilot')
const write=async(file,value)=>{await fs.mkdir(path.dirname(file),{recursive:true});const tmp=file+'.tmp';await fs.writeFile(tmp,JSON.stringify(value,null,2)+'\n');await fs.rename(tmp,file)}
const reportPath=base=>path.join(base,'DAILY_NEWS_LICENSED_PILOT_REPORT.txt')
const srcFile=base=>path.join(base,'public','world-news','index.json')
const detail=(candidate,out)=>`  ${out.reason||'ACCEPTED'} | ${candidate.title} | ${candidate.sourceUrl}${out.diagnostics?' | html='+JSON.stringify(out.diagnostics):''}`
export async function collectLicensedPilot({base=process.cwd(),fetchImpl=fetch,now=new Date(),log=console,limit=40}={}){
 let index
 try{index=JSON.parse(await fs.readFile(srcFile(base),'utf8'))}catch(e){throw Error(`Missing V22-D.1 discovered headlines (${srcFile(base)}). Run node scripts/v22d-collect.mjs first. ${e.message}`)}
 if(!Array.isArray(index))throw Error('World discovery index is invalid')
 const candidates=index.filter(item=>item.publisher==='Global Voices'&&item.contentPolicy==='discovery-only'&&item.readingKind==='link-only')
  .sort((a,b)=>Date.parse(b.publishedAt)-Date.parse(a.publishedAt)).slice(0,Math.max(1,Math.min(60,limit)))
 const accepted=[],checks=[],reasons={}
 for(const candidate of candidates){
  let outcome
  try{
   const controller=new AbortController();const t=setTimeout(()=>controller.abort(),12000)
   let res
   try{res=await fetchImpl(candidate.sourceUrl,{headers:{'User-Agent':'DailyNews/22D2 (licensed-source pilot; original attribution preserved)','Accept':'text/html'},signal:controller.signal,redirect:'follow'})}finally{clearTimeout(t)}
   if(!res.ok)throw Error(`HTTP ${res.status}`)
   if(res.url&&new URL(res.url).hostname!=='globalvoices.org')throw Error('Unexpected redirect')
   const html=await res.text()
   outcome=parseLicensedGlobalVoices(html,candidate,{now})
   if(outcome.reason==='main-text-not-found'||outcome.reason==='author-unverified')outcome.diagnostics=htmlReadingDiagnostics(html)
  }catch(e){outcome={reason:/^HTTP \d+/.test(e.message||'')?e.message:'fetch-or-parse-error'}}
  checks.push(detail(candidate,outcome))
  if(outcome.article)accepted.push(outcome.article)
  else reasons[outcome.reason]=(reasons[outcome.reason]||0)+1
  log.log(`[LICENSED PILOT] ${outcome.article?'ACCEPTED':outcome.reason}: ${candidate.title.slice(0,68)}`)
  if(outcome.diagnostics&&checks.filter(c=>c.includes(' | html=')).length<=3)log.log(`[LICENSED HTML] ${JSON.stringify(outcome.diagnostics)}`)
 }
 // An empty result does not overwrite a previously successful pilot.
 const output=folder(base),hasNew=accepted.length>0
 if(hasNew){
  const before=await (async()=>{try{return JSON.parse(await fs.readFile(path.join(output,'0000.json'),'utf8'))}catch(e){if(e.code==='ENOENT')return [];throw e}})()
  const byId=new Map([...before.filter(s=>s?.publisher==='Global Voices'&&s?.readingKind==='full'),...accepted].map(s=>[s.id,s]))
  const rows=balancedLicensedOrder([...byId.values()]).slice(0,200)
  await write(path.join(output,'0000.json'),rows)
  await write(path.join(output,'manifest.json'),{version:22,stage:'V22-D2 pilot',feedType:'licensed-world',updatedAt:now.toISOString(),total:rows.length,chunks:1,chunkSize:200,sourceCount:1,ready:false,readerReady:false,contentPolicy:'cc-by-evidence-only'})
  await write(path.join(output,'status.json'),{updatedAt:now.toISOString(),acceptedThisRun:accepted.length,total:rows.length,reasons,readerReady:false})
 }
 const report=[
  'DAILY NEWS V22-D2 — REAL WORLD ARTICLE PILOT (not deployed)',
  `UTC: ${now.toISOString()}`,
  `DISCOVERED WORLD HEADLINES: ${index.length}`,
  `GLOBAL VOICES CANDIDATES TESTED: ${candidates.length}`,
  `ACCEPTED FULL ARTICLE TEXT THIS RUN: ${accepted.length}`,
  `REJECTED: ${JSON.stringify(reasons)}`,
  '',
  'IMPORTANT: All other publishers are headline/link-only. This pilot never republishes their article text.',
  'Public/full-feed with 94 collected articles is NOT modified. Current Read UI is NOT modified.',
  'No images, AI-generated summaries, or paid services are used.',
  'The pilot is NOT production-ready. Article text/licensing still needs human sampling.',
  '',
  'SAMPLES / DETAILS:',...checks,
  '',
  'NEXT: Upload this report to ChatGPT. It will tell us whether this licensed article path works or needs a different source.',
 ].join('\n')+'\n'
 await fs.writeFile(reportPath(base),report)
 log.log(`[LICENSED PILOT REPORT] ${JSON.stringify({worldHeadlines:index.length,tested:candidates.length,accepted:accepted.length,rejected:reasons,productionReady:false})}`)
 return {candidates:candidates.length,accepted:accepted.length,reasons,report}
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))collectLicensedPilot().catch(e=>{console.error(e);process.exitCode=1})
