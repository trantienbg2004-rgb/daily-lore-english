/** One-command editorial library publisher. No synthetic articles. No paid AI.
 * Never changes the last good release on a network or QA failure.
 */
import fs from 'node:fs/promises'
import path from 'node:path'
import {createHash} from 'node:crypto'
import {fileURLToPath} from 'node:url'
import {CURATED_TOPICS,scheduledTopics,TOPIC_CATEGORIES} from './lore/topics.mjs'
import {collectWikipediaTopic} from './lore/wiki.mjs'
import {editorialGate} from './lore/editorial.mjs'
import {loadProgress,saveProgress,chooseTopics,markDecision,keyFor} from './lore/state.mjs'
const hash=any=>createHash('sha256').update(JSON.stringify(any)).digest('hex')
const exists=async p=>fs.access(p).then(()=>true,()=>false)
export async function readExisting(base){
 const dir=path.join(base,'public/lore-reader'),file=path.join(dir,'manifest.json')
 if(!await exists(file))return []
 const manifest=JSON.parse(await fs.readFile(file,'utf8'))
 if(!manifest.ready||manifest.feedType!=='lore'||manifest.editorialVersion!==1)throw Error('Existing lore manifest invalid; not overwriting')
 const chunks=[]
 for(let i=0;i<manifest.chunks;i++){
  const part=JSON.parse(await fs.readFile(path.join(dir,`${String(i).padStart(4,'0')}.json`),'utf8'))
  if(!Array.isArray(part))throw Error('Corrupt existing lore chunk')
  chunks.push(...part)
 }
 if(chunks.length!==manifest.total||chunks.some(s=>!editorialGate(s).accepted))throw Error('Existing lore publication does not pass quality gates')
 return chunks
}
export async function publishLibrary({base=process.cwd(),stories=[],now=new Date(),minStories=15}={}){
 const approved=[...new Map(stories.filter(x=>editorialGate(x).accepted).map(x=>[x.id,x])).values()]
 const byTopic=Object.fromEntries(TOPIC_CATEGORIES.map(x=>[x,approved.filter(p=>p.category===x).length]))
 const manifest={feedType:'lore',editorialVersion:1,ready:approved.length>=minStories,total:approved.length,chunks:Math.ceil(approved.length/20),sourceCount:1,
  withVerifiedPhoto:approved.filter(p=>p.pages.some(x=>x.image)).length,sourcePhotosOnly:true,byTopic,
  contentHash:hash(approved.map(x=>[x.id,x.sourceRevisionId,x.pages])),updatedAt:now.toISOString(),licenseNotice:'CC BY-SA 4.0 text; per-image Commons credits in article'}
 if(!manifest.ready)return {published:false,manifest,reason:`only ${approved.length} approved articles; minimum ${minStories}`}
 const out=path.join(base,'public/lore-reader')
 if(await exists(path.join(out,'manifest.json'))){
  const old=JSON.parse(await fs.readFile(path.join(out,'manifest.json'),'utf8'))
  if(old.ready&&old.contentHash===manifest.contentHash)return {published:false,unchanged:true,manifest:old}
 }
 const temp=path.join(base,'public',`.lore-reader-stage-${process.pid}`),backup=path.join(base,'public',`.lore-reader-backup-${process.pid}`)
 await fs.rm(temp,{recursive:true,force:true});await fs.mkdir(temp,{recursive:true});await fs.rm(backup,{recursive:true,force:true})
 try{
  for(let i=0;i<manifest.chunks;i++)await fs.writeFile(path.join(temp,`${String(i).padStart(4,'0')}.json`),JSON.stringify(approved.slice(i*20,(i+1)*20))+'\n')
  await fs.writeFile(path.join(temp,'manifest.json'),JSON.stringify(manifest,null,2)+'\n')
  let moved=false
  try{
   if(await exists(out)){await fs.rename(out,backup);moved=true}
   await fs.rename(temp,out)
   if(moved)await fs.rm(backup,{recursive:true,force:true})
  }catch(e){if(moved){await fs.rm(out,{recursive:true,force:true});await fs.rename(backup,out)}throw e}
 }finally{await fs.rm(temp,{recursive:true,force:true})}
 return {published:true,manifest}
}
export async function collectLore({base=process.cwd(),now=new Date(),fetchImpl=fetch,limit=140,log=console,collector=collectWikipediaTopic}={}){
 const before=await readExisting(base)
 const ids=new Set(before.map(s=>s.sourceTitle?.toLowerCase()||s.title.toLowerCase()))
 const existingKeys=new Set(before.map(s=>keyFor({category:s.category,title:s.sourceTitle||s.title})))
 const state=await loadProgress(base)
 const choices=chooseTopics(scheduledTopics({index:0,count:CURATED_TOPICS.length}),state,existingKeys,now,limit)
 const collected=[],rejected={},errors=[]
 let attempted=0,rateLimited=false
 // Intentionally sequential: Wikimedia's shared GitHub Actions IP may be
 // throttled; parallel requests amplify 429 and cannot increase real supply.
 for(const topic of choices.topics){
  attempted++
  try{
   const result=await collector(topic,{fetchImpl,now})
   if(result.story){
    const key=result.story.sourceTitle.toLowerCase()
    if(!ids.has(key)){ids.add(key);collected.push(result.story)}
   }else rejected[result.reason||'unspecified']=(rejected[result.reason||'unspecified']||0)+1
   markDecision(state,topic,result,now)
  }catch(e){
   const reason=String(e?.message||e).slice(0,120)
   errors.push(`${topic.title}: ${reason}`)
   // Stop immediately when Wikimedia asks us to slow down. Other topics stay
   // eligible on the next scheduled run rather than being falsely rejected.
   if(e?.rateLimited||/HTTP 429/.test(reason)){rateLimited=true;break}
  }
 }
 // The cursor is advanced only past the actually attempted topic. A stopped
 // batch never silently skips the rest of the selected entries.
 const allTopics=scheduledTopics({index:0,count:CURATED_TOPICS.length})
 if(attempted){
  const last=choices.topics[attempted-1]
  const index=allTopics.findIndex(t=>keyFor(t)===keyFor(last))
  state.cursor=index<0?choices.cursor:(index+1)%allTopics.length
 }else state.cursor=choices.cursor
 const all=[...before,...collected]
 const output=await publishLibrary({base,stories:all,now})
 await saveProgress(base,state)
 const report={date:now.toISOString(),catalogTopics:allTopics.length,candidateCount:choices.topics.length,attempted,
  deferred:choices.skipped,rateLimited,previous:before.length,added:collected.length,total:all.length,
  published:output.published,unchanged:!!output.unchanged,reason:output.reason||'',rejected,
  errors:errors.slice(0,20),byTopic:output.manifest.byTopic,withVerifiedPhoto:output.manifest.withVerifiedPhoto}
 await fs.mkdir(path.join(base,'reports'),{recursive:true})
 await fs.writeFile(path.join(base,'reports/DAILY_LORE_QUALITY_REPORT.json'),JSON.stringify(report,null,2)+'\n')
 log.log('DAILY LORE RELEASE:',JSON.stringify(report))
 if(!output.manifest.ready)throw Error(`Quality gate blocks release: ${report.total} accepted stories, need >=15. See quality report.`)
 return report
}

if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 const limitArg=process.argv.find(x=>x.startsWith('--limit=')),limit=limitArg?Number(limitArg.slice(8)):140
 collectLore({limit:Number.isSafeInteger(limit)&&limit>0?limit:140}).catch(e=>{console.error('DAILY LORE INGEST ERROR:',e.message);process.exitCode=1})
}
