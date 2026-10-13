/** One daily-world refresh: all accepted full-article sources + publisher-native
 * images, without Commons search or any repeat/fake DN cover. Executed server-
 * side by GitHub Actions, not the reader phone or a home PC.
 */
import fs from 'node:fs/promises'
import path from 'node:path'
import {fileURLToPath} from 'node:url'
import {expandWorldReader} from './v22d4-expand.mjs'
import {expandEuropeanWorld} from './v22d5-expand.mjs'
import {collectMoreGlobalVoices} from './v22d7-collect-globalvoices.mjs'
import {buildWorldReader} from './v22d7-build-reader.mjs'
import {buildOriginalPhotoReader} from './v22d13-original-reader.mjs'
const failBrief=e=>String(e?.message||e).slice(0,180)
export async function refreshPublishedNews({base=process.cwd(),now=new Date(),offline=false,log=console,
  collectors=[
   ['Global Voices',opts=>collectMoreGlobalVoices({...opts,maxCandidates:42,maxNew:18})],
   ['GOV.UK',opts=>expandWorldReader({...opts,pages:1,perFeed:8,maxNew:28})],
   ['European Commission',opts=>expandEuropeanWorld({...opts,maxNew:16,maxCandidates:40})],
  ],buildWorld=buildWorldReader,buildPhotos=buildOriginalPhotoReader}={}){
 const results={},errors={}
 for(const [name,run] of collectors){
  if(offline){results[name]='offline-skip';continue}
  try{results[name]=await run({base,now,log})}
  catch(e){errors[name]=failBrief(e);log.warn?.(`${name} temporarily unavailable; preserve last valid release: ${errors[name]}`)}
 }
 const world=await buildWorld({base,now})
 if(world?.manifest?.ready!==true)throw Error('Refusing to replace the last ready full-article reader')
 let native={ready:false,published:false,failures:{}}
 if(!offline){
  try{native=await buildPhotos({base,now,log,maxArticles:36,maxNew:14})}
  catch(e){errors.originalImages=failBrief(e);log.warn?.(`Original article pictures unavailable; text release remains valid: ${errors.originalImages}`)}
 }
 const result={date:now.toISOString(),fullArticles:world.manifest.total,publishers:world.manifest.sourceCount,
  worldChanged:world.published,worldContentHash:world.manifest.contentHash||'',
  originalPhotoArticles:native.total||0,originalPhotosAdded:native.added||0,
  imagePolicy:'ONLY directly in the original publisher article with evidence of rights. No Commons / replacements.',
  results,errors,releaseReady:true}
 await fs.mkdir(path.join(base,'reports'),{recursive:true})
 await fs.writeFile(path.join(base,'reports','DAILY_NEWS_REFRESH_STATUS.json'),JSON.stringify(result,null,2)+'\n')
 log.log('DAILY NEWS DAILY REFRESH:',JSON.stringify({fullArticles:result.fullArticles,newWorldRelease:result.worldChanged,originalPhotoArticles:result.originalPhotoArticles,errors:Object.keys(errors)}))
 return result
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 refreshPublishedNews({offline:process.argv.includes('--offline')}).catch(e=>{console.error('DAILY NEWS AUTO REFRESH ERROR:',e.message);process.exitCode=1})
}
