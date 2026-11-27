// Layout-first copyfitting using the actual candidate Reader DOM and CSS.
// No LLM, no screenshot inference, no remote app changes.
import {chromium} from '@playwright/test'

const levels=['A1-A2','B1-B2','C1-C2']
export const COMPACT_VIEWPORTS=[{width:375,height:667}]
export const PRIMARY_VIEWPORTS=[{width:390,height:844},{width:430,height:932},{width:1366,height:768}]
export const METER_VIEWPORTS=[...COMPACT_VIEWPORTS,...PRIMARY_VIEWPORTS]
export const COMPACT_MICRO_FIT_FLOOR=Object.freeze({
 fontSizePx:15,
 lineHeight:1.42,
 photoMaxHeightDvh:18,
 photoMinHeightPx:105,
})
export const EDITORIAL_DENSITY_POLICY=Object.freeze({
 targetFill:0.72,
 calibrationMinFill:0.45,
 acceptanceMinFill:0.45,
 calibrationMaxFill:0.90,
 acceptanceMaxFill:0.94,
 imbalanceSpread:0.32,
 imbalanceTolerance:0.16,
 minLines:Object.freeze({cover:3,photo:3,'text-only':5}),
})

export const isCompactViewport=vp=>COMPACT_VIEWPORTS.some(c=>c.width===vp?.width&&c.height===vp?.height)
export const isPrimaryViewport=vp=>PRIMARY_VIEWPORTS.some(p=>p.width===vp?.width&&p.height===vp?.height)
export const pageTypeOfRow=row=>{
 if(row?.pageType==='cover'||row?.pageType==='photo'||row?.pageType==='text-only')return row.pageType
 if(row?.type==='cover'||row?.type==='photo')return row.type
 if(row?.type==='text')return 'text-only'
 if(row?.cover||row?.index===0)return 'cover'
 return row?.photo?'photo':'text-only'
}
export const minLinesForPageType=pageType=>EDITORIAL_DENSITY_POLICY.minLines[pageType==='text'?'text-only':pageType]??3

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
const runMeasure=async(page,rows,{applyCompactMicroFit=false}={})=>page.evaluate(({rows,applyCompactMicroFit,microFit})=>{
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
  if(applyCompactMicroFit){
   // Mirror live Reader computeBoundedMicroFit() floor on compact 375x667 screens.
   surface.style.setProperty('--saga-fit-body-size',microFit.fontSizePx+'px')
   surface.style.setProperty('--saga-fit-line-height',String(microFit.lineHeight))
   surface.style.setProperty('--saga-fit-photo-max-h',`max(${microFit.photoMinHeightPx}px, ${microFit.photoMaxHeightDvh}dvh)`)
  }else{
   surface.style.removeProperty('--saga-fit-body-size')
   surface.style.removeProperty('--saga-fit-line-height')
   surface.style.removeProperty('--saga-fit-photo-max-h')
  }
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
   const lineHeight=parseFloat(font.lineHeight)||24
   const paras=[...body.querySelectorAll(':scope > .article-paragraph')]
   const renderedLines=paras.length
    ?paras.reduce((sum,p)=>{const h=p.getBoundingClientRect().height;return sum+(h>0?Math.max(1,Math.round(h/lineHeight)):0)},0)
    :Math.max(0,Math.round(text.height/lineHeight))
   return {...row,text:undefined,usedPx:Math.round(text.height),availablePx:Math.round(available),fill:text.height/available,overflowPx:Math.max(0,Math.ceil(text.bottom-safe)),lineHeight,renderedLines,width:Math.round(text.width)}
  })
 }finally{root.remove()}
},{rows,applyCompactMicroFit,microFit:COMPACT_MICRO_FIT_FLOOR})

