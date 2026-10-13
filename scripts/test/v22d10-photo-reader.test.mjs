import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {imageQueries,parseCommonsCandidate,pickCommonsPhotos,imageCaption,placePhotos,isApprovedPhotoPath} from '../lib/v22d10-licensed-images.mjs'
import {verifyImageBytes,buildPhotoReader,cleanLeadingCredit} from '../v22d10-build-photo-reader.mjs'
import {photoCandidates,photoSourceLink} from '../../src/lib/photoPresentation.js'
import {fetchManifest} from '../../src/lib/feedQueue.js'
import {checkVisualReader} from '../v22d10-check.mjs'
const now=new Date('2026-10-13T13:00:00Z')
const sentence='Independent local sources described changes in public policy and the experiences of families in the region. Officials provided background statistics while reporters compared the announcements with the available documents. Residents also discussed how the latest development might affect their communities over the coming years.'
const para=Array.from({length:2},()=>sentence).join(' ')
const b26=n=>{let s='';while(n>=0){s=String.fromCharCode(97+n%26)+s;n=Math.floor(n/26)-1}return s}
const makeArticle=(publisher,n)=>{
 const host=publisher==='Global Voices'?'globalvoices.org':publisher==='GOV.UK'?'www.gov.uk':'commission.europa.eu'
 const name=`valoria${b26(n)}`
 const sourceUrl=`https://${host}/${publisher==='Global Voices'?`2026/10/12/editorial-${name}/`:publisher==='GOV.UK'?`government/news/editorial-${name}`:`news-and-media/news/editorial-${name}-2026-10-12_en`}`
 const pages=Array.from({length:5},(_,i)=>({image:'',caption:'',text:`${para} This is the documented story of ${name}. Section ${i+1}`}))
 return {id:String(n),publisher,sourceUrl,title:`${name} education and communities under new proposals`,publishedAt:'2026-10-12T09:00:00Z',license:publisher==='GOV.UK'?'Open Government Licence v3.0':publisher==='Global Voices'?'CC BY 3.0':'CC BY 4.0',attribution:`Reporter · ${sourceUrl} · attribution details and https://creativecommons.org/licenses/by/4.0/`,author:'Independent Writer',readingKind:'full',contentType:'news',topic:['Society','Economy','Technology','World','Politics'][n%5],pages}
}
const pictureBuf=Buffer.concat([Buffer.from([0xff,0xd8,0xff]),Buffer.alloc(1140,123),Buffer.from([0xff,0xd9])])
const webMock=async url=>{
 const u=new URL(url)
 if(u.hostname==='commons.wikimedia.org'){
  const q=u.searchParams.get('gsrsearch')?.replace(/^filetype:bitmap /,'')||'unmatched'
  const suffix=encodeURIComponent(q.replace(/\s+/g,'_'))
  const candidate={title:`File:${q} contemporary landscape photograph.jpg`,imageinfo:[{mime:'image/jpeg',width:1280,height:820,thumburl:`https://upload.wikimedia.org/wikipedia/commons/thumb/a/ab/${suffix}.jpg/800px-${suffix}.jpg`,descriptionurl:`https://commons.wikimedia.org/wiki/File:${suffix}.jpg`,extmetadata:{LicenseShortName:{value:'CC BY 4.0'},Artist:{value:'Independent Photographer'},ImageDescription:{value:`A picture of ${q} in a local landscape.`}}}]}
  const data=Buffer.from(JSON.stringify({query:{pages:[candidate]}}))
  return {ok:true,status:200,url,headers:{get:k=>k==='content-type'?'application/json':String(data.length)},arrayBuffer:async()=>data}
 }
 if(u.hostname==='upload.wikimedia.org')return {ok:true,status:200,url,headers:{get:k=>k==='content-type'?'image/jpeg':String(pictureBuf.length)},arrayBuffer:async()=>pictureBuf}
 throw Error('unexpected request '+url)
}
async function temp(fn){const base=await fs.mkdtemp(path.join(os.tmpdir(),'dnews-photo-'));try{await fn(base)}finally{await fs.rm(base,{recursive:true,force:true})}}
async function setup(base,n=68){
 const dest=path.join(base,'public','world-reader');await fs.mkdir(dest,{recursive:true})
 const types=['Global Voices','European Commission','GOV.UK']
 const articles=Array.from({length:n},(_,i)=>makeArticle(types[i%3],i))
 await fs.writeFile(path.join(dest,'manifest.json'),JSON.stringify({ready:true,feedType:'news',total:articles.length,chunks:1}))
 await fs.writeFile(path.join(dest,'0000.json'),JSON.stringify(articles))
 return articles
}
const candidate=(lic='CC BY 4.0')=>({title:'File:Sahel protest village scene.jpg',imageinfo:[{mime:'image/jpeg',width:900,height:600,thumburl:'https://upload.wikimedia.org/wikipedia/commons/thumb/a/ab/sahel.jpg/800px-sahel.jpg',descriptionurl:'https://commons.wikimedia.org/wiki/File:sahel.jpg',extmetadata:{LicenseShortName:{value:lic},Artist:{value:'Photographer Name'},ImageDescription:{value:'A landscape in the Sahel region'}}}]})
test('Country and issue are preferred; event photo never assumed',()=>{
 const queries=imageQueries({title:'Protests and social change in the Sahel',description:'Mali communities'})
 assert.ok(queries.includes('sahel protest'))
 assert.match(imageCaption({name:'Sahel village',license:'CC BY 4.0',source:'https://commons.wikimedia.org/wiki/File:sahel.jpg',author:'Reporter'}),/not a photograph of this specific news event/)
})
test('Commons per-file license: disallow NC and ND, unknown author, logo, unrelated result',()=>{
 assert.ok(parseCommonsCandidate(candidate('CC BY 4.0'),{query:'sahel'}).image)
 for(const license of ['CC BY-NC 4.0','CC BY-ND 4.0','All rights reserved','CC BY-SA-NC 3.0'])assert.equal(parseCommonsCandidate(candidate(license),{query:'sahel'}).image,undefined)
 assert.equal(parseCommonsCandidate(candidate('CC BY 4.0'),{query:'tokyo'}).image,undefined)
 assert.equal(parseCommonsCandidate({...candidate(),title:'File:Sahel protest logo.jpg'},{query:'sahel'}).image,undefined)
})
test('Reject non-image bytes and MIME mismatch, accept image magic only',()=>{
 assert.equal(verifyImageBytes(Buffer.from('html forbidden'), 'image/jpeg'),'')
 assert.equal(verifyImageBytes(pictureBuf,'text/html'),'')
 assert.equal(verifyImageBytes(pictureBuf,'image/jpeg'),'jpg')
})
test('Attach multiple separate real image entries without rewriting words',()=>{
 const a=makeArticle('Global Voices',9),pics=[{localUrl:'/world-reader-media/012345678901234567890abc.jpg',author:'A',name:'Village',license:'CC BY 4.0',source:'https://commons.wikimedia.org/wiki/File:Village.jpg'},{localUrl:'/world-reader-media/012345678901234567890abd.jpg',author:'B',name:'School',license:'CC0',source:'https://commons.wikimedia.org/wiki/File:School.jpg'}]
 const result=placePhotos(a,pics)
 assert.equal(result.photoCount,2)
 assert.equal(result.pages[0].image,pics[0].localUrl)
 assert.equal(result.pages[2].image,pics[1].localUrl)
 assert.equal(result.pages.map(p=>p.text).join(' '),a.pages.map(p=>p.text).join(' '))
 assert.ok(isApprovedPhotoPath(result.pages[2].image))
})
test('Success: 50+ licensed image articles across publishers and topics; original reader untouched',()=>temp(async base=>{
 const source=await setup(base,68),old=await fs.readFile(path.join(base,'public/world-reader/manifest.json'),'utf8')
 const result=await buildPhotoReader({base,fetchImpl:webMock,now,minArticles:50,targetArticles:52,maxChecks:68,maxPhotos:1,apiDelayMs:0,log:{log(){},warn(){}}})
 assert.equal(result.ready,true)
 assert.ok(result.qualifiedWithPhoto>=50)
 assert.ok(result.photosDownloaded>=50)
 assert.ok(Object.keys(result.publishers).length>=3)
 assert.ok(Object.keys(result.topics).length>=4)
 const m=JSON.parse(await fs.readFile(path.join(base,'public/visual-reader/manifest.json'),'utf8'))
 assert.equal(m.withVerifiedPhoto,result.qualifiedWithPhoto)
 let all=[];for(let i=0;i<m.chunks;i++)all.push(...JSON.parse(await fs.readFile(path.join(base,'public/visual-reader',String(i).padStart(4,'0')+'.json'),'utf8')))
 assert.ok(all.every(a=>a.pages.some(p=>p.image.startsWith('/world-reader-media/'))))
 for(const a of all){for(const page of a.pages.filter(p=>p.image)){assert.match(page.caption,/Credits: https:\/\/commons.wikimedia.org/);const filename=page.image.split('/').pop();assert.ok((await fs.stat(path.join(base,'public/world-reader-media',filename))).size>1024)}}
 assert.equal(await fs.readFile(path.join(base,'public/world-reader/manifest.json'),'utf8'),old)
 const integrity=await checkVisualReader(base)
 assert.equal(integrity.total,result.qualifiedWithPhoto)
 const review=await fs.readFile(path.join(base,'reports','V22D10_50_PHOTO_REVIEW.html'),'utf8')
 assert.ok(review.includes('Kiểm tra 52 bài có ảnh'))
 assert.ok(review.includes('file:'))
 assert.ok(integrity.photos>=50)
 assert.equal(source.length,68)
}))
test('Failed 50 gate never touches a previously ready visual feed',()=>temp(async base=>{
 await setup(base,58)
 const d=path.join(base,'public','visual-reader');await fs.mkdir(d,{recursive:true});await fs.writeFile(path.join(d,'manifest.json'),'PREVIOUS READY FEED')
 const failFetch=async()=>{throw Error('offline')}
 const result=await buildPhotoReader({base,fetchImpl:failFetch,now,minArticles:50,targetArticles:52,maxChecks:3,apiDelayMs:0,log:{log(){},warn(){}}})
 assert.equal(result.ready,false)
 assert.equal(result.qualifiedWithPhoto,0)
 assert.equal(await fs.readFile(path.join(d,'manifest.json'),'utf8'),'PREVIOUS READY FEED')
}))

