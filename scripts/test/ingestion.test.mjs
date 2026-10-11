import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {countWords,makePages,mediaWikiHtmlToText,allowedMediaLicense} from '../lib/content.mjs'
import {validateFeed} from '../validate-feed.mjs'
import {fetchWikipediaBatch,getArticle,createClient,readLibrary,publish,runUpdate,parsePopular} from '../update-stories.mjs'

const P='This is a complete encyclopaedia sentence that explains a significant subject clearly to every curious reader.'
const text=Array(36).fill(P).join(' ')
const info=(name='Example.jpg',license='CC BY-SA 4.0')=>({
  title:`File:${name}`,
  imageinfo:[{width:1400,height:900,thumburl:'https://upload.wikimedia.org/wikipedia/commons/thumb/a/example.jpg',
    descriptionurl:'https://commons.wikimedia.org/wiki/File:Example.jpg',
    extmetadata:{LicenseShortName:{value:license},Artist:{value:'<b>Photo author</b>'}}}],
})
const story=(sourceTitle='Existing')=>({title:sourceTitle,sourceTitle,sourceUrl:`https://en.wikipedia.org/wiki/${sourceTitle}`,category:'KNOWLEDGE',pages:makePages(text,[{url:'https://example.com/photo.jpg',caption:'CC BY-SA'}])})

function wikiMock(titles=['Long Article']) {
  return async url=>{
    const u=new URL(url)
    const prop=u.searchParams.get('prop')||''
    if (prop.includes('extracts')) return {query:{pages:titles.map(t=>({title:t,pageimage:'Example.jpg',extract:text}))}}
    if(prop.includes('imageinfo'))return {query:{pages:[info()]}}
    throw Error(`Unexpected endpoint ${url}`)
  }
}

test('document pagination retains complete text and has multiple pages',()=>{
  const pages=makePages(text,[{url:'https://example.com/img.jpg',caption:'photo'}])
  assert.ok(pages.length>=3)
  assert.ok(countWords(pages.map(p=>p.text).join(' '))>=240)
  assert.equal(pages[0].image,'https://example.com/img.jpg')
  assert.deepEqual(makePages('A short piece.',[{url:'x',caption:'x'}]),[])
})

test('media licenses allow open images, reject NC/ND and GFDL-only',()=>{
  for(const license of ['CC BY-SA 4.0','CC BY 3.0','CC0 1.0','Public domain','PD-old-70'])
    assert.equal(allowedMediaLicense({LicenseShortName:{value:license}}),true,license)
  for(const license of ['CC BY-NC 4.0','CC BY-ND 2.0','Fair use','GFDL','All Rights Reserved'])
    assert.equal(allowedMediaLicense({LicenseShortName:{value:license}}),false,license)
})

test('Wikivoyage HTML collects prose and listing descriptions while removing scripts',()=>{
  const html=`<script>SECRET PRIVATE</script><p>${P}</p><li>${P} A useful second piece of contextual information.</li><span class="listing-description">${P} A unique final travel description.</span>`
  const result=mediaWikiHtmlToText(html)
  assert.ok(result.includes('encyclopaedia sentence'))
  assert.ok(result.split('\n\n').length>=2)
  assert.ok(!result.includes('SECRET'))
})

test('batched Wikipedia extracts use two requests for multiple entries',async()=>{
  const names=['History of an Island','Science of Art','Engineering in Space']
  let requests=0
  const client={get:async u=>{requests++;return wikiMock(names)(u)}}
  const batch=await fetchWikipediaBatch(names.map(title=>({title,category:'ALL TOPICS'})),client)
  assert.equal(requests,2)
  assert.equal(batch.stories.length,3)
  assert.ok(batch.stories.every(s=>s.pages.length>=3&&s.pages[0].caption.includes('Photo author')))
  assert.equal(batch.stories[0].sourceUrl,'https://en.wikipedia.org/wiki/History_of_an_Island')
})

