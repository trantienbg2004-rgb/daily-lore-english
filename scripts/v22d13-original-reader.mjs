/** Publisher-native photo release. NO Wikimedia / search / substitute image.
 * Each photo must be inside the original article with explicit figure rights.
 * Empty/no-photo results NEVER replace an earlier validated release.
 */
import fs from 'node:fs/promises'
import path from 'node:path'
import {createHash} from 'node:crypto'
import {fileURLToPath} from 'node:url'
import {nativeImageCandidates,verifyNativeImageBytes,sourcePhotoName,safeFetchPublisher} from './lib/v22d13-source-images.mjs'
import {sanitizeReadingArticle} from '../src/lib/articleCleanup.js'
const pad=n=>String(n).padStart(4,'0')
const read=async name=>JSON.parse(await fs.readFile(name,'utf8'))
const exists=async p=>!!(await fs.stat(p).catch(()=>null))
export async function readWorldRelease(base=process.cwd()) {
 const dir=path.join(base,'public','world-reader'),m=await read(path.join(dir,'manifest.json'))
 if(!m.ready||m.feedType!=='news'||!Number.isInteger(m.chunks)||m.chunks<1||m.chunks>1000)throw Error('World reader not publishable')
 const rows=[]
 for(let i=0;i<m.chunks;i++){
  const part=await read(path.join(dir,pad(i)+'.json'))
  if(!Array.isArray(part))throw Error('Bad world chunk')
  rows.push(...part)
 }
 if(rows.length!==m.total)throw Error('World total/chunk mismatch')
 return rows
}
const qualified=p=>p?.imageKind==='publisher-original-verified'&&Array.isArray(p.pages)&&p.pages.some(x=>/^\/original-reader-media\/[a-f0-9]{28}\.(?:jpg|png|webp)$/.test(x.image||''))
const ownImg=(p,base)=>p.pages.filter(x=>x.image).every(x=>/^\/original-reader-media\/[a-f0-9]{28}\.(?:jpg|png|webp)$/.test(x.image||'')&&x.imageProvenance?.originArticleUrl===p.sourceUrl)
async function publishedBefore(base){
 try{
  const dir=path.join(base,'public','source-visual-reader'),m=await read(path.join(dir,'manifest.json'))
  if(!m.ready||m.feedType!=='news')return []
  const rows=[]
  for(let i=0;i<m.chunks;i++)rows.push(...await read(path.join(dir,pad(i)+'.json')))
  return rows.filter(p=>qualified(p)&&ownImg(p,base))
 }catch{return []}
}
async function swapFolder(output,files){
 const temp=`${output}-next-${process.pid}`,backup=`${output}-before-${process.pid}`
 await fs.rm(temp,{recursive:true,force:true});await fs.mkdir(temp,{recursive:true})
 try{
  for(const [name,content] of files)await fs.writeFile(path.join(temp,name),content)
  await fs.rm(backup,{recursive:true,force:true})
  let previous=false
  try{
   try{await fs.rename(output,backup);previous=true}catch(e){if(e.code!=='ENOENT')throw e}
   await fs.rename(temp,output)
   if(previous)await fs.rm(backup,{recursive:true,force:true})
  }catch(e){
   await fs.rm(output,{recursive:true,force:true})
   if(previous)await fs.rename(backup,output)
   throw e
  }
 }finally{await fs.rm(temp,{recursive:true,force:true})}
}
export async function buildOriginalPhotoReader({base=process.cwd(),fetchImpl=fetch,now=new Date(),maxArticles=36,maxNew=14,maxPhotosPerArticle=2,log=console}={}){
 const all=await readWorldRelease(base)
 const retained=await publishedBefore(base),known=new Map(retained.map(p=>[p.sourceUrl,p]))
 const mediaDir=path.join(base,'public','original-reader-media')
 await fs.mkdir(mediaDir,{recursive:true})
 let checked=0,downloaded=0,added=0
 const failures={},usedImageURLs=new Set(retained.flatMap(p=>p.pages.map(x=>x.imageProvenance?.sourceImageUrl).filter(Boolean)))
 const rejected=[]
 for(const original of all.slice(0,Math.max(0,maxArticles))){
  if(added>=maxNew)break
  if(known.has(original.sourceUrl))continue
  checked++
  const article=sanitizeReadingArticle(original)
  let html
  try{
   const response=await safeFetchPublisher(fetchImpl,article.sourceUrl,article)
   html=response.data.toString('utf8')
   if(!/html/i.test(response.mime)&&!/<(?:html|main|article)\b/i.test(html))throw Error('not-html')
  }catch(e){failures.fetch=(failures.fetch||0)+1;rejected.push(`${article.sourceUrl}: ${String(e.message||e)}`);continue}
  const photos=nativeImageCandidates(html,article,{max:maxPhotosPerArticle*4})
  if(!photos.length){failures.noExplicitPerImageRights=(failures.noExplicitPerImageRights||0)+1;continue}
  const verified=[]
  for(const photo of photos){
   if(verified.length>=maxPhotosPerArticle)break
   if(usedImageURLs.has(photo.sourceImageUrl))continue
   try{
    const response=await safeFetchPublisher(fetchImpl,photo.sourceImageUrl,article,{isImage:true})
    const ext=verifyNativeImageBytes(response.data,response.mime)
    if(!ext)throw Error('invalid-image-bytes')
    const name=`${sourcePhotoName(photo.sourceImageUrl,response.data)}.${ext}`
    if(!await exists(path.join(mediaDir,name)))await fs.writeFile(path.join(mediaDir,name),response.data)
    verified.push({...photo,localUrl:`/original-reader-media/${name}`})
    usedImageURLs.add(photo.sourceImageUrl);downloaded++
   }catch(e){failures.image=(failures.image||0)+1;rejected.push(`${article.sourceUrl}: ${String(e.message||e)}`)}
  }
  if(!verified.length)continue
  const pages=article.pages.map(p=>({...p,image:'',caption:''}))
  verified.forEach((photo,i)=>{
   const at=i===0?0:Math.max(1,Math.floor(pages.length/2))
   if(!pages[at])return
   pages[at].image=photo.localUrl
   pages[at].caption=photo.alt||'Original article image'
   pages[at].imageProvenance={originArticleUrl:article.sourceUrl,sourceImageUrl:photo.sourceImageUrl,
    credit:photo.credit,license:photo.license,rightsEvidence:photo.rightsEvidence}
  })
  known.set(article.sourceUrl,{...article,pages,image:verified[0].localUrl,imageKind:'publisher-original-verified',photoCount:verified.length})
  added++
 }
 const selected=all.map(a=>known.get(a.sourceUrl)).filter(p=>qualified(p)&&ownImg(p,base))
 const stats={checked,added,downloaded,total: selected.length,sourceCount:new Set(selected.map(p=>p.publisher)).size,failures}
 if(!selected.length){log.warn?.('No new images with explicit per-image reuse permission; text-only reader stays active.');return {...stats,ready:false,published:false}}
 const chunkSize=18,manifest={version:23,feedType:'news',ready:true,
  sourcePhotosOnly:true,withVerifiedPhoto:selected.length,sourceCount:stats.sourceCount,
  total:selected.length,chunks:Math.ceil(selected.length/chunkSize),chunkSize,
  updatedAt:now.toISOString(),contentHash:createHash('sha256').update(JSON.stringify(selected.map(p=>[p.sourceUrl,p.pages.map(x=>x.image)]))).digest('hex')}
 const out=path.join(base,'public','source-visual-reader')
 // Avoid unnecessary publish churn; still validate old media presence below.
 const old=await read(path.join(out,'manifest.json')).catch(()=>null)
 if(old?.contentHash===manifest.contentHash)return {...stats,ready:true,published:false,unchanged:true}
 const files=[]
 for(let i=0;i<manifest.chunks;i++)files.push([pad(i)+'.json',JSON.stringify(selected.slice(i*chunkSize,(i+1)*chunkSize))+'\n'])
 files.push(['manifest.json',JSON.stringify(manifest,null,2)+'\n'])
 await swapFolder(out,files)
 log.log(`ORIGINAL PHOTOS: ${selected.length} articles; ${downloaded} new pictures; no third-party image search`)
 return {...stats,ready:true,published:true}
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 buildOriginalPhotoReader().then(r=>console.log('ORIGINAL PHOTO REPORT:',JSON.stringify(r))).catch(e=>{console.error('ORIGINAL PHOTO ERROR:',e.message);process.exitCode=1})
}
