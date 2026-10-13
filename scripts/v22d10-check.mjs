/** Offline proof that a visual-reader release references >=50 locally present
 * licensed photographs and is usable by the browser; no network required. */
import fs from 'node:fs/promises'
import path from 'node:path'
import {fileURLToPath} from 'node:url'
import {isApprovedPhotoPath} from './lib/v22d10-licensed-images.mjs'
const read=p=>fs.readFile(p,'utf8').then(JSON.parse)
export async function checkVisualReader(base=process.cwd()){
 const dir=path.join(base,'public','visual-reader')
 const manifest=await read(path.join(dir,'manifest.json'))
 if(manifest.ready!==true||manifest.feedType!=='news'||manifest.withVerifiedPhoto<50||manifest.total!==manifest.withVerifiedPhoto)throw Error('50 image gate not satisfied')
 if(!Number.isInteger(manifest.chunks)||manifest.chunks<3||manifest.chunks>200)throw Error('invalid chunk manifest')
 const all=[]
 for(let i=0;i<manifest.chunks;i++){
  const chunk=await read(path.join(dir,`${String(i).padStart(4,'0')}.json`))
  if(!Array.isArray(chunk)||!chunk.length)throw Error('empty or invalid chunk')
  all.push(...chunk)
 }
 if(all.length!==manifest.total)throw Error('article count mismatch')
 const seenStories=new Set(),stats={},topics=new Set(),seenPhotos=new Set()
 for(const a of all){
  if(!a?.sourceUrl||seenStories.has(a.sourceUrl)||a.contentType!=='news'||a.readingKind!=='full')throw Error('invalid or duplicate article')
  seenStories.add(a.sourceUrl);stats[a.publisher]=(stats[a.publisher]||0)+1;topics.add(a.topic||a.category)
  const images=a.pages?.filter(p=>p.image)||[]
  if(!images.length||images.length>3)throw Error('article lacks verified photo')
  for(const p of images){
   if(!isApprovedPhotoPath(p.image)||!/Credits: https:\/\/commons\.wikimedia\.org\/wiki\/File:/i.test(p.caption)||!/License: (?:CC BY|CC0|Public domain|PD)/i.test(p.caption))throw Error('uncredited photo')
   const filename=p.image.slice('/world-reader-media/'.length)
   const data=await fs.stat(path.join(base,'public','world-reader-media',filename))
   if(!data.isFile()||data.size<1024||data.size>2_200_000)throw Error('missing or empty photo bytes')
   seenPhotos.add(filename)
  }
 }
 if(Object.keys(stats).length<3||(stats['Global Voices']||0)<8||topics.size<4)throw Error('insufficient journalism or topic diversity')
 return {total:all.length,photos:seenPhotos.size,publishers:stats,topics:[...topics]}
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 checkVisualReader().then(r=>console.log(`V22-D10 CHECK: READY=YES; ARTICLES_WITH_IMAGES=${r.total}; LOCAL_IMAGES=${r.photos}; SOURCES=${Object.keys(r.publishers).length}`)).catch(e=>{console.error('V22-D10 CHECK: READY=NO —',e.message);process.exitCode=1})
}
