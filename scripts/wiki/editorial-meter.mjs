// Layout-first copyfitting using the actual candidate Reader DOM and CSS.
// No LLM, no screenshot inference, no remote app changes.
import {chromium} from '@playwright/test'

const levels=['A1-A2','B1-B2','C1-C2']
const viewports=[{width:390,height:844},{width:430,height:932},{width:1366,height:768}]
const specimens={
 'A1-A2':'People often learn about the past by looking at old things. A picture can help us see how people lived. It can show a place, a person or a way of life. We can read about these things and ask why they were important. Some answers are easy to find. Other answers take more time.',
 'B1-B2':'Historical records offer a useful starting point for understanding earlier societies. However, a single document rarely explains every aspect of an event. Readers can compare descriptions, consider the circumstances in which they were written and distinguish reliable evidence from later interpretations.',
 'C1-C2':'Historical interpretation depends on the relationship between surviving evidence and the circumstances of its production. Apparent contradictions may reflect differences in perspective rather than straightforward factual disagreement. A convincing account therefore distinguishes documented observations from plausible but necessarily qualified inferences.'
}
const sample=(level,n)=>{
 const words=(specimens[level]+' ').repeat(Math.ceil(n/specimens[level].length)+1).split(/\s+/)
 let out=''
 for(const w of words){if(out.length+w.length+1>n)break;out+=(out?' ':'')+w}
 const a=out.split(' '), cut=Math.floor(a.length/2)
 return a.slice(0,cut).join(' ')+'\n\n'+a.slice(cut).join(' ')
}
const runMeasure=async(page,rows)=>page.evaluate(rows=>{
 const live=document.querySelector('.story-layer:not(.outgoing) .reader-gesture')
 if(!live)throw Error('Missing actual reader')
 const b=live.getBoundingClientRect()
 const root=live.cloneNode(true)
 root.classList.add('layout-measure-fixture')
 root.dataset.editorialLayout='shared'
 root.dataset.readingScale=''
 Object.assign(root.style,{position:'fixed',left:'-20000px',top:'0',width:b.width+'px',height:b.height+'px',minHeight:'0',visibility:'hidden',pointerEvents:'none',transform:'none'})
 live.parentElement.append(root)
 try{
  const surface=root.querySelector('.page-surface'), heading=root.querySelector('.article-heading'), h1=heading.querySelector('h1'), media=root.querySelector('.article-media'), card=root.querySelector('.reading-card'), body=root.querySelector('.article-text'), pager=root.querySelector('.page-control')
  surface.className='page-surface'
  heading.querySelector('.deck')?.remove()
  root.querySelector('.source-footer')?.remove()
  return rows.map(row=>{
   root.dataset.readingLevel=row.level
   h1.textContent=row.headline||'A closer look at our world'
   h1.classList.toggle('lore-headline-long',h1.textContent.length>45)
   heading.classList.toggle('post-head--continued',!row.cover)
   heading.classList.toggle('article-heading-continued',!row.cover)
   heading.classList.toggle('post-head--no-image',!row.photo)
   heading.classList.remove('post-head--cover-no-image')
   surface.classList.toggle('saga-page--text-only',!row.photo)
   card.classList.toggle('reading-card-with-photo',row.photo)
   card.classList.toggle('reading-card-no-photo',!row.photo)
   media.classList.toggle('article-media-empty',!row.photo)
   media.style.display=row.photo?'flex':'none'
   media.replaceChildren()
   if(row.photo){
    const fig=document.createElement('figure')
    fig.className='photo-figure lore-photo-figure hero-media'
    const cap=document.createElement('p')
    cap.className='lore-photo-caption'
    cap.textContent=row.caption||'A photograph from the source article'
    media.append(fig,cap)
   }
   body.replaceChildren()
   for(const paragraph of String(row.text).split(/\n\s*\n/)){
    const p=document.createElement('p');p.className='article-paragraph'
    // Use real reader word-token styling, not a monospace estimate.
    for(const token of paragraph.split(/(\s+)/)){
     if(!token)continue
     if(/^\s+$/.test(token))p.append(document.createTextNode(token))
     else{const button=document.createElement('button');button.type='button';button.className='word-token';button.textContent=token;p.append(button)}
    }
    body.append(p)
   }
   const text=body.getBoundingClientRect(), safe=pager.getBoundingClientRect().top-12
   const available=Math.max(1,safe-text.top)
   const font=getComputedStyle(body)
   return {...row,text:undefined,usedPx:Math.round(text.height),availablePx:Math.round(available),fill:text.height/available,overflowPx:Math.max(0,Math.ceil(text.bottom-safe)),lineHeight:parseFloat(font.lineHeight),width:Math.round(text.width)}
  })
 }finally{root.remove()}
},rows)

