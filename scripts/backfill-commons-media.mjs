/** Add independently licensed, clearly labelled Commons illustrations to old news. */
import fs from 'node:fs/promises'
import path from 'node:path'
import {createHash} from 'node:crypto'
import {fileURLToPath} from 'node:url'
import {searchCommonsImage} from './discover/commonsMedia.mjs'
import {buildReaderIndex} from './build-reader-index.mjs'

const base=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..')
export async function backfillCommonsMedia({root=base,apply=false,fetchImpl=fetch,log=console}={}){
 const dir=path.join(root,'public','lore-reader')
 const manifestFile=path.join(dir,'manifest.json')
 const manifest=JSON.parse(await fs.readFile(manifestFile,'utf8'))
 if(!manifest.newsOnly||manifest.feedType!=='news')throw Error('Backfill requires the news-only release')
 const changed=[],shards=[]
 let total=0,pictured=0
 for(let n=0;n<manifest.chunks;n++){
  const file=path.join(dir,`${String(n).padStart(4,'0')}.json`)
  const stories=JSON.parse(await fs.readFile(file,'utf8'))
  let dirty=false
  for(const story of stories){
   if(story.contentType!=='news')continue
   total++
   if(story.pages?.[0]?.image){pictured++;continue}
   const photo=await searchCommonsImage(story.title,{fetchImpl})
   if(!photo)continue
   changed.push({title:story.title,file:path.basename(file),imagePageUrl:photo.provenance.imagePageUrl,license:photo.provenance.license})
   pictured++;dirty=true
   for(const level of ['A1-A2','B1-B2','C1-C2']){
    const page=story.levelVariants?.[level]?.pages?.[0]
    if(!page||page.image)throw Error(`Unexpected photo state: ${story.id} ${level}`)
    Object.assign(page,{image:photo.url,caption:photo.caption,imageProvenance:photo.provenance})
   }
   Object.assign(story.pages[0],{image:photo.url,caption:photo.caption,imageProvenance:photo.provenance})
  }
  if(dirty)shards.push({file,stories})
 }
 log.info(`Commons audit: ${changed.length} candidate photos; ${pictured}/${total} news pictured after backfill`)
 for(const item of changed)log.info(JSON.stringify(item))
 if(!apply||!changed.length)return {applied:false,changed,pictured,total}
 // Preserve every old text field and historical lore item. Manifest goes last.
 for(const {file,stories} of shards){
  const tmp=file+'.commons-stage-'+process.pid
  await fs.writeFile(tmp,JSON.stringify(stories)+'\n')
  await fs.rename(tmp,file)
 }
 const contentHash=createHash('sha256').update(JSON.stringify({previous:manifest.contentHash,photos:changed})).digest('hex')
 await fs.writeFile(manifestFile+'.commons-stage-'+process.pid,JSON.stringify({...manifest,withVerifiedPhoto:pictured,
  sourcePhotosOnly:false,contentHash,updatedAt:new Date().toISOString()},null,2)+'\n')
 await fs.rename(manifestFile+'.commons-stage-'+process.pid,manifestFile)
 await buildReaderIndex(root)
 return {applied:true,changed,pictured,total}
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 backfillCommonsMedia({apply:process.argv.includes('--apply')}).catch(error=>{console.error(error);process.exitCode=1})
}
