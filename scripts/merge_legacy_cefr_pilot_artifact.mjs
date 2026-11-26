#!/usr/bin/env node
/**
 * Merge five independently CEFR-reviewed pilot stories into the working tree
 * of a review branch. This script never pushes or deploys.
 */
import path from 'node:path'
import {fileURLToPath} from 'node:url'
import {readWikiCatalog,replaceWikiStory} from './wiki/catalog.mjs'

const ROOT=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..')
const PILOT_ROOT=path.resolve(process.env.PILOT_ARTIFACT_ROOT||'')
const EXPECTED_IDS=[2034884,19098431,396412,79511869,36471858]

async function main(){
 if(!process.env.PILOT_ARTIFACT_ROOT)throw Error('PILOT_ARTIFACT_ROOT is required')
 const [pilot,before]=await Promise.all([readWikiCatalog(PILOT_ROOT),readWikiCatalog(ROOT)])
 if(pilot.stories.length!==EXPECTED_IDS.length)throw Error('Expected '+EXPECTED_IDS.length+' pilot stories; got '+pilot.stories.length)
 const pilotIds=pilot.stories.map(s=>Number(s.sourcePageId))
 if(new Set(pilotIds).size!==EXPECTED_IDS.length)throw Error('Pilot contains duplicate sourcePageIds')
 if(EXPECTED_IDS.some(id=>!pilotIds.includes(id)))throw Error('Pilot is missing one or more expected sourcePageIds')
 if(before.stories.length!==36)throw Error('Expected the reviewed 36-story production baseline; got '+before.stories.length)

 const beforeById=new Map(before.stories.map(s=>[Number(s.sourcePageId),s]))
 for(const story of pilot.stories){
  const id=Number(story.sourcePageId)
  const existing=beforeById.get(id)
  if(!existing)throw Error('Cannot replace unknown published pageId '+id)
  if(!story.levelVariants||!['A1-A2','B1-B2','C1-C2'].every(level=>Array.isArray(story.levelVariants[level]?.pages))){
   throw Error('Pilot story is missing one or more CEFR variants: '+story.sourceTitle)
  }
  const counts=['A1-A2','B1-B2','C1-C2'].map(level=>story.levelVariants[level].pages.length)
  if(new Set(counts).size!==1||counts[0]<4||counts[0]>6)throw Error('Pilot CEFR page counts do not match: '+story.sourceTitle)
  // Keep the existing canonical article URL; replaceWikiStory preserves the existing story id.
  story.sourceUrl=existing.sourceUrl
  const result=await replaceWikiStory(ROOT,story)
  console.log('[CEFR-REPAIR-MERGE] '+JSON.stringify({
   sourcePageId:id,
   sourceTitle:story.sourceTitle,
   pageCount:counts[0],
   sourceRevisionId:story.sourceRevisionId,
   regeneratedAt:story.regeneratedAt,
   shard:result.shard
  }))
 }
 const after=await readWikiCatalog(ROOT)
 if(after.stories.length!==before.stories.length)throw Error('Catalog total changed unexpectedly')
 const replaced=new Set(EXPECTED_IDS)
 for(const oldStory of before.stories){
  if(replaced.has(Number(oldStory.sourcePageId)))continue
  const current=after.stories.find(s=>s.sourcePageId===oldStory.sourcePageId)
  if(!current||JSON.stringify(current)!==JSON.stringify(oldStory))throw Error('An untouched story changed: '+oldStory.sourceTitle)
 }
 for(const id of EXPECTED_IDS){
  const story=after.stories.find(s=>Number(s.sourcePageId)===id)
  if(!story?.regeneratedAt)throw Error('Replacement marker missing for pageId '+id)
 }
 console.log('[CEFR-REPAIR-MERGE-SUMMARY] '+JSON.stringify({
  replaced:EXPECTED_IDS.length,
  catalogTotal:after.stories.length,
  untouchedStoriesVerified:after.stories.length-EXPECTED_IDS.length,
  catalogIndex:after.manifest.catalogIndex,
  contentHash:after.manifest.contentHash
 }))
}

main().catch(error=>{
 console.error('[CEFR-REPAIR-MERGE-FATAL] '+String(error?.message||error))
 process.exitCode=1
})