export function calibrateEditorialBudgets(probes,measured){
 const budgets={}
 for(const level of levels){
  budgets[level]={}
  for(const type of ['cover','photo','text']){
   const minLines=minLinesForPageType(type)
   const candidates=probes.filter(p=>p.level===level&&p.type===type).map(p=>{
    const allRows=measured.map(m=>({vp:m.vp,...m.rows.find(r=>r.level===level&&r.type===type&&r.chars===p.chars)}))
    const primaryRows=allRows.filter(r=>isPrimaryViewport(r.vp))
    const densityRows=primaryRows.length?primaryRows:allRows
    return {
     chars:p.chars,
     allRows,
     densityRows,
     loss:densityRows.reduce((sum,r)=>sum+(r.fill-EDITORIAL_DENSITY_POLICY.targetFill)**2+10*Math.max(0,r.fill-EDITORIAL_DENSITY_POLICY.acceptanceMaxFill)**2,0)
    }
   })
   const safe=candidates.filter(c=>c.allRows.every(r=>r.overflowPx===0))
   if(!safe.length)throw Error('No safe measured body budget '+level+' '+type)
   const lineSafe=safe.filter(c=>c.densityRows.every(r=>!Number.isFinite(r.renderedLines)||r.renderedLines>=minLines))
   const pool=lineSafe.length?lineSafe:safe
   const best=pool.sort((a,b)=>a.loss-b.loss)[0]
   const range=pool
    .filter(c=>c.densityRows.every(r=>r.fill>=EDITORIAL_DENSITY_POLICY.calibrationMinFill&&r.fill<=EDITORIAL_DENSITY_POLICY.calibrationMaxFill))
    .map(c=>c.chars)
   budgets[level][type]={
    target:best.chars,
    targetWords:sample(level,best.chars).trim().split(/\s+/).length,
    min:range.length?Math.min(...range):Math.round(best.chars*.90),
    max:range.length?Math.max(...range):best.chars,
    compatible:range.length>0,
    viewports:best.allRows.map(r=>({viewport:r.vp,availablePx:r.availablePx,fill:Number(r.fill.toFixed(3)),lineHeight:r.lineHeight,renderedLines:r.renderedLines??null}))
   }
  }
 }
 return budgets
}

export function auditEditorialMetrics(rows,metrics){
 const errors=[]
 for(const row of rows){
  const pageType=pageTypeOfRow(row)
  const minLines=minLinesForPageType(pageType)
  const observed=metrics.map(m=>({vp:m.vp,...m.rows.find(r=>r.level===row.level&&r.index===row.index)}))
  const primaryObserved=observed.filter(m=>isPrimaryViewport(m.vp))
  const densityObserved=primaryObserved.length?primaryObserved:observed
  const hasOverflow=observed.some(m=>m.overflowPx>0)
  const minFill=EDITORIAL_DENSITY_POLICY.acceptanceMinFill??EDITORIAL_DENSITY_POLICY.calibrationMinFill
  const belowFloor=densityObserved.some(m=>m.fill<minFill)
  const aboveCeiling=densityObserved.some(m=>m.fill>EDITORIAL_DENSITY_POLICY.acceptanceMaxFill)
  const tooFewLines=densityObserved.some(m=>Number.isFinite(m.renderedLines)&&m.renderedLines<minLines)

  if(hasOverflow||belowFloor||aboveCeiling){
   const chars=String(row.text||'').replace(/\s+/g,' ').trim().length
   const words=String(row.text||'').trim().split(/\s+/).filter(Boolean).length
   const lower=Math.ceil(Math.max(...densityObserved.map(m=>chars*minFill/Math.max(.01,m.fill))))
   const primaryUpper=Math.floor(Math.min(...densityObserved.map(m=>chars*EDITORIAL_DENSITY_POLICY.calibrationMaxFill/Math.max(.01,m.fill))))
   const compactUpper=Math.floor(Math.min(...observed.map(m=>chars*0.98/Math.max(.01,m.fill))))
   const upper=Math.min(primaryUpper,compactUpper)
   const target=Math.max(1,Math.round((lower+Math.max(lower,upper))/2))
   const paraHint=pageType==='text-only'?'2–3 natural paragraphs':'1–2 natural paragraphs'
   const reasons=[]
   if(hasOverflow)reasons.push('overflow')
   if(aboveCeiling)reasons.push('utilization too high')
   if(belowFloor)reasons.push('utilization too low')
   const reasonTag=reasons.join(' / ')
   errors.push(row.level+' page '+(row.index+1)+' ('+pageType+'): '+reasonTag+' — current '+chars+' chars / '+words+' words; measured '+observed.map(m=>m.vp.width+'x'+m.vp.height+' '+Math.round(m.fill*100)+'% ('+m.usedPx+'/'+m.availablePx+' px'+(m.overflowPx>0?', overflow '+m.overflowPx+'px':'')+(Number.isFinite(m.renderedLines)?', '+m.renderedLines+'L':'')+')').join('; ')+'; rewrite to approximately '+target+' chars / '+Math.round(words*target/Math.max(1,chars))+' words, estimated compatible range '+lower+'–'+Math.max(lower,upper)+' chars. Keep '+paraHint+' and all source-grounded facts.')
  }
  if(tooFewLines){
   const failing=densityObserved.filter(m=>Number.isFinite(m.renderedLines)&&m.renderedLines<minLines)
   errors.push(row.level+' page '+(row.index+1)+' ('+pageType+'): too few rendered lines ('+failing.map(m=>m.vp.width+'x'+m.vp.height+' '+m.renderedLines+'L').join(', ')+'); requires at least '+minLines+' rendered lines.')
  }
 }
 for(const {vp,rows:ms} of metrics){
  if(!isPrimaryViewport(vp))continue
  for(const level of levels){
   for(const pageType of ['cover','photo','text-only']){
    const group=ms.filter(r=>r.level===level&&pageTypeOfRow(r)===pageType)
    if(group.length<2)continue
    const fills=group.map(r=>r.fill)
    if(Math.max(...fills)-Math.min(...fills)>EDITORIAL_DENSITY_POLICY.imbalanceSpread){
     for(const r of group){
      if(Math.abs(r.fill-EDITORIAL_DENSITY_POLICY.targetFill)>EDITORIAL_DENSITY_POLICY.imbalanceTolerance){
       errors.push(level+' page '+(r.index+1)+' ('+pageType+'): same-type visual imbalance at '+vp.width+'x'+vp.height+', body fill '+Math.round(r.fill*100)+'%; target '+Math.round(EDITORIAL_DENSITY_POLICY.targetFill*100)+'%.')
      }
     }
    }
   }
  }
 }
 return errors
}

