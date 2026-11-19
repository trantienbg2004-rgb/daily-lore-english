/** Automated content-to-source and image-to-page alignment audit for SAGA Wiki stories. */
import {createHash} from 'node:crypto'
import {validateWikiStory,WIKI_TARGET_STORIES,WIKI_TARGET_PER_TOPIC} from './catalog.mjs'
import {WIKI_TOPICS} from './discovery.mjs'
import {eraCompatible} from './media.mjs'

const LEVELS=['A1-A2','B1-B2','C1-C2']
const filler=new Set('about above after again also among article being between caption century commons during first from history image images into large main many other people photo picture shown shows some source their these this those through under which while with world years'.split(' '))
const countWords=text=>String(text||'').trim().split(/\s+/).filter(Boolean).length
const digest=text=>createHash('sha256').update(text).digest('hex')
const numerals=text=>[...String(text||'').matchAll(/\b\d+(?:[.,]\d+)*%?\b/g)].map(x=>x[0].replace(/[,.]/g,''))
const significant=text=>new Set(String(text||'').toLowerCase().match(/[a-z]{5,}/g)||[])
const terms=value=>new Set(String(value||'').toLowerCase().normalize('NFKD').replace(/[^a-z]+/g,' ').split(/\s+/)
 .filter(word=>word.length>=4&&!filler.has(word)).map(word=>word.endsWith('ing')&&word.length>6?word.slice(0,-3):
  word.endsWith('s')&&word.length>4?word.slice(0,-1):word))
const hits=(a,b)=>[...terms(a)].filter(word=>terms(b).has(word)).length
const chartRe=/\b(?:chart|graph|plot|statistics|dataset|data|rate|index|trend)\b/i
const normSection=value=>String(value||'').trim().toLowerCase()||'lead'

export function auditWikiStory(story,{source=null}={}){
 const errors=[]
 const gate=validateWikiStory(story)
 if(!gate.accepted)errors.push(...gate.errors)

 const evMap=new Map((story?.sourceEvidence||[]).map(row=>[row.id,row]))
 let sourceByHash=null
 let sourceFigures=null
 let figSectionByTitle=new Map()
 let fullSourceText=''
 if(source){
  if(source.pageId!==story?.sourcePageId||source.sourceRevisionId!==story?.sourceRevisionId){
   errors.push('source-revision-identity-mismatch')
  }
  const paragraphs=source.paragraphDetails?.length
   ?source.paragraphDetails
   :(source.paragraphs||[]).map(text=>({heading:'',text}))
  sourceByHash=new Map(paragraphs.map(row=>[digest(row.text),row]))
  fullSourceText=paragraphs.map(row=>row.text).join(' ')+' '+source.sourceTitle
  for(const row of story?.sourceEvidence||[]){
   const matched=sourceByHash.get(row.hash)
   if(!matched)errors.push(`source-evidence-hash-missing:${row.id}`)
   else evMap.set(row.id,{...row,heading:row.heading||matched.heading||'Lead',fullText:matched.text})
  }
  sourceFigures=new Set((source.figures||[]).map(f=>f.fileTitle))
  figSectionByTitle=new Map((source.figures||[]).map(f=>[f.fileTitle,normSection(f.heading)]))
 }

 const headlines=[]
 for(const level of LEVELS){
  const variant=story?.levelVariants?.[level]
  if(!variant){errors.push(`${level}:missing`);continue}
  if(typeof variant.headline!=='string'||variant.headline.length<10||variant.headline.length>60){
   errors.push(`${level}:headline-length`)
  }else{
   headlines.push(variant.headline.toLowerCase())
  }
  const pages=variant.pages||[]
  if(pages.length<5||pages.length>7)errors.push(`${level}:page-count`)

  for(const [pageIndex,page] of pages.entries()){
   const label=`${level}:page-${pageIndex+1}`
   const words=countWords(page?.text)
   if(typeof page?.text!=='string'||words<(pageIndex===0?30:28)||words>(pageIndex===0?66:105)||!/[.!?]$/.test(page.text.trim())){
    errors.push(`${label}:length-or-sentence`)
   }

   if(source){
    const citedFull=(page.evidenceIds||[]).map(id=>evMap.get(id)?.fullText||'').join(' ')
    const sourceTerms=significant(fullSourceText)
    const overlap=[...significant(page.text)].filter(w=>significant(citedFull).has(w)&&sourceTerms.has(w)).length
    if(overlap<3)errors.push(`${label}:source-evidence-overlap`)
    const citedNumbers=new Set(numerals(citedFull))
    for(const sentence of String(page.text||'').split(/(?<=[.!?])\s+/)){
     for(const num of numerals(sentence)){
      if(!citedNumbers.has(num)){errors.push(`${label}:unsupported-number:${num}`);continue}
      const grounded=citedFull.split(/(?<=[.!?])\s+/).filter(part=>numerals(part).includes(num))
       .some(part=>[...significant(sentence)].filter(t=>significant(part).has(t)).length>=2)
      if(!grounded)errors.push(`${label}:unsupported-number-context:${num}`)
     }
    }
   }

   if(page.image){
    const prov=page.imageProvenance||{}
    const ev=prov.evidence||{}
    if(prov.originType!=='wikipedia-embedded')errors.push(`${label}:image-origin`)
    if(ev.pageIndex!==pageIndex)errors.push(`${label}:image-page-index-drift`)
    if(sourceFigures&&!sourceFigures.has(ev.fileTitle))errors.push(`${label}:image-missing-in-source`)
    const articleCaption=String(ev.articleCaption||page.caption||'')
    const rawSection=ev.articleSection||(figSectionByTitle.size?figSectionByTitle.get(ev.fileTitle):'')
    if(rawSection&&evMap.size>0){
     const articleSection=normSection(rawSection)
     if(articleSection!=='lead'){
      const citedSections=(page.evidenceIds||[]).map(id=>normSection(evMap.get(id)?.heading))
      if(!citedSections.includes(articleSection)){
       errors.push(`${label}:image-section-mismatch:${articleSection}`)
      }
     }
    }
    const captionOverlap=hits(articleCaption+' '+(ev.fileTitle||'').replace(/^File:/,''),page.text)
    const titleOverlap=hits(articleCaption+' '+(ev.fileTitle||'').replace(/^File:/,''),story.sourceTitle||'')
    if(captionOverlap<1&&(pageIndex>0||titleOverlap<1)){
     errors.push(`${label}:image-page-content-mismatch`)
    }
    if(chartRe.test(`${ev.fileTitle||''} ${articleCaption}`)){
     if(!eraCompatible({caption:articleCaption,fileTitle:ev.fileTitle||''},[page.text])){
      errors.push(`${label}:image-chart-era-mismatch`)
     }
    }else if(!eraCompatible({caption:articleCaption,fileTitle:ev.fileTitle||''},[page.text])){
     errors.push(`${label}:image-era-mismatch`)
    }
   }
  }
 }
 if(headlines.length===3&&new Set(headlines).size!==3)errors.push('headlines-not-distinct')

 return {
  accepted:errors.length===0,
  errors:[...new Set(errors)],
 }
}