test('Legacy Commons photos are no longer eligible for the active reader; rights links remain auditable',()=>{
 const photo='/world-reader-media/012345678901234567890abc.jpg'
 assert.deepEqual(photoCandidates(photo),[])
 assert.deepEqual(photoCandidates('/original-reader-media/'+'a'.repeat(28)+'.jpg'), ['/original-reader-media/'+'a'.repeat(28)+'.jpg'])
 assert.deepEqual(photoCandidates('/world-reader-media/../../secret.jpg'),[])
 const caption='Context photograph: Sahel town · Photo: Alice · License: CC BY 4.0 · Credits: https://commons.wikimedia.org/wiki/File:Sahel.jpg'
 assert.equal(photoSourceLink({image:photo,caption}),'https://commons.wikimedia.org/wiki/File:Sahel.jpg')
})
test('Browser manifest exposes the verified photo count for the visual-feed gate',async()=>{
 const payload={ready:true,feedType:'news',sourceCount:3,chunks:3,withVerifiedPhoto:55,updatedAt:'2026-10-13T00:00:00Z'}
 const manifest=await fetchManifest(async()=>({ok:true,json:async()=>payload}),'/',42,'visual-reader')
 assert.equal(manifest.withVerifiedPhoto,55)
})

test('Standalone screenshot caption is moved to credits, never shown as opening news paragraph',()=>{
 const original=makeArticle('Global Voices',13)
 original.pages[0].text='Demonstrations in the Sahel: (left) Mali, (center) Niger, and (right) Burkina Faso. Screenshots via YouTube.'
 const cleaned=cleanLeadingCredit(original)
 assert.equal(cleaned.pages.length,original.pages.length-1)
 assert.match(cleaned.sourceMediaCredit,/Screenshots via YouTube/)
 assert.match(cleaned.pages[0].text,/Independent local sources described/)
 assert.equal(original.pages.length,5)
})
