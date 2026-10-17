/** Convert published catalog to strict news-only while leaving historical shard bytes untouched. */
import fs from 'node:fs/promises'
import path from 'node:path'
import {createHash} from 'node:crypto'
import {buildReaderIndex} from './build-reader-index.mjs'
import {validStories,storyId} from '../src/lib/feedQueue.js'
const folder=path.resolve('public/lore-reader')
const manifestPath=path.join(folder,'manifest.json')
const manifest=JSON.parse(await fs.readFile(manifestPath,'utf8'))
const seeds=JSON.parse(await fs.readFile(new URL('./seed-saga-news.json',import.meta.url),'utf8'))
if(manifest.chunks<12)throw Error('Unexpected shard layout, preserving existing catalog')
if(!Array.isArray(seeds)||seeds.length!==4||!validStories(seeds)||seeds.some(s=>s.contentType!=='news'))throw Error('Invalid approved news seeds')
let stories=[]
for(let i=0;i<manifest.chunks;i++){
 const p=path.join(folder,`${String(i).padStart(4,'0')}.json`)
 const rows=JSON.parse(await fs.readFile(p,'utf8'))
 if(!validStories(rows))throw Error('Corrupt source shard '+p)
 stories.push(...rows)
}
const existing=new Set(stories.map(storyId)),newOnes=seeds.filter(s=>!existing.has(storyId(s)))
if(newOnes.length){
 const shardPath=path.join(folder,'0011.json')
 const shard=JSON.parse(await fs.readFile(shardPath,'utf8'))
 if(shard.length+newOnes.length>20)throw Error('Shard 0011 is full, refusing to overwrite')
 await fs.writeFile(shardPath,JSON.stringify([...shard,...newOnes])+'\n','utf8')
 stories.push(...newOnes)
}
const news=stories.filter(x=>x.contentType==='news')
if(news.length<6)throw Error(`Expected at least 6 verified news, got ${news.length}`)
const byTopic={}
for(const s of news)byTopic[s.category]=(byTopic[s.category]||0)+1
const next={...manifest,feedType:'news',newsOnly:true,total:news.length,sourceCount:new Set(news.map(s=>s.sourceName||s.publisher)).size,withVerifiedPhoto:news.filter(s=>s.pages.some(p=>p.image)).length,sourcePhotosOnly:true,byTopic,updatedAt:new Date().toISOString(),licenseNotice:'Only independently written, source-attributed educational news summaries are indexed. Historic lore shard files remain stored.'}
next.contentHash=createHash('sha256').update(JSON.stringify(news.map(s=>[storyId(s),s.pages,s.levelVariants]))).digest('hex')
delete next.catalogIndexHash
await fs.writeFile(manifestPath,JSON.stringify(next,null,2)+'\n')
const stats=await buildReaderIndex()
const idx=JSON.parse(await fs.readFile(path.join(folder,'catalog-index.json'),'utf8'))
if(idx.total!==news.length||idx.entries.some(e=>e.contentType!=='news'))throw Error('News-only catalog mismatch')
console.log(`SAGA NEWS ONLY READY: ${news.length} news, 0 lore indexed, ${stats.shards} physical shards. Historical data retained.`)
