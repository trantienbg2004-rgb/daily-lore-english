// Read-only production audit. Select real public catalog entries; never
// replace article text, JavaScript, styles, or image responses.
import { chromium } from '@playwright/test'
import { mkdir, writeFile } from 'node:fs/promises'
const base='https://saga.id.vn/'
const out='test-results/production-baseline'
const cases=[['magna-carta','https://en.wikipedia.org/wiki/Magna_Carta'],['goat','https://en.wikipedia.org/wiki/GOAT_(sports_culture)']]
const viewports=[{width:1366,height:768},{width:390,height:844},{width:430,height:932}]
const levels=[['A1-A2','A (A1-A2 Beginner)'],['B1-B2','B (B1-B2 Intermediate)'],['C1-C2','C (C1-C2 Advanced)']]
const norm=s=>String(s||'').replace(/\s+/g,' ').replace(/\s+([.,!?;:])/g,'$1').trim()
await mkdir(out,{recursive:true})
const browser=await chromium.launch({headless:true})
const report={url:base,articles:[],errors:[]}
try{
 for(const [name,id] of cases)for(const vp of viewports){
  const context=await browser.newContext({viewport:vp,serviceWorkers:'block'})
  try{
   const page=await context.newPage()
   const manifest=await (await context.request.get(base+'wiki-reader/manifest.json',{timeout:15000})).json()
   const index=await (await context.request.get(base+'wiki-reader/'+manifest.catalogIndex,{timeout:15000})).json()
   const entry=index.entries.find(x=>x.id===id)
   if(!entry)throw Error('Live article missing '+id)
   const shard=await (await context.request.get(base+'wiki-reader/'+entry.shard+'.json',{timeout:15000})).json()
   const source=shard.find(s=>s.sourceUrl===id)
   if(!source)throw Error('Live source not found')
   await page.route('**/wiki-reader/manifest.json*',r=>r.fulfill({json:{...manifest,total:1,withVerifiedPhoto:1}}))
   await page.route('**/wiki-reader/'+manifest.catalogIndex+'*',r=>r.fulfill({json:{...index,total:1,entries:[entry]}}))
   const response=await page.goto(base,{waitUntil:'domcontentloaded',timeout:20000})
   if(!response?.ok())throw Error('Production navigation failed')
   const active=page.locator('.story-layer:not(.outgoing)')
   await active.locator('.article-text').waitFor({state:'visible',timeout:20000})
   await page.evaluate(()=>document.fonts.ready)
   const article={name,id,viewport:vp,layoutVersion:source.readerLayoutVersion||0,manifestHash:manifest.contentHash,levels:[]}
   for(const [level,label] of levels){
    await active.getByRole('radio',{name:'Level '+label,exact:true}).click()
    await page.waitForTimeout(550)
    const total=Number((await active.locator('.lore-page-count').innerText()).split('/')[1])
    if(!Number.isInteger(total)||total<1||total>40)throw Error('Unexpected pager '+total)
    const metrics=[], texts=[]
    for(let i=1;i<=total;i++){
     await page.waitForFunction(expected=>document.querySelector('.story-layer:not(.outgoing) .lore-page-count')?.textContent?.trim()===expected,`${i}/${total}`,{timeout:10000})
     await page.waitForTimeout(350)
     const m=await active.evaluate(root=>{
      const get=s=>root.querySelector(s)?.getBoundingClientRect()
      const surface=get('.page-surface'),text=get('.article-text'),pager=get('.page-control')
      const nav=document.querySelector('.bottom-nav').getBoundingClientRect()
      return {photo:Boolean(root.querySelector('.article-media:not(.article-media-empty)')),fill:(text.bottom-surface.top)/Math.max(1,pager.top-surface.top),bodyFill:text.height/Math.max(1,pager.top-12-text.top),bottomGap:pager.top-text.bottom,navOverlap:Math.max(0,text.bottom-nav.top),fontSize:parseFloat(getComputedStyle(root.querySelector('.article-text')).fontSize),dense:root.querySelector('.page-surface').classList.contains('saga-page--dense')}
     })
     metrics.push(m)
     texts.push((await active.locator('.article-text > .article-paragraph').allTextContents()).join(' '))
     await page.screenshot({path:out+'/'+name+'-'+level+'-'+vp.width+'x'+vp.height+'-'+i+'.png'})
     if(i<total)await active.getByRole('button',{name:'Next page',exact:true}).click()
    }
    const sameText=norm(texts.join(' '))===norm(source.levelVariants[level].pages.map(p=>p.text).join(' '))
    const v3=source.readerLayoutVersion===3
    if(v3&&(!sameText||total!==source.levelVariants[level].pages.length||total<4||total>(level==='A1-A2'?6:8)||metrics.some(m=>m.dense||m.bodyFill<.80||m.bottomGap<0||m.navOverlap>0)))report.errors.push(name+' '+level+' '+vp.width+'x'+vp.height+' failed approved layout')
    article.levels.push({level,total,sameText,pages:metrics})
    for(let i=total;i>1;i--){
     await active.getByRole('button',{name:'Previous page',exact:true}).click()
     await page.waitForFunction(expected=>document.querySelector('.story-layer:not(.outgoing) .lore-page-count')?.textContent?.trim()===expected,`${i-1}/${total}`,{timeout:10000})
     await page.waitForTimeout(200)
    }
   }
   report.articles.push(article)
  }finally{await context.close()}
 }
}catch(error){report.errors.push(String(error?.message||error))}
finally{
 await browser.close()
 await writeFile(out+'/metrics.json',JSON.stringify(report,null,2))
 console.log('PRODUCTION VISUAL AUDIT',JSON.stringify(report))
 if(report.errors.length)process.exitCode=1
}
