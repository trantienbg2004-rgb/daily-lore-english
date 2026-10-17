/** Editorially reviewed, short headlines for the existing news release. */
import fs from 'node:fs/promises'
import path from 'node:path'
import {createHash} from 'node:crypto'
import {fileURLToPath} from 'node:url'
import {validatedNewsHeadline} from './discover/headline.mjs'
import {buildReaderIndex} from './build-reader-index.mjs'

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..')
const headlines={
 'saga:imf-weo-2026-october':'IMF warns global growth remains uneven',
 'saga:un-security-council-2026-10-15':'UN discusses violence in Gaza and West Bank',
 'saga:un-sudan-dialogue-20261016':'UN urges talks as Sudan fighting intensifies',
 'saga:wbg-japan-energy-asia-20261015':'World Bank and Japan announce Asia energy project',
 'saga:nepal-world-bank-cat-bond-20261015':'Nepal weighs World Bank earthquake bond',
 'saga:imf-ai-global-economy-forum-20261016':'IMF examines AI and the global economy',
 'saga-news:04b045c50f3974aafc6bdbdf':'Hoax falsely links Brazil’s Lula to child abuse',
 'saga-news:5671bbde35b632a5b6667de8':'Peru Indigenous communities confront Amazon fires',
 'saga-news:8002e77bdcfaa28419f131ea':'Authoritarian states expand surveillance market',
 'saga-news:6f87a799a62e2aa671403732':'Telenor faces Myanmar data lawsuit',
 'saga-news:a3fe88508a659675e79dafc0':'Nepal seeks clearer flood aid and rebuilding plan',
 'saga-news:5c60d15b568bd196260fcb22':'Chabacano poetry book celebrates Philippine language',
 'saga-news:cb2efe1cee545ca1fcad5d1d':'Bangladesh–Malaysia recruitment costs face scrutiny',
 'saga-news:a3f9a58e68bc3a8e97167289':'Ukrainian small businesses survive years of war',
 'saga-news:e2c1802a9ffac04433d4fab2':'Haiti vendors protest gang warfare',
}
export async function backfillNewsHeadlines({base=root,apply=false,log=console}={}){
 const dir=path.join(base,'public','lore-reader'),manifestFile=path.join(dir,'manifest.json')
 const manifest=JSON.parse(await fs.readFile(manifestFile,'utf8'))
 if(!manifest.newsOnly)throw Error('Short headlines require a news-only catalog')
 const shards=[],changed=[]
 for(let n=0;n<manifest.chunks;n++){
  const file=path.join(dir,`${String(n).padStart(4,'0')}.json`),stories=JSON.parse(await fs.readFile(file,'utf8'))
  let dirty=false
  for(const story of stories){
   if(story.contentType!=='news'||!headlines[story.id])continue
   const headline=headlines[story.id],sourceTitle=story.sourceTitle||story.title
   if(validatedNewsHeadline(headline,sourceTitle)!==headline)throw Error(`Headline needs review: ${story.id}`)
   if(story.headline===headline)continue
   story.headline=headline;changed.push({id:story.id,headline});dirty=true
  }
  if(dirty)shards.push({file,stories})
 }
 log.info(`Reviewed short headlines: ${changed.length} changed`)
 if(!apply||!changed.length)return {applied:false,changed}
 for(const {file,stories} of shards){const tmp=file+'.headline-stage-'+process.pid;await fs.writeFile(tmp,JSON.stringify(stories)+'\n');await fs.rename(tmp,file)}
 const contentHash=createHash('sha256').update(JSON.stringify({previous:manifest.contentHash,headlines:changed})).digest('hex')
 const next={...manifest,contentHash,updatedAt:new Date().toISOString()}
 const tmp=manifestFile+'.headline-stage-'+process.pid
 await fs.writeFile(tmp,JSON.stringify(next,null,2)+'\n');await fs.rename(tmp,manifestFile)
 await buildReaderIndex(base)
 return {applied:true,changed}
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 backfillNewsHeadlines({apply:process.argv.includes('--apply')}).catch(e=>{console.error(e);process.exitCode=1})
}
