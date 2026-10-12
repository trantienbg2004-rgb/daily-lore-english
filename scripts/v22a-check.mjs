import path from 'node:path'
import {fileURLToPath} from 'node:url'
import {readStagedNews,readiness} from './v22a-collect.mjs'
import {SOURCE_CARD} from './lib/rss-news.mjs'
import fs from 'node:fs/promises'
export async function checkV22A(base=process.cwd(),{strict=false}={}){
 const dir=path.join(base,'public/news-feed')
 const manifest=JSON.parse(await fs.readFile(path.join(dir,'manifest.json'),'utf8'))
 const stories=await readStagedNews(base)
 if(manifest.total!==stories.length||manifest.chunks!==Math.ceil(stories.length/32))throw Error('Manifest/chunk count mismatch')
 const ids=new Set(),urls=new Set()
 for(const s of stories){
  const source=String(s.newsSource||'')
  const url=String(s.sourceUrl||'')
  if(!/^https:\/\//.test(url)||!(/^https:\/\//.test(s.image||'')||s.image===SOURCE_CARD)||!source||!s.title||!s.publishedAt||
    !Number.isFinite(Date.parse(s.publishedAt))||!Array.isArray(s.pages)||!s.pages.length||
    !s.pages[0].image||!s.pages[0].text?.trim()||!s.id)throw Error(`Invalid V22-A story: ${s.title||url}`)
  if(urls.has(url)||ids.has(s.id))throw Error(`Duplicate article: ${url}`)
  ids.add(s.id);urls.add(url)
 }
 const status=readiness(stories)
 if(manifest.ready!==status.ready)throw Error('Stale READY status; rerun collector')
 console.log(`V22A CHECK: ${stories.length}/50 verified structure; ${status.sourceCount}/3 sources; READY=${status.ready}`)
 console.log('SOURCE BREAKDOWN:',JSON.stringify(status.byPublisher))
 if(strict&&!status.ready)throw Error('Staging not ready for V22-B. Keep V21 live.')
 return status
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))checkV22A(process.cwd(),{strict:process.argv.includes('--strict')}).catch(e=>{console.error(e.message);process.exitCode=1})