test('a forbidden image license is rejected even if text is sufficiently long',async()=>{
  const client={get:async url=>{
    if(new URL(url).searchParams.get('prop')?.includes('imageinfo')) return {query:{pages:[info('Example.jpg','CC BY-NC 4.0')]}}
    return {query:{pages:[{title:'Long Article',pageimage:'Example.jpg',extract:text}]}}
  }}
  const result=await fetchWikipediaBatch([{title:'Long Article'}],client)
  assert.equal(result.stories.length,0)
  assert.equal(result.rejected['No reusable article image'],1)
})

test('Wikivoyage parses full HTML; uses photo of matching Wikipedia destination if necessary',async()=>{
  const client={get:async url=>{
    const u=new URL(url),host=u.hostname, prop=u.searchParams.get('prop')
    if(host==='en.wikivoyage.org'&&prop?.includes('text'))return {parse:{title:'Lisbon',text:Array.from({length:35},(_,i)=>`<p>${P} It is part of a distinct section of the guide number ${i}.</p>`).join(''),images:['Locator-map.png'],links:[{'*':'Portugal'}]}}
    if(host==='en.wikipedia.org'&&prop==='pageimages')return {query:{pages:[{pageimage:'Example.jpg'}]}}
    if(host==='en.wikipedia.org'&&prop==='imageinfo')return {query:{pages:[info()]}}
    throw Error(url)
  }}
  const related=[]
  const article=await getArticle({title:'Lisbon',source:'wikivoyage'},client,links=>related.push(...links))
  assert.equal(article.sourceTitle,'Lisbon')
  assert.equal(article.pages.length>=3,true)
  assert.deepEqual(related,['Portugal'])
  assert.equal(article.pages[0].image,'https://upload.wikimedia.org/wikipedia/commons/thumb/a/example.jpg')
})

test('HTTP 429 uses retry-after header, then succeeds',async()=>{
  let requests=0,time=0
  const client=createClient({log:{warn:()=>{}},now:()=>time,paceMs:0,sleepImpl:async ms=>{time+=ms},fetchImpl:async()=>{
    if(++requests===1)return {ok:false,status:429,headers:{get:()=> '2'}}
    return {ok:true,json:async()=>({query:{pages:[]}})}
  }})
  const data=await client.get('https://en.wikipedia.org/w/api.php')
  assert.deepEqual(data,{query:{pages:[]}})
  assert.equal(requests,2)
  assert.ok(time>=2000)
})

test('publishing appends new records without changing previous chunk and preserves URL identity',async()=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'dn-feed-'))
  try {
    await fs.mkdir(path.join(dir,'public/feed'),{recursive:true})
    await fs.writeFile(path.join(dir,'public/feed/0000.json'),JSON.stringify([story('First'),story('Second')]))
    await fs.writeFile(path.join(dir,'public/stories.json'),JSON.stringify([story('First'),story('Second')]))
    const existing=await readLibrary(dir)
    const added=Array.from({length:6},(_,i)=>story('New'+i))
    const first=await publish(dir,existing,added,{chunkSize:4,now:()=> '2026-10-11T10:00:00Z'})
    assert.equal(first.total,8)
    assert.equal(first.chunks,2)
    const a=JSON.parse(await fs.readFile(path.join(dir,'public/feed/0000.json')))
    const b=JSON.parse(await fs.readFile(path.join(dir,'public/feed/0001.json')))
    assert.equal(a.length,4);assert.equal(b.length,4)
    assert.equal(a[0].sourceUrl,story('First').sourceUrl)
    assert.equal(b[3].sourceUrl,story('New5').sourceUrl)
    const second=await readLibrary(dir)
    const noop=await publish(dir,second,[],{chunkSize:4})
    assert.equal(noop.changed,false)
    assert.equal(second.stories.length,8)
    const manifest=JSON.parse(await fs.readFile(path.join(dir,'public/feed/manifest.json')))
    assert.equal(manifest.total,8)
  }finally {await fs.rm(dir,{recursive:true,force:true})}
})

