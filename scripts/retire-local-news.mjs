/** Retire off-focus local news from the Reader index only after replacements exist.
 * Shards remain in Git history and in the published archive for provenance.
 */
import fs from 'node:fs/promises'
import path from 'node:path'
import {createHash} from 'node:crypto'
import {pathToFileURL} from 'node:url'
import {readCatalog} from './discover/bridge.mjs'
import {isFocusedNews} from './discover/newsFocus.mjs'
import {buildReaderIndex} from './build-reader-index.mjs'

export async function retireLocalNews({root=process.cwd(),apply=false,minimum=45}={}){
 const {dir,manifest,stories}=await readCatalog(root)
 const remove=stories.filter(story=>story.publisher==='Rhinoceros Media'&&
  !isFocusedNews({sourceId:'rhinoceros',title:story.title}))
 const remaining=stories.filter(story=>!remove.includes(story))
 const publishers=new Set(remaining.map(story=>story.publisher))
 const ready=remaining.length>=minimum&&publishers.size>=2&&publishers.has('Horizon Magazine')
 const result={ready,removed:remove.length,remaining:remaining.length,publishers:[...publishers],applied:false}
 if(!apply||!ready||!remove.length)return result
 const retiredSourceUrls=[...new Set([...(manifest.retiredSourceUrls||[]),...remove.map(story=>story.sourceUrl)])]
 const byTopic={}
 for(const story of remaining)byTopic[story.category]=(byTopic[story.category]||0)+1
 const updated={...manifest,total:remaining.length,sourceCount:publishers.size,
  withVerifiedPhoto:remaining.filter(story=>story.pages.some(page=>page.image)).length,
  byTopic,retiredSourceUrls,
  contentHash:createHash('sha256').update(JSON.stringify({previous:manifest.contentHash,retiredSourceUrls})).digest('hex'),
  updatedAt:new Date().toISOString()}
 delete updated.catalogIndexHash
 const target=path.join(dir,'manifest.json'),temp=target+'.stage-'+process.pid
 await fs.writeFile(temp,JSON.stringify(updated,null,2)+'\n')
 await fs.rename(temp,target)
 await buildReaderIndex(root)
 return {...result,applied:true}
}

if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href){
 retireLocalNews({apply:process.argv.includes('--apply')}).then(result=>{
  console.log('SAGA LOCAL RETIREMENT:',JSON.stringify(result))
  if(process.argv.includes('--apply')&&!result.ready)process.exitCode=1
 }).catch(error=>{console.error('SAGA LOCAL RETIREMENT BLOCKED:',error.message);process.exitCode=1})
}
