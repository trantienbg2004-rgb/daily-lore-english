/** Builds an isolated, reversible public/world-reader release from verified pilot.
 * Never alters the existing 98-article pilot, 94-article archive or 639 links.
 * A failed validation leaves all previous output files intact.
 */
import fs from 'node:fs/promises'
import path from 'node:path'
import {fileURLToPath} from 'node:url'
import {createHash} from 'node:crypto'
import {sanitizeReadingArticle} from '../src/lib/articleCleanup.js'
import {assemblePublishable,makeReaderManifest} from './lib/v22d7-publish.mjs'
const json=async p=>JSON.parse(await fs.readFile(p,'utf8'))
const padded=i=>String(i).padStart(4,'0')
const statsText=(before,result,manifest)=>[
 'DAILY NEWS V22-D7 — END-TO-END READER RELEASE AUDIT',
 `Staging articles: ${before}`,
 `Publishable full articles: ${result.items.length}`,
 `Independent editorial articles: ${result.independent}`,
 `Publisher breakdown: ${JSON.stringify(result.publishers)}`,
 `Topic breakdown: ${JSON.stringify(result.topics)}`,
 `Excluded: ${JSON.stringify(result.rejected)}`,
 `Validated reader chunks: ${manifest.chunks}`,
 `READY: ${manifest.ready?'YES':'NO — previous release preserved'}`,
 'Commercial RSS links are not duplicated as full article text.',
 'Waging Nonviolence and Mongabay remain blocked until inline links and tracking are implemented.',
 'No images required. No AI/paid APIs. Deployment never occurs here.',
 'Old full-feed, world-news, and all saved Words/history remain untouched.',
].join('\n')+'\n'
export async function buildWorldReader({base=process.cwd(),now=new Date(),chunkSize=24,minReady=true}={}){
 const pilot=path.join(base,'public','world-reader-pilot','0000.json')
 const data=await json(pilot)
 if(!Array.isArray(data))throw Error('Pilot 0000.json is not an array — nothing changed')
 // Remove non-editorial photo credits BEFORE the content-quality gate.
 // Image authors remain in sourceMediaCredits inside the release.
 const result=assemblePublishable(data.map(sanitizeReadingArticle),{now})
 const manifest=makeReaderManifest(result,now,chunkSize)
 manifest.contentHash=createHash('sha256').update(JSON.stringify(result.items.map(a=>[a.sourceUrl,a.title,a.publishedAt,a.pages.map(p=>p.text),a.license]))).digest('hex')
 const report=statsText(data.length,result,manifest)
 // Report is useful even if release gate blocks new changes.
 const reports=path.join(base,'reports');await fs.mkdir(reports,{recursive:true})
 await fs.writeFile(path.join(reports,'V22D7_FINAL_REPORT.txt'),report)
 if(minReady&&!manifest.ready)return {...result,manifest,published:false}
 const output=path.join(base,'public','world-reader')
 // Do not commit a new timestamp or reset client cursors if story content is identical.
 try{
  const before=await json(path.join(output,'manifest.json'))
  if(before.ready===true&&before.contentHash===manifest.contentHash){
   return {...result,manifest:before,published:false,unchanged:true}
  }
 }catch(e){if(e.code!=='ENOENT')throw e}
 // Prepare all chunks in a temporary directory; validate them before replacing
 // any existing release. Power outages cannot leave a partial ready manifest.
 const temp=path.join(base,'public',`.world-reader-next-${process.pid}`)
 await fs.rm(temp,{recursive:true,force:true});await fs.mkdir(temp,{recursive:true})
 try{
  const copy=[]
  for(let i=0;i<manifest.chunks;i++){
   const rows=result.items.slice(i*chunkSize,(i+1)*chunkSize)
   const filename=padded(i)+'.json'
   copy.push({filename,rows})
   await fs.writeFile(path.join(temp,filename),JSON.stringify(rows)+'\n')
  }
  if(copy.reduce((n,c)=>n+c.rows.length,0)!==manifest.total)throw Error('Reader chunk integrity failure')
  await fs.writeFile(path.join(temp,'manifest.json'),JSON.stringify(manifest,null,2)+'\n')
  await fs.writeFile(path.join(temp,'status.json'),JSON.stringify({updatedAt:now.toISOString(),ready:manifest.ready,publishers:result.publishers,rejected:result.rejected},null,2)+'\n')
  // Atomic-ish directory handover with a rollback on rename failure.
  const backup=path.join(base,'public',`.world-reader-backup-${process.pid}`)
  await fs.rm(backup,{recursive:true,force:true})
  let previous=false
  try{
   try{await fs.rename(output,backup);previous=true}catch(e){if(e.code!=='ENOENT')throw e}
   await fs.rename(temp,output)
   if(previous)await fs.rm(backup,{recursive:true,force:true})
  }catch(e){if(previous)await fs.rename(backup,output);throw e}
 }finally{await fs.rm(temp,{recursive:true,force:true})}
 return {...result,manifest,published:true}
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 buildWorldReader().then(r=>console.log(`WORLD READER: ${r.items.length} stories; ${Object.keys(r.publishers).length} publishers; ready=${r.manifest.ready}; output=${r.published?'updated':'preserved'}`))
  .catch(e=>{console.error('READER RELEASE ERROR:',e.message);process.exitCode=1})
}