export async function openEditorialMeter(baseURL){
 const browser=await chromium.launch({headless:true})
 const pages=[]
 try{
  for(const vp of METER_VIEWPORTS){
   const ctx=await browser.newContext({viewport:vp,serviceWorkers:'block'})
   const page=await ctx.newPage()
   await page.goto(baseURL,{waitUntil:'domcontentloaded'})
   await page.locator('.story-layer:not(.outgoing) .article-text').waitFor({state:'visible',timeout:30000})
   await page.evaluate(()=>document.fonts.ready)
   pages.push({page,vp})
  }
  const probes=[]
  for(const level of levels)for(const type of ['cover','photo','text'])for(let chars=150;chars<=1500;chars+=25)probes.push({level,type,photo:type!=='text',cover:type==='cover',chars,text:sample(level,chars)})
  const measured=[]
  for(const {page,vp} of pages)measured.push({vp,rows:await runMeasure(page,probes,{applyCompactMicroFit:isCompactViewport(vp)})})
  const budgets=calibrateEditorialBudgets(probes,measured)
  console.log('[editorial-meter] MEASURED BUDGETS',JSON.stringify(budgets))
  const audit=async(variants)=>{
   const rows=levels.flatMap(level=>(variants[level]?.pages||[]).map((p,i)=>({level,index:i,cover:i===0,photo:Boolean(p.image||p.imageId)||i===0,pageType:i===0?'cover':((p.image||p.imageId)?'photo':'text-only'),caption:p.caption,headline:variants[level].headline,text:p.text})))
   const metrics=[]
   for(const {page,vp} of pages)metrics.push({vp,rows:await runMeasure(page,rows,{applyCompactMicroFit:isCompactViewport(vp)})})
   const errors=auditEditorialMetrics(rows,metrics)
   console.log('[editorial-meter] CARD AUDIT',JSON.stringify(metrics))
   return errors
  }
  return {budgets,audit,close:()=>browser.close()}
 }catch(error){await browser.close();throw error}
}
