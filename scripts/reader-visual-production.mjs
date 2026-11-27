// Independent, read-only audit of the actual deployed site. Keep its output
// separate from candidate-build QA. No code interception, only deterministic
// selection of two public catalog entries so the before/after is comparable.
import { chromium } from '@playwright/test'
import { mkdir, writeFile } from 'node:fs/promises'

const base='https://saga.id.vn/'
const out='test-results/production-baseline'
const cases=[
  ['magna-carta','https://en.wikipedia.org/wiki/Magna_Carta'],
  ['goat','https://en.wikipedia.org/wiki/GOAT_(sports_culture)'],
]
await mkdir(out,{recursive:true})
const browser=await chromium.launch({headless:true})
const report={url:base,viewport:{width:1366,height:768},articles:[]}
try{
  for(const [name,id] of cases){
    const context=await browser.newContext({viewport:report.viewport,serviceWorkers:'block'})
    try{
      const page=await context.newPage()
      const manifestResponse=await context.request.get(base+'wiki-reader/manifest.json',{timeout:15000})
      if(!manifestResponse.ok())throw new Error('Live manifest HTTP '+manifestResponse.status())
      const manifest=await manifestResponse.json()
      const indexResponse=await context.request.get(base+'wiki-reader/'+manifest.catalogIndex,{timeout:15000})
      if(!indexResponse.ok())throw new Error('Live catalog HTTP '+indexResponse.status())
      const index=await indexResponse.json()
      const entry=index.entries.find(x=>x.id===id)
      if(!entry)throw new Error('Live article missing: '+id)
      await page.route('**/wiki-reader/manifest.json*',r=>r.fulfill({json:{...manifest,total:1,withVerifiedPhoto:1}}))
      await page.route('**/wiki-reader/'+manifest.catalogIndex+'*',r=>r.fulfill({json:{...index,total:1,entries:[entry]}}))
      const response=await page.goto(base,{waitUntil:'domcontentloaded',timeout:20000})
      if(!response?.ok())throw new Error('Production navigation failed')
      const active=page.locator('.story-layer:not(.outgoing)')
      await active.locator('.article-text').waitFor({state:'visible',timeout:20000})
      await active.getByRole('radio',{name:'Level A (A1-A2 Beginner)',exact:true}).click()
      await page.waitForTimeout(1000)
      const count=await active.locator('.lore-page-count').innerText()
      const total=Number(count.split('/')[1])
      if(!Number.isInteger(total)||total<1||total>40)throw new Error('Unexpected live pager: '+count)
      const article={name,id,total,pages:[]}
      for(let i=1;i<=total;i++){
        await page.waitForFunction(expected => document.querySelector('.story-layer:not(.outgoing) .lore-page-count')?.textContent?.trim() === expected, `${i}/${total}`, {timeout:10000})
        await page.waitForTimeout(500)
        const m=await active.evaluate(root=>{
          const get=s=>root.querySelector(s)?.getBoundingClientRect()
          const surface=get('.page-surface'),text=get('.article-text'),pager=get('.page-control')
          const nav=document.querySelector('.bottom-nav').getBoundingClientRect()
          return {fill:(text.bottom-surface.top)/Math.max(1,pager.top-surface.top),bottomGap:pager.top-text.bottom,textWidth:text.width,navOverlap:Math.max(0,text.bottom-nav.top),fontSize:parseFloat(getComputedStyle(root.querySelector('.article-text')).fontSize)}
        })
        article.pages.push(m)
        await page.screenshot({path:out+'/'+name+'-A-'+i+'.png'})
        if(i<total)await active.getByRole('button',{name:'Next page',exact:true}).click()
      }
      report.articles.push(article)
    }finally{await context.close()}
  }
}catch(error){
  report.error=String(error?.message||error)
  process.exitCode=1
}finally{
  await browser.close()
  await writeFile(out+'/metrics.json',JSON.stringify(report,null,2))
  console.log('PRODUCTION VISUAL AUDIT',JSON.stringify(report))
}
