/** Context decisions for files already embedded in one pinned Wikipedia article. */
const filler=new Set('about above after again also among article being between caption century commons during first from history image images into large main many other people photo picture shown shows some source their these this those through under which while with world years'.split(' '))
const terms=value=>new Set(String(value||'').toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g,' ').split(/\s+/)
 .filter(word=>word.length>=4&&!filler.has(word)).map(word=>word.endsWith('ing')&&word.length>6?word.slice(0,-3):
  word.endsWith('s')&&word.length>4?word.slice(0,-1):word))
const hits=(a,b)=>[...terms(a)].filter(word=>terms(b).has(word)).length
const year=value=>String(value||'').match(/\b(?:1[5-9]|20)\d{2}\b/g)||[]
const imageTopic=photo=>`${photo.caption} ${photo.alt} ${photo.description} ${photo.fileTitle.replace(/^File:/,'')}`
const chart=/\b(?:chart|graph|plot|statistics|dataset|data|rate|index|trend)\b/i
const genericPhotoNames=new Set(['The','This','Map','Regions','Historical','Expansion','Empire','Comparison','Territorial',
 'Temple','Model','Road','Engine','Statue','Great','Gallery','Car','Steam','Vehicle'])
const captionNames=caption=>(String(caption||'').match(/\b[A-Z][a-z]{3,}\b/g)||[])
 .filter(word=>!genericPhotoNames.has(word))

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
  // Generic words such as "road" and "engine" cannot place a picture of a
  // named invention on a page that never discusses that invention.
  const named=captionNames(photo.caption)
  if(pageIndex>0&&named.length&&!texts.every(text=>named.some(name=>
   new RegExp(`\\b${name}\\b`,'i').test(text))))continue
  if(pageIndex===0){
   if(titleHits<1&&overlaps.some(count=>count<2))continue
  }else if(overlaps.some(count=>count<2)&&titleHits<1&&
   !captionNames(photo.caption).filter(name=>terms(photo.alt+' '+photo.fileTitle).has(name.toLowerCase()))
    .some(name=>texts.every(text=>new RegExp(`\\b${name}\\b`,'i').test(text))))continue
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
 const levels=['A1-A2','B1-B2','C1-C2']
 const forLevel=(candidate,level,preferLater=false)=>decideWikipediaPhoto(candidate,{source,usedUrls,preferLater,
  levelVariants:Object.fromEntries(levels.map(key=>[key,levelVariants?.[level]]))})
 const evaluated=decisions.map(candidate=>({candidate,perLevel:Object.fromEntries(levels.map(level=>[
  level,forLevel(candidate,level)]))}))
 const complete=evaluated.filter(row=>levels.every(level=>row.perLevel[level].status==='VERIFIED'))
 const score=row=>levels.reduce((sum,level)=>sum+row.perLevel[level].matchScore,0)
 const cover=complete.filter(row=>levels.every(level=>row.perLevel[level].pageIndex===0))
  .sort((a,b)=>score(b)-score(a)||a.candidate.photo.position-b.candidate.photo.position)[0]
 // The article's own first illustration may introduce a later detail if it
 // clearly names the main subject. Charts and reconstructions need direct
 // page-one context and cannot use this introduction rule.
 const sourceLead=complete.filter(row=>row.candidate.photo.position===0&&
  hits(imageTopic(row.candidate.photo),source.sourceTitle)>=1&&
  !/\b(?:chart|graph|plot|reconstruction|re-creation|replica)\b/i.test(imageTopic(row.candidate.photo)))
  .sort((a,b)=>score(b)-score(a))[0]
 const lead=cover||sourceLead
 const diagnostics=evaluated.map(row=>({fileTitle:row.candidate.photo?.fileTitle,
  levels:Object.fromEntries(levels.map(level=>[level,{status:row.perLevel[level].status,
   reason:row.perLevel[level].reason,pageIndex:row.perLevel[level].pageIndex}]))}))
 if(!lead)return {status:'REVIEW',reason:complete.length?'no-verified-lead-photo':'no-verified-photo-placement',
  decisions:diagnostics}
 const variants=structuredClone(levelVariants),photos=[],chosen=new Set()
 const place=(row,indexes)=>{
  const photo=row.perLevel['B1-B2'].photo
  for(const level of levels){
   const pageIndex=indexes[level],page=variants[level].pages[pageIndex]
   const provenance={...row.perLevel[level].photo.provenance,
    licenseUrl:String(row.perLevel[level].photo.provenance.licenseUrl||'')
     .replace(/^http:\/\/creativecommons\.org\//i,'https://creativecommons.org/'),
    evidence:{...row.perLevel[level].photo.provenance.evidence,pageIndex}}
   Object.assign(page,{image:photo.url,caption:photo.caption,imageProvenance:provenance})
  }
  photos.push({...photo,pageIndex:indexes['B1-B2']});chosen.add(photo.url)
 }
 place(lead,Object.fromEntries(levels.map(level=>[level,0])))
 const later=complete.filter(row=>row!==lead).map(row=>({row,perLevel:Object.fromEntries(levels.map(level=>{
  const direct=row.perLevel[level]
  return [level,direct.pageIndex>0?direct:forLevel(row.candidate,level,true)]
 }))})).filter(({perLevel})=>levels.every(level=>perLevel[level].status==='VERIFIED'&&perLevel[level].pageIndex>0))
  .sort((a,b)=>score(b.row)-score(a.row))
 for(const {row,perLevel} of later){
  if(photos.length>=4||chosen.has(row.perLevel['B1-B2'].photo.url)||
   levels.some(level=>variants[level].pages[perLevel[level].pageIndex].image))continue
  place({...row,perLevel},Object.fromEntries(levels.map(level=>[level,perLevel[level].pageIndex])))
 }
 return {status:'VERIFIED',levelVariants:variants,photos,decisions:diagnostics}
}
