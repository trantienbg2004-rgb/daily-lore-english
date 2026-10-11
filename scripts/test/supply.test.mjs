import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {discoverLongPages,mergeCandidateQueue,runUpdate,readLibrary,publish} from '../update-stories.mjs'
import {makePages} from '../lib/content.mjs'
import {validateFeed} from '../validate-feed.mjs'

const para='This detailed encyclopedia article explains the history, significance, and development of a subject through multiple accessible examples and careful description.'
const fullText=Array(40).fill(para).join(' ')
const imageInfo={title:'File:Open-photo.jpg',imageinfo:[{width:2000,height:1600,thumburl:'https://upload.wikimedia.org/wikipedia/commons/thumb/open-photo.jpg',descriptionurl:'https://commons.wikimedia.org/wiki/File:Open-photo.jpg',extmetadata:{LicenseShortName:{value:'CC BY-SA 4.0'},Artist:{value:'Wikipedia contributor'}}}]}
const article=title=>({title,sourceTitle:title,sourceUrl:'https://en.wikipedia.org/wiki/'+encodeURIComponent(title),category:'KNOWLEDGE',pages:makePages(fullText,[{url:'https://example.org/img.jpg',caption:'CC BY-SA'}])})

function mockApis() {
  const baseTitles=Array.from({length:1000},(_,i)=>`Detailed article ${String(i).padStart(4,'0')}`)
  return async raw=>{
    const url=new URL(raw), q=url.searchParams, host=url.hostname
    let data={}
    if(url.pathname.includes('/pageviews/top/')) data={items:[{articles:baseTitles.slice(0,1000).map(t=>({article:t.replaceAll(' ','_')}))}]}
    else if(q.get('list')==='categorymembers') data={query:{categorymembers:[]}}
    else if(q.get('list')==='allpages') {
      const pos=Number(q.get('apcontinue')||0)
      const selected=baseTitles.slice(pos,pos+200)
      data={query:{allpages:selected.map(title=>({title}))},continue:selected.length>=200?{apcontinue:String(pos+200)}:undefined}
    }
    else if(q.get('prop')?.includes('extracts'))data={query:{pages:q.get('titles').split('|').map(title=>({title,extract:fullText,pageimage:'Open-photo.jpg'}))}}
    else if(q.get('prop')==='imageinfo')data={query:{pages:[imageInfo]}}
    else if(q.get('action')==='parse'&&host==='en.wikivoyage.org')data={parse:{title:q.get('page'),text:Array.from({length:36},(_,i)=>`<p>${para} Destination guide section number ${i} provides useful regional details.</p>`).join(''),images:['Open-photo.jpg'],links:[]}}
    else if(q.get('prop')?.includes('pageimages'))data={query:{pages:[{pageimage:'Open-photo.jpg'}]}}
    else throw Error('Unexpected mock API '+url)
    return {ok:true,status:200,headers:{get:()=>null},json:async()=>data}
  }
}

const withLibrary=async callback=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'dn-v15-test-'))
  await fs.mkdir(path.join(root,'public/feed'),{recursive:true})
  await fs.writeFile(path.join(root,'public/feed/0000.json'),JSON.stringify([article('Existing one')]))
  await fs.writeFile(path.join(root,'public/stories.json'),JSON.stringify([article('Existing one')]))
  try{return await callback(root)}finally{await fs.rm(root,{recursive:true,force:true})}
}

test('allpages requests non-redirect pages with a minimum size and saves cursors',async()=>{
  let apiUrl
  const state={}
  const pages=await discoverLongPages('wikipedia',{get:async url=>{
    apiUrl=new URL(url)
    return {query:{allpages:[{title:'Long article'},{title:'List of articles'}]},continue:{apcontinue:'Long article 2'}}
  }},state)
  assert.deepEqual(pages.map(p=>p.title),['Long article'])
  assert.equal(apiUrl.searchParams.get('apfilterredir'),'nonredirects')
  assert.equal(apiUrl.searchParams.get('apminsize'),'11000')
  assert.equal(state.longPageCursors.wikipedia,'Long article 2')
})

test('unprocessed queue candidates remain on disk after a partial update',async()=>withLibrary(async root=>{
  const first=await runUpdate({base:root,fetchImpl:mockApis(),sleepImpl:async()=>{},
    settings:{paceMs:0,maxArticles:10,maxCandidates:18,timeBudgetMs:60000},log:{log(){},warn(){}}})
  assert.equal(first.added,10)
  assert.ok(first.queueRemaining>=100)
  const saved=JSON.parse(await fs.readFile(path.join(root,'public/feed/discovery-state.json')))
  assert.ok(saved.candidateQueue.length>=100)
  const before=saved.candidateQueue.map(x=>`${x.source}:${x.title}`)
  assert.equal(new Set(before).size,before.length)
  const next=await runUpdate({base:root,fetchImpl:mockApis(),sleepImpl:async()=>{},
    settings:{paceMs:0,maxArticles:10,maxCandidates:18,timeBudgetMs:60000},log:{log(){},warn(){}}})
  assert.equal(next.added,10)
  assert.ok(next.total>=21)
  assert.equal((await validateFeed(root)).total,next.total)
}))