test('popular rankings can find more than the initial topic list',()=>{
  assert.deepEqual(parsePopular({items:[{articles:[{article:'Movie_(2025)'},{article:'Main_Page'},{article:'Science_and_society'}]}]}),['Movie (2025)','Science and society'])
})

test('automated update on mocked Wikimedia adds several articles, avoids re-add on next run',async()=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'dn-integration-'))
  const success=['History of an Island','Science of Art','Engineering in Space','Music in Art','New Technology','Theatre Story']
  const getTitles=()=>success.map(x=>({article:x.replaceAll(' ','_')}))
  const mock=async url=>{
    const u=new URL(url),prop=u.searchParams.get('prop'),list=u.searchParams.get('list')
    let result
    if(u.pathname.includes('pageviews/top/'))result={items:[{articles:getTitles()}]}
    else if(list==='categorymembers')result={query:{categorymembers:[]}}
    else if(prop?.includes('extracts'))result={query:{pages:u.searchParams.get('titles').split('|').map(title=>({title,pageimage:'Example.jpg',extract:text}))}}
    else if(prop?.includes('imageinfo'))result={query:{pages:[info()]}}
    else if(prop?.includes('text'))result={parse:{title:'New York City',text:Array.from({length:37},(_,i)=>`<p>${P} This guide section ${i} gives separate practical information.</p>`).join(''),images:['Example.jpg'],links:[]}}
    else result={query:{pages:[]}}
    return {ok:true,headers:{get:()=>null},json:async()=>result}
  }
  try {
    await fs.mkdir(path.join(dir,'public/feed'),{recursive:true})
    await fs.writeFile(path.join(dir,'public/feed/0000.json'),JSON.stringify([story('Existing')]))
    await fs.writeFile(path.join(dir,'public/stories.json'),JSON.stringify([story('Existing')]))
    const run=()=>runUpdate({base:dir,fetchImpl:mock,sleepImpl:async()=>{},log:{log:()=>{},warn:()=>{}},settings:{paceMs:0,maxArticles:9,maxCandidates:15,timeBudgetMs:120000}})
    const one=await run()
    assert.ok(one.added>=3,`expected >=3 articles, got ${one.added}`)
    assert.ok(one.total>=4)
    assert.ok(one.requests<30)
    const a=await readLibrary(dir)
    assert.equal(a.stories.length,one.total)
    const two=await run()
    const b=await readLibrary(dir)
    const ids=b.stories.map(x=>x.sourceUrl)
    assert.equal(new Set(ids).size,ids.length)
    assert.equal(two.total,b.stories.length)
  }finally{await fs.rm(dir,{recursive:true,force:true})}
})


test('1,200 articles can be appended and validated without destroying historical chunks',async()=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'dn-scale-'))
  try {
    await fs.mkdir(path.join(root,'public/feed'),{recursive:true})
    const initial=[story('First Existing')]
    await fs.writeFile(path.join(root,'public/feed/0000.json'),JSON.stringify(initial))
    await fs.writeFile(path.join(root,'public/stories.json'),JSON.stringify(initial))
    const original=await readLibrary(root)
    const additional=Array.from({length:1200},(_,i)=>story(`Knowledge article ${i}`))
    const result=await publish(root,original,additional)
    assert.equal(result.total,1201)
    assert.ok(result.chunks>=100)
    const checked=await validateFeed(root)
    assert.equal(checked.total,1201)
    const reopened=await readLibrary(root)
    assert.equal(reopened.stories[0].sourceUrl,initial[0].sourceUrl)
    assert.equal(new Set(reopened.stories.map(s=>s.sourceUrl)).size,1201)
  } finally {await fs.rm(root,{recursive:true,force:true})}
})
