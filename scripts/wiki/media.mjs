/** Context decisions for files already embedded in one pinned Wikipedia article. */
const filler=new Set('about above after again also among article being between caption century commons during first from history image images into large main many other people photo picture shown shows some source their these this those through under which while with world years'.split(' '))
const terms=value=>new Set(String(value||'').toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g,' ').split(/\s+/)
 .filter(word=>word.length>=4&&!filler.has(word)).map(word=>word.endsWith('ing')&&word.length>6?word.slice(0,-3):
  word.endsWith('s')&&word.length>4?word.slice(0,-1):word))
const hits=(a,b)=>[...terms(a)].filter(word=>terms(b).has(word)).length
const year=value=>String(value||'').match(/\b(?:1[5-9]|20)\d{2}\b/g)||[]
const imageTopic=photo=>`${photo.caption} ${photo.alt} ${photo.description} ${photo.fileTitle.replace(/^File:/,'')}`
const chart=/\b(?:chart|graph|plot|statistics|dataset|data|rate|index|trend)\b/i

/** Rights proof alone leaves a candidate in REVIEW. This function requires
 * source-article placement plus a concrete subject match with a target page. */
export function decideWikipediaPhoto(candidate,{source,levelVariants,usedUrls=new Set(),preferLater=false}={}){
 if(candidate.status==='REJECTED'||!candidate.photo)return candidate
 const photo=candidate.photo,subject=imageTopic(photo)
 if(!source?.figures?.some(f=>f.fileTitle===photo.fileTitle))return {...candidate,status:'REJECTED',reason:'not-embedded-in-source-revision'}
 if(usedUrls.has(photo.url)||usedUrls.has(photo.provenance.imagePageUrl))return {...candidate,status:'REJECTED',reason:'image-already-used'}
 const levels=['A1-A2','B1-B2','C1-C2']
 const variants=levels.map(level=>levelVariants?.[level]?.pages)
 if(variants.some(pages=>!Array.isArray(pages)||!pages.length))return {...candidate,status:'REVIEW',reason:'reading-pages-unavailable'}
 const explicitYears=year(photo.caption+' '+photo.description+' '+photo.date)
 const isChart=chart.test(photo.fileTitle+' '+photo.caption)
 const specific=[...terms(subject)].filter(word=>!terms(source.sourceTitle).has(word))
 const scores=[]
 const length=Math.min(...variants.map(pages=>pages.length))
 for(let pageIndex=0;pageIndex<length;pageIndex++){
  const texts=variants.map(pages=>pages[pageIndex].text)
  const overlaps=texts.map(text=>hits(photo.caption+' '+photo.alt,text))
  const periodOk=!isChart||!explicitYears.length||texts.every(text=>explicitYears.some(value=>text.includes(value)))
  if(!periodOk)continue
  const titleHits=hits(photo.caption+' '+photo.alt+' '+photo.fileTitle,source.sourceTitle)
  const contextOk=overlaps.every(count=>count>=1)
  if(!contextOk)continue
  if(pageIndex===0){
   if(titleHits<1&&overlaps.some(count=>count<2))continue
  }else if(overlaps.some(count=>count<2)&&titleHits<1)continue
  const specificHits=texts.map(text=>specific.filter(word=>terms(text).has(word)).length)
  scores.push({pageIndex,score:overlaps.reduce((a,b)=>a+b,0)+titleHits*(pageIndex===0?4:1)-pageIndex*.2,
   specificMin:Math.min(...specificHits),titleHits})
 }
 if(!scores.length)return {...candidate,status:'REVIEW',reason:isChart?'chart-period-or-page-context-unproven':'visible-subject-page-context-unproven'}
 const reconstruction=/\b(?:reconstruction|re-creation|replica)\b/i.test(photo.caption)
 const eligible=preferLater?scores.filter(row=>row.pageIndex>0&&row.specificMin>=1&&row.titleHits>=1&&
  (!reconstruction||/\b(?:hypothetical|reconstruction|re-creation|replica)\b/i.test(variants[0][row.pageIndex].text))):scores
 if(!eligible.length)return {...candidate,status:'REVIEW',reason:'later-page-specific-subject-unproven'}
 eligible.sort((a,b)=>preferLater?b.specificMin-a.specificMin||b.score-a.score:b.score-a.score)
 const choice=eligible[0]
 const archived=explicitYears.length&&year(source.sourceTitle).length&&!year(source.sourceTitle).some(value=>explicitYears.includes(value))
 const caption=String(photo.caption||photo.alt).replace(/\s+/g,' ').trim()
 return {...candidate,status:'VERIFIED',reason:'source-embedded-item-rights-and-page-subject',pageIndex:choice.pageIndex,matchScore:choice.score,
  photo:{...photo,caption,archive:!!archived,
   provenance:{...photo.provenance,sourceImageUrl:source.sourceUrl,sourceRevisionUrl:source.sourceRevisionUrl,
    evidence:{sourcePageId:source.pageId,sourceRevisionId:source.sourceRevisionId,fileTitle:photo.fileTitle,
     articleCaption:photo.caption,pageIndex:choice.pageIndex}}}}
}

export function assignWikipediaPhotos(decisions,source,levelVariants,{usedUrls=new Set()}={}){
 const approved=decisions.map(row=>decideWikipediaPhoto(row,{source,levelVariants,usedUrls})).filter(row=>row.status==='VERIFIED')
 const coverScore=row=>row.matchScore+(/\.(?:jpe?g|webp)$/i.test(row.photo.fileTitle)?2:0)
 const directLead=approved.filter(row=>row.pageIndex===0).sort((a,b)=>coverScore(b)-coverScore(a)||a.photo.position-b.photo.position)[0]
 // A source article's own first photo can introduce a detail explained later in the story.
 // Keep its full caption on the cover, and only use it after a later page has proved the subject match.
 const sourceLead=approved.filter(row=>row.photo.position===0&&!chart.test(row.photo.fileTitle+' '+row.photo.caption))
  .sort((a,b)=>coverScore(b)-coverScore(a))[0]
 const lead=directLead||(!sourceLead?null:{...sourceLead,pageIndex:0,photo:{...sourceLead.photo,
  provenance:{...sourceLead.photo.provenance,evidence:{...sourceLead.photo.provenance.evidence,pageIndex:0}}}})
 if(!lead)return {status:'REVIEW',reason:'no-verified-lead-photo',decisions:approved}
 const byPage=new Map([[0,lead]])
 const chosen=new Set([lead.photo.url])
 const later=decisions.map(row=>decideWikipediaPhoto(row,{source,levelVariants,usedUrls,preferLater:true}))
  .filter(row=>row.status==='VERIFIED').sort((a,b)=>b.matchScore-a.matchScore||a.photo.position-b.photo.position)
 for(const row of later){
  if(row===lead||byPage.has(row.pageIndex)||chosen.has(row.photo.url))continue
  byPage.set(row.pageIndex,row);chosen.add(row.photo.url)
 }
 const variants=structuredClone(levelVariants)
 for(const [pageIndex,row] of byPage)for(const level of ['A1-A2','B1-B2','C1-C2']){
  Object.assign(variants[level].pages[pageIndex],{image:row.photo.url,caption:row.photo.caption,imageProvenance:row.photo.provenance})
 }
 return {status:'VERIFIED',levelVariants:variants,photos:[...byPage.values()].map(row=>({pageIndex:row.pageIndex,...row.photo})),decisions:approved}
}