export function auditWikiCatalog(stories,{sourcesByPageId=null,targetStories=WIKI_TARGET_STORIES,targetPerTopic=WIKI_TARGET_PER_TOPIC}={}){
 const list=Array.isArray(stories)?stories:[]
 const byTopic=Object.fromEntries(WIKI_TOPICS.map(t=>[t,0]))
 const seenIds=new Set()
 const usedImages=new Map()
 const failures=[]

 for(const story of list){
  const storyErrors=[]
  if(seenIds.has(story?.sourcePageId))storyErrors.push('duplicate-source-page-id')
  else if(Number.isSafeInteger(story?.sourcePageId))seenIds.add(story.sourcePageId)

  if(WIKI_TOPICS.includes(story?.category))byTopic[story.category]++
  else storyErrors.push('unknown-topic')

  const src=sourcesByPageId?.get?.(story?.sourcePageId)||null
  const res=auditWikiStory(story,{source:src})
  if(!res.accepted)storyErrors.push(...res.errors)

  for(const page of story?.pages||[]){
   if(!page.image)continue
   const owner=usedImages.get(page.image)
   if(owner&&owner!==story.sourcePageId)storyErrors.push(`image-reused-with:${owner}`)
   else usedImages.set(page.image,story.sourcePageId)
  }
  if(storyErrors.length){
   failures.push({pageId:story?.sourcePageId,title:story?.sourceTitle||story?.title,errors:[...new Set(storyErrors)]})
  }
 }

 const total=list.length
 const targetMet=total>=targetStories&&WIKI_TOPICS.every(t=>byTopic[t]>=targetPerTopic)
 const passed=failures.length===0&&targetMet
 return {passed,total,failed:failures.length,targetMet,targetStories,targetPerTopic,byTopic,uniqueImages:usedImages.size,failures}
}