export async function openEditorialMeter(baseURL){
 const browser=await chromium.launch({headless:true})
 const pages=[]
 try{
  for(const vp of viewports){
   const ctx=await browser.newContext({viewport:vp,serviceWorkers:'block'})
   const page=await ctx.newPage()
   await page.goto(baseURL,{waitUntil:'domcontentloaded'})
   await page.locator('.story-layer:not(.outgoing) .article-text').waitFor({state:'visible',timeout:30000})
   await page.evaluate(()=>document.fonts.ready)
   pages.push({page,vp})
  }
  const probes=[]
  for(const level of levels)for(const type of ['cover','photo','text'])for(let chars=200;chars<=1500;chars+=25)probes.push({level,type,photo:type!=='text',cover:type==='cover',chars,text:sample(level,chars)})
  const measured=[]
  for(const {page,vp} of pages)measured.push({vp,rows:await runMeasure(page,probes)})
  const budgets={}
  for(const level of levels){
   budgets[level]={}
   for(const type of ['cover','photo','text']){
    const candidates=probes.filter(p=>p.level===level&&p.type===type).map(p=>{
     const rows=measured.map(m=>m.rows.find(r=>r.level===level&&r.type===type&&r.chars===p.chars))
     return {chars:p.chars,rows,loss:rows.reduce((sum,r)=>sum+(r.fill-.90)**2+10*Math.max(0,r.fill-1)**2,0)}
    })
    const safe=candidates.filter(c=>c.rows.every(r=>r.overflowPx===0))
    if(!safe.length)throw Error('No safe measured body budget '+level+' '+type)
    const best=safe.sort((a,b)=>a.loss-b.loss)[0]
    const range=safe.filter(c=>c.rows.every(r=>r.fill>=.80&&r.fill<=.98)).map(c=>c.chars)
    budgets[level][type]={target:best.chars,targetWords:sample(level,best.chars).trim().split(/\s+/).length,min:range.length?Math.min(...range):Math.round(best.chars*.92),max:range.length?Math.max(...range):best.chars,compatible:range.length>0,viewports:best.rows.map((r,i)=>({viewport:measured[i].vp,availablePx:r.availablePx,fill:Number(r.fill.toFixed(3)),lineHeight:r.lineHeight}))}
   }
  }
  console.log('[editorial-meter] MEASURED BUDGETS',JSON.stringify(budgets))
  const audit=async(variants)=>{
   const rows=levels.flatMap(level=>(variants[level]?.pages||[]).map((p,i)=>({level,index:i,cover:i===0,photo:Boolean(p.image||p.imageId)||i===0,caption:p.caption,headline:variants[level].headline,text:p.text})))
   const metrics=[]
   for(const {page,vp} of pages)metrics.push({vp,rows:await runMeasure(page,rows)})
   const errors=[]
   for(const row of rows){
    const observed=metrics.map(m=>({vp:m.vp,...m.rows.find(r=>r.level===row.level&&r.index===row.index)}))
    if(observed.some(m=>m.fill<.80||m.overflowPx>0)){
     const chars=row.text.replace(/\s+/g,' ').trim().length
     const words=row.text.trim().split(/\s+/).length
     const lower=Math.ceil(Math.max(...observed.map(m=>chars*.82/Math.max(.01,m.fill))))
     const upper=Math.floor(Math.min(...observed.map(m=>chars*.98/Math.max(.01,m.fill))))
     const target=Math.max(1,Math.round((lower+upper)/2))
     errors.push(row.level+' page '+(row.index+1)+' ('+(row.cover?'cover':row.photo?'photo':'text-only')+'): current '+chars+' chars / '+words+' words; measured '+observed.map(m=>m.vp.width+'x'+m.vp.height+' '+Math.round(m.fill*100)+'% ('+m.usedPx+'/'+m.availablePx+' px)').join('; ')+'; rewrite to approximately '+target+' chars / '+Math.round(words*target/Math.max(1,chars))+' words, estimated compatible range '+lower+'–'+upper+' chars. Keep two natural paragraphs and all source-grounded facts.')
    }
   }
   for(const {vp,rows:ms} of metrics)for(const level of levels)for(const photo of [true,false]){
    const group=ms.filter(r=>r.level===level&&r.photo===photo)
    if(group.length<2)continue
    const fills=group.map(r=>r.fill)
    if(Math.max(...fills)-Math.min(...fills)>.15){
     for(const r of group)if(Math.abs(r.fill-.90)>.075)errors.push(level+' page '+(r.index+1)+': same-type visual imbalance at '+vp.width+'x'+vp.height+', body fill '+Math.round(r.fill*100)+'%; target 90%.')
    }
   }
   console.log('[editorial-meter] CARD AUDIT',JSON.stringify(metrics))
   return errors
  }
  return {budgets,audit,close:()=>browser.close()}
 }catch(error){await browser.close();throw error}
}
