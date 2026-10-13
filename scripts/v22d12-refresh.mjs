/** D12 scheduled content refresh — no paid API, no browser-side scraping.
 * Existing published releases survive outages, licence failures and an
 * insufficient photo set. Only source-content changes trigger photo updates.
 */
import fs from 'node:fs/promises'
import path from 'node:path'
import {createHash} from 'node:crypto'
import {fileURLToPath} from 'node:url'
import {completeWorldReader} from './v22d7-complete.mjs'
import {buildPhotoReader} from './v22d10-build-photo-reader.mjs'
import {checkVisualReader} from './v22d10-check.mjs'

const readJSON = async name => JSON.parse(await fs.readFile(name,'utf8'))
export async function fingerprintWorldReader(base=process.cwd()) {
 const dir=path.join(base,'public','world-reader')
 const manifest=await readJSON(path.join(dir,'manifest.json'))
 if(!manifest?.ready||manifest.feedType!=='news'||!Number.isInteger(manifest.chunks)||manifest.chunks<1)throw Error('No validated world reader')
 const hash=createHash('sha256')
 for(let i=0;i<manifest.chunks;i++){
  const rows=await readJSON(path.join(dir,`${String(i).padStart(4,'0')}.json`))
  if(!Array.isArray(rows))throw Error('Invalid world reader chunk')
  for(const row of rows){
   hash.update(JSON.stringify([row.sourceUrl,row.publishedAt,row.title,row.license,(row.pages||[]).map(p=>p.text)]))
   hash.update('\n')
  }
 }
 return hash.digest('hex')
}
export async function refreshWorldAndPhotos({base=process.cwd(),offline=false,log=console,worldUpdate=completeWorldReader,photoUpdate=buildPhotoReader,photoCheck=checkVisualReader}={}){
 const world=await worldUpdate({base,offline,log})
 if(!world.built?.manifest?.ready)throw Error('World reader not ready — preserving existing release')
 const fingerprint=await fingerprintWorldReader(base)
 const stamp=path.join(base,'public','visual-reader','d12-input.sha256')
 const previous=await fs.readFile(stamp,'utf8').catch(e=>{if(e.code==='ENOENT')return '';throw e})
 let validVisual=false
 try{await photoCheck(base);validVisual=true}catch(e){log.warn?.('Visual reader not yet ready: '+e.message)}
 let photos='unchanged'
 if(!validVisual || previous.trim()!==fingerprint){
  try {
   const result=await photoUpdate({base,log})
   if(result.ready){await photoCheck(base);await fs.writeFile(stamp,fingerprint+'\n');photos='updated'}
   else {photos='preserved-old-release';log.warn?.('Photo threshold not met; previous illustrated reader is preserved')}
  }catch(e){photos='preserved-old-release';log.warn?.('Photo service unavailable, preserving verified articles: '+e.message)}
 }
 const report={worldArticles:world.built.manifest.total,worldUpdated:world.built.published,
   worldSources:world.built.manifest.sourceCount,independentNew:world.collected?.added||0,photos,fingerprint,
   newsRefresh:'scheduled publishing requires committing the generated public files'}
 await fs.mkdir(path.join(base,'reports'),{recursive:true})
 await fs.writeFile(path.join(base,'reports','V22D12_REFRESH_REPORT.json'),JSON.stringify(report,null,2)+'\n')
 log.log('D12 REFRESH:',JSON.stringify(report))
 return report
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 refreshWorldAndPhotos({offline:process.argv.includes('--offline')}).catch(e=>{console.error('D12 REFRESH FAILED:',e.message);process.exitCode=1})
}
