import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import {isMediaCredit,sanitizeReadingArticle} from '../../src/lib/articleCleanup.js'
import {PUBLISHED_POOLS,eligibleManifest,refreshCatalog,refillCatalog} from '../../src/lib/continuousReader.js'
import {nativeImageCandidates,approvedImageUrl,verifyNativeImageBytes,safeFetchPublisher} from '../lib/v22d13-source-images.mjs'
import {buildOriginalPhotoReader} from '../v22d13-original-reader.mjs'
import {refreshPublishedNews} from '../v22d13-refresh.mjs'
import {buildWorldReader} from '../v22d7-build-reader.mjs'
import {photoCandidates} from '../../src/lib/photoPresentation.js'
const u='https://globalvoices.org/2026/10/13/native-photo-story/'
const a={sourceUrl:u,publisher:'Global Voices',title:'An original image from a Global Voices article',pages:[{text:'Image remix on Canva by Ihsan Kamil/EngageMedia. Used with permission.',image:''},{text:'An independent account of events in a region. '.repeat(40),image:''}],readingKind:'full',contentType:'news'}
const html=(caption='Photograph by Example Photographer. CC BY 4.0')=>`<html><head><meta property="og:image" content="https://unrelated.com/hero.jpg"></head><main><article><h1>Original story</h1><figure><img src="https://globalvoices.org/wp-content/uploads/2026/10/original.jpg" alt="Local event"><figcaption>${caption}</figcaption></figure></article></main></html>`
const silent={log(){},warn(){}}
const jpeg=Buffer.alloc(1900);jpeg[0]=255;jpeg[1]=216;jpeg[2]=255
const fakeFetch=async url=>{
 if(url===u)return new Response(html(),{headers:{'content-type':'text/html'}})
 if(url.endsWith('/original.jpg'))return new Response(jpeg,{headers:{'content-type':'image/jpeg'}})
 throw Error(`unexpected request: ${url}`)
}
async function fixture(fn){const base=await fs.mkdtemp(path.join(os.tmpdir(),'dnews-native-'));try{
 const dir=path.join(base,'public','world-reader');await fs.mkdir(dir,{recursive:true})
 await fs.writeFile(path.join(dir,'manifest.json'),JSON.stringify({ready:true,feedType:'news',chunks:1,total:1}))
 await fs.writeFile(path.join(dir,'0000.json'),JSON.stringify([a]))
 await fn(base)
}finally{await fs.rm(base,{recursive:true,force:true})}}
test('No visual-reader Commons search or fabricated DN card is in the active interface',async()=>{
 assert.deepEqual(PUBLISHED_POOLS,['source-visual-reader','world-reader'])
 assert.deepEqual(photoCandidates('/original-reader-media/'+'a'.repeat(28)+'.jpg'),['/original-reader-media/'+'a'.repeat(28)+'.jpg'])
 assert.deepEqual(photoCandidates('/world-reader-media/'+'a'.repeat(24)+'.jpg'),[])
 const app=await fs.readFile(new URL('../../src/App.jsx',import.meta.url),'utf8')
 assert.doesNotMatch(app,/<div className="dn-editorial-cover"/)
 assert.doesNotMatch(app,/\{label && <figcaption/)
 const workflow=await fs.readFile(new URL('../../.github/workflows/daily-world-reader.yml',import.meta.url),'utf8')
 assert.match(workflow,/v22d13-refresh\.mjs/)
 assert.doesNotMatch(workflow,/v22d10-build-photo-reader|v22d12-refresh\.mjs|commons/i)
})
test('Standalone Canva/YouTube photo credits are removed from prose and preserved in source credits',()=>{
 const cleaned=sanitizeReadingArticle(a)
 assert.equal(cleaned.pages.length,1)
 assert.equal(cleaned.pages[0].text.startsWith('An independent'),true)
 assert.match(cleaned.sourceMediaCredit,/Image remix on Canva/)
 const b=sanitizeReadingArticle({...a,pages:[{text:'Image by A. Used with permission. The report describes yesterday\'s meeting in detail.',image:''},{text:'Another paragraph',image:''}]})
 assert.match(b.sourceMediaCredit,/Image by A/)
 assert.match(b.pages[0].text,/The report describes/)
 assert.equal(isMediaCredit('The government introduced a new policy for local schools.'),false)
})
test('Source-photo gate only accepts figures appearing inside the original article with specific reuse rights',()=>{
 const photos=nativeImageCandidates(html(),a)
 assert.equal(photos.length,1)
 assert.equal(photos[0].sourceImageUrl,'https://globalvoices.org/wp-content/uploads/2026/10/original.jpg')
 assert.match(photos[0].license,/CC BY 4\.0/)
 assert.equal(nativeImageCandidates(html('Image copyright Example Photographer. Used with permission.'),a).length,0)
 assert.equal(nativeImageCandidates('<main><img src="https://globalvoices.org/og.jpg"></main>',a).length,0)
 assert.equal(approvedImageUrl('https://upload.wikimedia.org/wikipedia/commons/file.jpg',u,'Global Voices'),'')
 assert.equal(approvedImageUrl('https://globalvoices.org.evil.test/photo.jpg',u,'Global Voices'),'')
})
test('Publisher image request rejects redirects away from source-domain allowlist',async()=>{
 await assert.rejects(safeFetchPublisher(async()=>new Response(jpeg,{headers:{'content-type':'image/jpeg'}}),'https://upload.wikimedia.org/wikipedia/commons/a.jpg',a,{isImage:true}),/unapproved/)
 await assert.rejects(safeFetchPublisher(async()=>({ok:true,url:'https://evil.test/photo.jpg',headers:{get(){return 'image/jpeg'}},arrayBuffer:async()=>jpeg}),'https://globalvoices.org/photo.jpg',a,{isImage:true}),/off-publisher/)
 assert.equal(verifyNativeImageBytes(jpeg,'image/jpeg'),'jpg')
 assert.equal(verifyNativeImageBytes(jpeg,'text/plain'),'')
})
test('Publisher-native illustrated reader is built with local image and per-photo rights provenance',async()=>fixture(async base=>{
 const r=await buildOriginalPhotoReader({base,fetchImpl:fakeFetch,maxArticles:1,maxNew:1,log:silent})
 assert.equal(r.ready,true);assert.equal(r.total,1);assert.equal(r.downloaded,1)
 const output=JSON.parse(await fs.readFile(path.join(base,'public','source-visual-reader','0000.json'),'utf8'))
 assert.equal(output.length,1)
 assert.match(output[0].pages[0].image,/^\/original-reader-media\//)
 assert.equal(output[0].pages[0].imageProvenance.originArticleUrl,u)
 assert.equal(output[0].pages[0].imageProvenance.license,'CC BY 4.0')
 assert.equal(output[0].sourceMediaCredit.includes('Image remix'),true)
 assert.equal(output[0].pages[0].text.includes('Image remix'),false)
 const second=await buildOriginalPhotoReader({base,fetchImpl:async()=>{throw Error('should not fetch known')},maxArticles:1,maxNew:1,log:silent})
 assert.equal(second.unchanged,true)
}))
test('Missing image rights or offline article does not publish a misleading illustration',async()=>fixture(async base=>{
 const r=await buildOriginalPhotoReader({base,fetchImpl:async url=>new Response(html('Used with permission.'),{headers:{'content-type':'text/html'}}),log:silent})
 assert.equal(r.ready,false)
 await assert.rejects(fs.access(path.join(base,'public','source-visual-reader','manifest.json')),/ENOENT/)
}))
test('Updated article manifest is recognized without changing chunk count',async()=>{
 const v={feedType:'news',ready:true,sourceCount:3,count:1,sourcePhotosOnly:true,withVerifiedPhoto:1,version:'old',updatedAt:'old',total:1}
 const previous=[{path:'world-reader',manifest:v,version:'old',order:[0],cursor:1,done:true}]
 const r=await refreshCatalog({fetchImpl:()=>{},baseUrl:'/',pools:previous,fetchManifestImpl:async(_f,_b,_t,path)=>path==='world-reader'?{...v,version:'new'}:Promise.reject(Error('not available'))})
 assert.equal(r.pools.length,1);assert.equal(r.pools[0].cursor,0);assert.equal(r.pools[0].done,false)
 assert.equal(eligibleManifest({...v,sourceCount:1},'world-reader'),false)
 assert.equal(eligibleManifest({...v,sourceCount:1},'source-visual-reader'),true)
})
test('Three content sources are attempted independently; picture failure never deletes verified text news',async()=>{
 const sequence=[]
 const r=await refreshPublishedNews({base:await fs.mkdtemp(path.join(os.tmpdir(),'dnews-refresh-')),now:new Date('2026-10-13'),log:silent,
  collectors:[['Global Voices',async()=>{sequence.push('GV');return{added:3}}],['GOV.UK',async()=>{sequence.push('UK');throw Error('offline')}],['European Commission',async()=>{sequence.push('EC');return{added:2}}]],
  buildWorld:async()=>({published:true,manifest:{ready:true,total:105,sourceCount:3,contentHash:'hash'}}),
  buildPhotos:async()=>{throw Error('publisher page offline')}})
 assert.deepEqual(sequence,['GV','UK','EC'])
 assert.equal(r.fullArticles,105)
 assert.equal(r.releaseReady,true)
 assert.ok(r.errors['GOV.UK']&&r.errors.originalImages)
})
test('World reader content hash prevents a no-change rebuild from resetting clients',async t=>{
 const base=await fs.mkdtemp(path.join(os.tmpdir(),'dnews-hash-'))
 t.after(()=>fs.rm(base,{recursive:true,force:true}))
 const dir=path.join(base,'public','world-reader-pilot');await fs.mkdir(dir,{recursive:true})
 const lorem='Independent journalists investigated a policy change across the region and reported conversations with affected people. '
 const record=(publisher,id)=>({sourceUrl:publisher==='Global Voices'?`https://globalvoices.org/2026/10/12/story-${id}/`:publisher==='GOV.UK'?`https://www.gov.uk/government/news/story-${id}`:`https://commission.europa.eu/news-and-media/news/story-${id}-2026-10-12_en`,title:`Independent and official news report on global policies number ${id}`,publisher,license:publisher==='Global Voices'?'CC BY 3.0':publisher==='GOV.UK'?'Open Government Licence v3.0':'CC BY 4.0',author:'Example Author',attribution:'Source — https://globalvoices.org/source',publishedAt:'2026-10-12',readingKind:'full',contentType:'news',pages:Array.from({length:6},()=>({text:lorem.repeat(4)+' Report number '+id+'.',image:''}))})
 const data=[...Array.from({length:8},(_,i)=>record('Global Voices',i)),...Array.from({length:16},(_,i)=>record('GOV.UK',i+100)),...Array.from({length:16},(_,i)=>record('European Commission',i+200))]
 await fs.writeFile(path.join(dir,'0000.json'),JSON.stringify(data))
 const first=await buildWorldReader({base,now:new Date('2026-10-13')})
 assert.equal(first.published,true)
 const second=await buildWorldReader({base,now:new Date('2026-10-14')})
 assert.equal(second.published,false)
 assert.equal(second.unchanged,true)
 assert.equal(second.manifest.contentHash,first.manifest.contentHash)
})
