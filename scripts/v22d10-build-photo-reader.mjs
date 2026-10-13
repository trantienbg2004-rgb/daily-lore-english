/** DAILY NEWS V22-D10: user-initiated creation of an image-complete world reader.
 * Do not promote ANY new feed unless >=50 unique, licensed, downloaded photographs
 * accompany >=50 quality-checked full articles. Old reader remains available.
 * No paid API, no fake photos, no third-party publisher image scraping.
 */
import fs from 'node:fs/promises'
import path from 'node:path'
import {fileURLToPath,pathToFileURL} from 'node:url'
import {assessPublishable,assemblePublishable} from './lib/v22d7-publish.mjs'
import {imageQueries,commonsSearchUrl,pickCommonsPhotos,placePhotos,imageDigest} from './lib/v22d10-licensed-images.mjs'

const json=async p=>JSON.parse(await fs.readFile(p,'utf8'))
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms))
const pad=n=>String(n).padStart(4,'0')
const htmlSafe=s=>String(s||'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','\"':'&quot;',"'":'&#39;'}[c]))
const metrics=articles=>{
 const publishers={},topics={}
 for(const a of articles){publishers[a.publisher]=(publishers[a.publisher]||0)+1;topics[a.topic||a.category||'World']=(topics[a.topic||a.category||'World']||0)+1}
 return {publishers,topics}
}
function orderForPictures(articles){
 const queues=new Map()
 for(const a of articles){if(!queues.has(a.publisher))queues.set(a.publisher,[]);queues.get(a.publisher).push(a)}
 for(const q of queues.values())q.sort((a,b)=>Date.parse(b.publishedAt||0)-Date.parse(a.publishedAt||0))
 const names=['Global Voices','European Commission','GOV.UK',...queues.keys()].filter((v,i,a)=>a.indexOf(v)===i)
 const result=[]
 while([...queues.values()].some(q=>q.length)){
  for(const name of names){const q=queues.get(name);if(q?.length)result.push(q.shift())}
 }
 return result
}
async function guardedFetch(fetchImpl,url,{timeoutMs=11000,headers={},kind='api'}={}){
 const allowed=kind==='api'?['commons.wikimedia.org']:['upload.wikimedia.org','thumb.wikimedia.org']
 let u=new URL(url)
 if(u.protocol!=='https:'||!allowed.includes(u.hostname)||u.port||u.username||u.password)throw Error('unapproved-fetch-host')
 const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),timeoutMs)
 try{
  const response=await fetchImpl(url,{signal:controller.signal,redirect:'follow',headers:{'User-Agent':'DailyNews/22D10 (photo license verification; https://github.com/trantienbg2004-rgb/daily-lore-english)',Accept:kind==='api'?'application/json':'image/avif,image/webp,image/jpeg,image/png',...headers}})
  if(response.url){u=new URL(response.url);if(u.protocol!=='https:'||!allowed.includes(u.hostname))throw Error('unexpected-photo-redirect')}
  if(!response.ok)throw Error(`HTTP ${response.status}`)
  const max=kind==='api'?2_000_000:2_200_000
  if(Number(response.headers?.get?.('content-length')||0)>max)throw Error('oversized-response')
  const data=Buffer.from(await response.arrayBuffer())
  if(data.length>max)throw Error('oversized-response')
  return {data,contentType:response.headers?.get?.('content-type')||''}
 }finally{clearTimeout(timer)}
}
export function verifyImageBytes(data,contentType){
 if(!Buffer.isBuffer(data)||data.length<1024||data.length>2_200_000)return ''
 const isJpeg=data[0]===255&&data[1]===216&&data[2]===255
 const isPng=data.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]))
 const isWebp=data.toString('ascii',0,4)==='RIFF'&&data.toString('ascii',8,12)==='WEBP'
 if(isJpeg&&/image\/jpeg/i.test(contentType))return 'jpg'
 if(isPng&&/image\/png/i.test(contentType))return 'png'
 if(isWebp&&/image\/webp/i.test(contentType))return 'webp'
 return ''
}
export function cleanLeadingCredit(article){
 const pages=article.pages.map(p=>({...p})),head=pages[0]?.text||''
 // Only indisputable media attribution lines are moved; never remove prose
 // if this punctuation boundary is uncertain. Original article is linked.
 const match=head.match(/^(?:Image|Photograph|Photo|Screenshot|Screenshots) (?:by|via|courtesy of|from) [^.]{5,140}\.\s*/i)
 // Editorial captions such as 'Demonstrations in the Sahel: (left) Mali ...
 // Screenshots via YouTube.' must not masquerade as the opening paragraph.
 const gallery=head.match(/^.{12,235}?\b(?:Screenshots?|Photos?|Images?) (?:via|by|courtesy of) (?:YouTube|Wikimedia Commons|Facebook|Instagram)[^.]{0,65}\.\s*/i)
 const credit=(match||gallery)?.[0]
 if(credit){
  const remainder=head.slice(credit.length).trim()
  if(remainder.split(/\s+/).length>=8)pages[0].text=remainder
  else if(pages.length>2)pages.shift()
  else return {...article,pages}
  return {...article,pages,sourceMediaCredit:credit.trim()}
 }
 return {...article,pages}
}
async function oldReader(base){
 const dir=path.join(base,'public','world-reader'),m=await json(path.join(dir,'manifest.json'))
 if(m.ready!==true||m.feedType!=='news'||m.total<50||m.chunks<1||m.chunks>400)throw Error('Verified V22-D7 world reader not ready; old feed unchanged')
 const rows=[]
 for(let i=0;i<m.chunks;i++){
  const chunk=await json(path.join(dir,`${pad(i)}.json`))
  if(!Array.isArray(chunk))throw Error(`Corrupt existing chunk ${i}`)
  rows.push(...chunk)
 }
 if(rows.length!==m.total)throw Error('Existing world reader count mismatch')
 const clean=assemblePublishable(rows,{now:new Date(),max:2000})
 if(clean.items.length<50)throw Error('Fewer than 50 licensed articles in existing reader')
 return {articles:orderForPictures(clean.items),checked:clean.rejected}
}
async function snapshotDir(base,dirName,files){
 const target=path.join(base,'public',dirName),temp=path.join(base,'public',`.${dirName}-temp-${process.pid}`),backup=path.join(base,'public',`.${dirName}-backup-${process.pid}`)
 await fs.rm(temp,{force:true,recursive:true});await fs.mkdir(temp,{recursive:true})
 try{
  for(const [name,value] of files)await fs.writeFile(path.join(temp,name),value)
  await fs.rm(backup,{force:true,recursive:true});let renamed=false
  try{
   try{await fs.rename(target,backup);renamed=true}catch(e){if(e.code!=='ENOENT')throw e}
   await fs.rename(temp,target)
   if(renamed)await fs.rm(backup,{force:true,recursive:true})
  }catch(e){if(renamed)await fs.rename(backup,target);throw e}
 }finally{await fs.rm(temp,{force:true,recursive:true})}
}
const sortBalanced=(items)=>{
 const q=new Map();for(const a of items){if(!q.has(a.publisher))q.set(a.publisher,[]);q.get(a.publisher).push(a)}
 const names=['Global Voices','European Commission','GOV.UK'];const ordered=[]
 while([...q.values()].some(v=>v.length))for(const n of names)if(q.get(n)?.length)ordered.push(q.get(n).shift())
 return ordered
}
export async function buildPhotoReader({base=process.cwd(),fetchImpl=fetch,now=new Date(),minArticles=50,targetArticles=58,maxChecks=180,maxPhotos=2,apiDelayMs=450,maxDurationMs=6*60_000,log=console}={}){
 if(minArticles<50)throw Error('Cannot weaken 50-photo-article quality gate')
 if(targetArticles<minArticles)throw Error('target must be >= minimum')
 const startedAt=Date.now()
 const existing=await oldReader(base)
 const articles=existing.articles,limit=Math.min(articles.length,maxChecks),good=[],rejected={},lookups={},used=new Set(),usedSource=new Set(),downloads=new Map()
 const mediaDir=path.join(base,'public','world-reader-media'),reportDir=path.join(base,'reports')
 await fs.mkdir(reportDir,{recursive:true})
 const stagedMedia=path.join(base,'public',`.world-reader-media-temp-${process.pid}`)
 await fs.rm(stagedMedia,{recursive:true,force:true});await fs.mkdir(stagedMedia,{recursive:true})
 let apiCalls=0,downloaded=0,cacheHits=0,checked=0
 const reject=reason=>{rejected[reason]=(rejected[reason]||0)+1}
 try {
  for(const article of articles.slice(0,limit)){
   if(good.length>=targetArticles)break
   if(Date.now()-startedAt>maxDurationMs){reject('total-runtime-budget-reached');break}
   checked++
   if(assessPublishable(article,{now})){reject('original-article-not-publishable');continue}
   const queries=imageQueries(article)
   if(!queries.length){reject('no-safe-photo-query');continue}
   const photos=[]
   for(const query of queries.slice(0,3)){
    if(photos.length>=maxPhotos)break
    if(Date.now()-startedAt>maxDurationMs){reject('total-runtime-budget-reached');break}
    let body
    try{
     const request=commonsSearchUrl(query,{limit:10})
     if(lookups[query])body=lookups[query]
     else{
      let res
      for(let attempt=0;attempt<3;attempt++){
       try{res=await guardedFetch(fetchImpl,request,{kind:'api'});break}
       catch(e){if(!/HTTP 429|HTTP 503/.test(String(e.message||e))||attempt===2)throw e;await pause(1400*(attempt+1))}
      }
      body=JSON.parse(res.data.toString('utf8'))
      lookups[query]=body;apiCalls++
      if(apiDelayMs)await pause(apiDelayMs)
     }
    }catch(e){reject('commons-api:'+String(e.message||e).slice(0,45));continue}
    const selected=pickCommonsPhotos(body,{query,used:usedSource,limit:Math.min(4,maxPhotos*2)}).photos
    for(const photo of selected){
     if(photos.length>=maxPhotos||usedSource.has(photo.source))break
     const key=imageDigest(`${photo.source}|${photo.url}`),cached=downloads.get(key)
     let extension='',filename=''
     if(cached){extension=cached.extension;filename=cached.filename;cacheHits++}
     else{
      try{
       const data=await guardedFetch(fetchImpl,photo.url,{kind:'photo',timeoutMs:14000})
       extension=verifyImageBytes(data.data,data.contentType)
       if(!extension){reject('image-bytes-invalid');continue}
       filename=`${key}.${extension}`
       await fs.writeFile(path.join(stagedMedia,filename),data.data)
       downloads.set(key,{filename,extension});downloaded++
      }catch(e){reject('photo-download:'+String(e.message||e).slice(0,45));continue}
     }
     photos.push({...photo,localUrl:`/world-reader-media/${filename}`})
     usedSource.add(photo.source)
    }
   }
   if(photos.length){
    good.push(placePhotos(cleanLeadingCredit(article),photos))
   }else reject('no-licensed-relevant-working-image')
   if(checked%10===0||good.length===targetArticles)log.log(`PHOTOS: checked ${checked}/${limit}, ready ${good.length}/${minArticles}, api ${apiCalls}, downloaded ${downloaded}`)
  }
  // The full reader must contain at least 50 articles, at least 3 original
  // editorial publishers, meaningful independent voice & subject diversity.
  const ordered=sortBalanced(good),counts=metrics(ordered)
  const highest=Math.max(...Object.values(counts.publishers),0)
  const independent=counts.publishers['Global Voices']||0
  const ready=ordered.length>=minArticles&&Object.keys(counts.publishers).length>=3&&Object.keys(counts.topics).length>=4&&independent>=8&&highest/ordered.length<=0.7
  const report={version:'V22-D10',checked,photosDownloaded:downloaded,photoCacheHits:cacheHits,apiCalls,qualifiedWithPhoto:ordered.length,required:minArticles,elapsedSeconds:Math.round((Date.now()-startedAt)/1000),publishers:counts.publishers,topics:counts.topics,independent,mostDominantShare:ordered.length?+(highest/ordered.length).toFixed(3):0,rejected,ready,sourceArticles:articles.length,notes:['Every photo has per-file license metadata, creator and Commons description URL','All photos are marked contextual, NOT evidence from the particular news event','Only verified photographic image bytes are included; no broken hotlinks or placeholder cards','Old world reader and all saved Words/history remain untouched']}
  await fs.writeFile(path.join(reportDir,'V22D10_50_IMAGE_REPORT.json'),JSON.stringify(report,null,2)+'\n')
  await fs.writeFile(path.join(reportDir,'V22D10_50_IMAGE_REPORT.txt'),[
   'DAILY NEWS V22-D10: 50 REAL IMAGE ARTICLES QUALITY GATE',
   `Checked: ${checked} / ${articles.length}`,
   `QUALIFIED WITH LICENSED DOWNLOADED PHOTO: ${ordered.length}; minimum required: ${minArticles}`,
   `Photo files downloaded: ${downloaded}; API requests: ${apiCalls}`,
   `Publishers: ${JSON.stringify(counts.publishers)}`,
   `Topics: ${JSON.stringify(counts.topics)}`,
   `Rejected: ${JSON.stringify(rejected)}`,
   `READY: ${ready?'YES':'NO — PREVIOUS READER PRESERVED'}`,
   'Photos are verified contextual illustrations; they do not purport to be images of the specific breaking-news event.',
   'No unrelated copyrighted newspaper images copied. Read exact attribution and terms in article credits.',
   'Deployment must be separately approved by the project owner.',
  ].join('\n')+'\n')
  if(!ready){log.warn?.(`IMAGE READER NOT READY: only ${ordered.length} valid illustrated articles or sources/topics quota not met; existing feed preserved.`);return report}
  // Move verified downloaded bytes first; never delete old media on refresh.
  await fs.mkdir(mediaDir,{recursive:true})
  for(const [,{filename}] of downloads){
   const from=path.join(stagedMedia,filename),to=path.join(mediaDir,filename)
   if(!await fs.stat(to).catch(()=>null))await fs.copyFile(from,to)
  }
  const chunkSize=20,files=[]
  for(let i=0;i<ordered.length;i+=chunkSize)files.push([`${pad(i/chunkSize)}.json`,JSON.stringify(ordered.slice(i,i+chunkSize))+'\n'])
  const manifest={version:22,stage:'V22-D10 50 licensed contextual image articles',feedType:'news',contentPolicy:'article-and-individual-photo-license-verified',updatedAt:now.toISOString(),total:ordered.length,chunks:files.length,chunkSize,sourceCount:Object.keys(counts.publishers).length,independentCount:independent,withVerifiedPhoto:ordered.length,ready:true,readerReady:true}
  files.push(['manifest.json',JSON.stringify(manifest,null,2)+'\n'])
  files.push(['status.json',JSON.stringify({ready:true,publishers:counts.publishers,topics:counts.topics,images:ordered.reduce((n,a)=>n+a.photoCount,0),updatedAt:now.toISOString()},null,2)+'\n'])
  await snapshotDir(base,'visual-reader',files)
  // A single contact sheet lets the owner visually check all 50+ contextual
  // photographs in minutes rather than reading every article individually.
  const cards=ordered.map((article,i)=>{
   const photos=article.pages.filter(p=>p.image).map(p=>{
    const file=p.image.split('/').pop(),local=pathToFileURL(path.join(mediaDir,file)).href
    return `<figure><img loading="lazy" src="${htmlSafe(local)}" alt="${htmlSafe(article.title)}"/><figcaption>${htmlSafe(p.caption.split(' · ')[0])}</figcaption></figure>`
   }).join('')
   return `<article><div class="meta">${i+1} · ${htmlSafe(article.publisher)} · ${htmlSafe(article.topic)}</div><h2>${htmlSafe(article.title)}</h2><div class="photos">${photos}</div><a href="${htmlSafe(article.sourceUrl)}" target="_blank" rel="noopener noreferrer">Bài gốc ↗</a></article>`
  }).join('')
  const review=`<!doctype html><html lang="vi"><meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/><title>DAILY NEWS - 50 ảnh đã xác minh</title><style>body{background:#f7f6f2;color:#252823;font:15px system-ui;margin:24px auto;max-width:1250px;padding:0 20px}h1{font:38px Georgia}main{display:grid;grid-template-columns:repeat(auto-fill,minmax(270px,1fr));gap:18px}article{background:white;border:1px solid #ddd;padding:15px;border-radius:8px}h2{font:21px Georgia;line-height:1.2}.meta,figcaption{color:#666;font-size:12px}.photos{display:grid;gap:9px}figure{margin:0}img{width:100%;max-height:200px;object-fit:contain;background:#eee}a{color:#56708c}</style><h1>DAILY NEWS — Kiểm tra ${ordered.length} bài có ảnh</h1><p>Đây là ảnh minh họa bối cảnh, không phải ảnh ghi lại sự kiện được đưa tin. Giấy phép và tác giả đầy đủ nằm trong mỗi bài ở mục Sources &amp; credits.</p><main>${cards}</main></html>`
  await fs.writeFile(path.join(reportDir,'V22D10_50_PHOTO_REVIEW.html'),review)
  log.log(`V22-D10 READY: ${ordered.length} fully illustrated articles, ${Object.keys(counts.publishers).length} publishers; UI can switch to visual-reader.`)
  return report
 } finally {await fs.rm(stagedMedia,{recursive:true,force:true})}
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 buildPhotoReader().then(r=>{if(!r.ready)process.exitCode=2}).catch(e=>{console.error('V22-D10 ERROR:',e.message);process.exitCode=1})
}
