/** Select rights-verified files embedded in the pinned source article. */
const levels=['A1-A2','B1-B2','C1-C2']
const licenseUrl=value=>String(value||'').replace(/^http:\/\/creativecommons\.org\//i,'https://creativecommons.org/')

export function decideWikipediaPhoto(candidate,{source,levelVariants,usedUrls=new Set(),preferLater=false}={}){
 if(candidate?.status!=='REVIEW'||!candidate.photo)return candidate
 const photo=candidate.photo
 if(!source?.figures?.some(figure=>figure.fileTitle===photo.fileTitle))
  return {...candidate,status:'REJECTED',reason:'not-embedded-in-source-revision'}
 if(usedUrls.has(photo.url)||usedUrls.has(photo.provenance?.imagePageUrl))
  return {...candidate,status:'REJECTED',reason:'image-already-used'}
 if(levels.some(level=>!Array.isArray(levelVariants?.[level]?.pages)||
  levelVariants[level].pages.length<(preferLater?2:1)))
  return {...candidate,status:'REVIEW',reason:'reading-pages-unavailable'}
 const pageIndex=preferLater?1:0
 return {...candidate,status:'VERIFIED',reason:'source-embedded-item-rights-verified',pageIndex,
  photo:{...photo,caption:String(photo.caption||photo.alt||'').replace(/\s+/g,' ').trim(),
   provenance:{...photo.provenance,licenseUrl:licenseUrl(photo.provenance?.licenseUrl),
    sourceImageUrl:source.sourceUrl,sourceRevisionUrl:source.sourceRevisionUrl,
    evidence:{sourcePageId:source.pageId,sourceRevisionId:source.sourceRevisionId,
     fileTitle:photo.fileTitle,articleCaption:photo.caption,pageIndex}}}}
}

export function assignWikipediaPhotos(decisions,source,levelVariants,{usedUrls=new Set()}={}){
 const evaluated=decisions.map(candidate=>decideWikipediaPhoto(candidate,{source,levelVariants,usedUrls}))
 const ordered=evaluated.filter(row=>row.status==='VERIFIED')
  .sort((a,b)=>(a.photo.position??Infinity)-(b.photo.position??Infinity))
 const diagnostics=evaluated.map(row=>({fileTitle:row.photo?.fileTitle||row.fileTitle,
  levels:Object.fromEntries(levels.map(level=>[level,{status:row.status,reason:row.reason,
   pageIndex:row.pageIndex}]))}))
 if(!ordered.length)return {status:'REVIEW',reason:'no-verified-photo-placement',decisions:diagnostics}
 const variants=structuredClone(levelVariants),photos=[],chosen=new Set()
 for(const row of ordered){
  if(photos.length>=4)break
  const photo=row.photo
  if(chosen.has(photo.url)||levels.some(level=>photos.length>=variants[level].pages.length))continue
  const indexes=Object.fromEntries(levels.map(level=>[level,photos.length]))
  for(const level of levels){
   const pageIndex=indexes[level],page=variants[level].pages[pageIndex]
   const provenance={...photo.provenance,evidence:{...photo.provenance.evidence,pageIndex}}
   Object.assign(page,{image:photo.url,caption:photo.caption,imageProvenance:provenance})
  }
  photos.push({...photo,pageIndex:indexes['B1-B2']});chosen.add(photo.url)
 }
 return {status:'VERIFIED',levelVariants:variants,photos,decisions:diagnostics}
}