test('supply of 400 UNIQUE articles can be published, retained and incrementally scanned',async()=>withLibrary(async root=>{
  // This proves local storage/data pipeline capacity, NOT 400 articles/day
  // from a live source. Actual throughput must be measured in Actions logs.
  let library=await readLibrary(root)
  const firstContents=await fs.readFile(path.join(root,'public/feed/0000.json'),'utf8')
  for(let batch=0;batch<4;batch++) {
    const additional=Array.from({length:100},(_,i)=>article(`Unique article ${batch*100+i}`))
    await publish(root,library,additional,{chunkSize:32})
    library=await readLibrary(root)
  }
  const manifest=JSON.parse(await fs.readFile(path.join(root,'public/feed/manifest.json')))
  assert.equal(manifest.total,401)
  assert.equal(new Set(library.stories.map(s=>s.sourceUrl)).size,401)
  assert.equal((await validateFeed(root)).total,401)
  const original=JSON.parse(firstContents)[0].sourceUrl
  assert.equal(library.stories[0].sourceUrl,original)
  const chunkNames=(await fs.readdir(path.join(root,'public/feed'))).filter(name=>/^[0-9]{4}\.json$/.test(name))
  assert.ok(chunkNames.length<=14,`expected ~13 chunks, got ${chunkNames.length}`)
}))

test('unavailable discovery preserves backlog, preserving old articles and no duplicated URLs',async()=>withLibrary(async root=>{
  await fs.writeFile(path.join(root,'public/feed/discovery-state.json'),JSON.stringify({
    candidateQueue:[{source:'wikipedia',title:'Long article 123',category:'All topics'}],
    failed:{},longPageCursors:{wikipedia:'Continuing'},categoryTokens:{},voyageQueue:[],
  }))
  const err=async()=>{throw Error('Temporary source outage')}
  const result=await runUpdate({base:root,fetchImpl:err,sleepImpl:async()=>{},
    settings:{paceMs:0,maxCandidates:1,timeBudgetMs:12000},log:{log(){},warn(){}}})
  assert.equal(result.total,1)
  const state=JSON.parse(await fs.readFile(path.join(root,'public/feed/discovery-state.json')))
  assert.ok(state.candidateQueue.length>=1)
  assert.ok(state.candidateQueue.some(item=>item.title==='Long article 123'))
}))

test('five independent scheduled runs can ingest >400 distinct articles from a fully available mocked source',async()=>withLibrary(async root=>{
  const logs={log(){},warn(){}}
  let added=0
  for(let i=0;i<5;i++){
    const result=await runUpdate({base:root,fetchImpl:mockApis(),sleepImpl:async()=>{},
      settings:{paceMs:0,maxArticles:85,maxCandidates:160,timeBudgetMs:180000},log:logs})
    added+=result.added
  }
  const library=await readLibrary(root)
  assert.ok(added>=400,`mocked source only supplied ${added} articles`)
  assert.equal(new Set(library.stories.map(item=>item.sourceUrl)).size,library.stories.length)
  assert.equal((await validateFeed(root)).total,library.stories.length)
}))

test('same-subject Wikidata P18 photograph rescues a long Wikipedia article without pageimage',async()=>{
  const {fetchWikipediaBatch}=await import('../update-stories.mjs')
  const client={get:async url=>{
    const u=new URL(url)
    if(u.hostname==='www.wikidata.org') return {entities:{Q123:{claims:{P18:[{mainsnak:{datavalue:{value:'Open-photo.jpg'}}}]}}}}
    if(u.searchParams.get('prop')?.includes('extracts'))return {query:{pages:[{title:'Long subject',extract:fullText,pageprops:{wikibase_item:'Q123'}}]}}
    if(u.searchParams.get('prop')==='imageinfo')return {query:{pages:[imageInfo]}}
    throw Error('Unexpected '+url)
  }}
  const answer=await fetchWikipediaBatch([{source:'wikipedia',title:'Long subject',category:'Knowledge'}],client)
  assert.equal(answer.stories.length,1)
  assert.ok(answer.stories[0].pages[0].image.includes('wikimedia.org'))
})

test('valid encyclopedia candidates beyond the per-run publishing cap remain queued',async()=>withLibrary(async root=>{
  const names=Array.from({length:16},(_,i)=>`Detailed article ${String(i).padStart(4,'0')}`)
  await fs.writeFile(path.join(root,'public/feed/discovery-state.json'),JSON.stringify({
    candidateQueue:names.map(title=>({title,source:'wikipedia',category:'TEST'})),
    longPageCursors:{},categoryTokens:{},voyageQueue:[],failed:{},
  }))
  const result=await runUpdate({base:root,fetchImpl:mockApis(),sleepImpl:async()=>{},
    settings:{paceMs:0,maxArticles:3,maxCandidates:30,timeBudgetMs:60000},log:{log(){},warn(){}}})
  assert.equal(result.added,3)
  const state=JSON.parse(await fs.readFile(path.join(root,'public/feed/discovery-state.json')))
  const allPublished=new Set((await readLibrary(root)).stories.map(p=>p.sourceTitle))
  for(const title of names)assert.ok(allPublished.has(title)||state.candidateQueue.some(x=>x.title===title),`Lost ${title}`)
}))
