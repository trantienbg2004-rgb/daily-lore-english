import fs from 'node:fs/promises'
import path from 'node:path'
import {fileURLToPath} from 'node:url'
import {readWorldRelease} from './v22d13-original-reader.mjs'
import {isMediaCredit} from '../src/lib/articleCleanup.js'
export async function verifyFinalNews({base=process.cwd()}={}){
 const rows=await readWorldRelease(base)
 if(rows.length<30)throw Error('Less than 30 verified full articles')
 const duplicate=new Set()
 for(const a of rows){
  if(duplicate.has(a.sourceUrl))throw Error('Duplicate full article')
  duplicate.add(a.sourceUrl)
  if(a.pages.some(p=>isMediaCredit(p.text)))throw Error('Standalone image credit remains in published text: '+a.sourceUrl)
 }
 let original=0
 const dir=path.join(base,'public','source-visual-reader')
 const m=JSON.parse(await fs.readFile(path.join(dir,'manifest.json'),'utf8').catch(e=>e.code==='ENOENT'?'null':Promise.reject(e)))
 if(m?.ready){
  if(m.sourcePhotosOnly!==true||m.withVerifiedPhoto<1)throw Error('Invalid source image manifest')
  for(let i=0;i<m.chunks;i++){
   const items=JSON.parse(await fs.readFile(path.join(dir,`${String(i).padStart(4,'0')}.json`),'utf8'))
   for(const a of items){
    if(!duplicate.has(a.sourceUrl))throw Error('Source visual article missing from world reader')
    for(const page of a.pages.filter(p=>p.image)){
     const match=String(page.image).match(/^\/original-reader-media\/([a-f0-9]{28}\.(?:jpg|png|webp))$/)
     if(!match||page.imageProvenance?.originArticleUrl!==a.sourceUrl)throw Error('Unproven publisher-native photo')
     await fs.access(path.join(base,'public','original-reader-media',match[1]))
    }
    original++
   }
  }
  if(original!==m.total)throw Error('Original-photo article total mismatch')
 }
 return {worldArticles:rows.length,originalPhotoArticles:original,readerReady:true}
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 verifyFinalNews().then(r=>console.log('DAILY NEWS FINAL VERIFIED:',r)).catch(e=>{console.error('FINAL VERIFICATION FAILED:',e.message);process.exitCode=1})
}
