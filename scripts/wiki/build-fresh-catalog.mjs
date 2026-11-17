/** Build and publish a completely fresh, verified >=200-story Wikipedia catalog from candidate & draft pools. */
import fs from 'node:fs/promises'
import path from 'node:path'
import {fileURLToPath} from 'node:url'
import {validateWikiDraft} from './editor.mjs'
import {assignWikipediaPhotos} from './media.mjs'
import {makeWikiStory,appendWikiStories,WIKI_TARGET_STORIES,WIKI_TARGET_PER_TOPIC} from './catalog.mjs'
import {WIKI_TOPICS} from './discovery.mjs'
import {auditWikiCatalog} from './audit.mjs'
import {verifyWikiRelease} from '../build-reader-index.mjs'

const base=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..')
const CANDIDATE_DIR=process.env.SAGA_CANDIDATES_DIR||'/tmp/wiki-candidates'
const DRAFT_DIR=process.env.SAGA_DRAFTS_DIR||'/tmp/wiki-drafts'

async function main(){
 const publish=process.argv.includes('--publish')
 const files=(await fs.readdir(DRAFT_DIR)).filter(f=>f.endsWith('.json')).sort()
 const usedUrls=new Set()
 const stories=[]
 const sourcesByPageId=new Map()
 const skipped=[]

 for(const file of files){
  const draft=JSON.parse(await fs.readFile(path.join(DRAFT_DIR,file),'utf8'))
  const candPath=path.join(CANDIDATE_DIR,`${draft.pageId}.json`)
  const cand=JSON.parse(await fs.readFile(candPath,'utf8'))
  const {source,evidence,rights,topic}=cand
  const val=validateWikiDraft(draft,{source,topic,evidence})
  if(!val.accepted){skipped.push({pageId:draft.pageId,stage:'validateWikiDraft',errors:val.errors});continue}
  const assigned=assignWikipediaPhotos(rights,source,draft.variants,{usedUrls})
  if(assigned.status!=='VERIFIED'){skipped.push({pageId:draft.pageId,stage:'assignWikipediaPhotos',reason:assigned.reason});continue}
  for(const p of assigned.photos){usedUrls.add(p.url);if(p.provenance?.imagePageUrl)usedUrls.add(p.provenance.imagePageUrl)}
  const storyEvidence=evidence.map(({id,heading,hash,text,excerpt})=>({id,heading,hash,excerpt:excerpt||String(text||'').slice(0,140)}))
  const story=makeWikiStory({source,topic,draft:{variants:assigned.levelVariants},photos:assigned.photos,evidence:storyEvidence})
  stories.push(story)
  sourcesByPageId.set(source.pageId,source)
 }

 const audit=auditWikiCatalog(stories,{sourcesByPageId,targetStories:WIKI_TARGET_STORIES,targetPerTopic:WIKI_TARGET_PER_TOPIC})
 console.log(JSON.stringify({
  drafts:files.length,
  built:stories.length,
  skippedCount:skipped.length,
  skippedSample:skipped.slice(0,10),
  audit:{
   passed:audit.passed,
   total:audit.total,
   failed:audit.failed,
   targetMet:audit.targetMet,
   byTopic:audit.byTopic,
   uniqueImages:audit.uniqueImages,
   failuresSample:audit.failures.slice(0,10),
  }
 },null,2))

 if(!audit.passed){
  throw Error(`Fresh catalog audit failed: total=${audit.total}, failed=${audit.failed}, targetMet=${audit.targetMet}`)
 }
 if(publish){
  const pubDir=path.join(base,'public','wiki-reader')
  await fs.rm(pubDir,{recursive:true,force:true})
  const res=await appendWikiStories(base,stories)
  const release=await verifyWikiRelease(base)
  console.log('PUBLISHED FRESH CATALOG:',JSON.stringify({...res,release}))
 }
}

main().catch(e=>{console.error(e);process.exitCode=1})
