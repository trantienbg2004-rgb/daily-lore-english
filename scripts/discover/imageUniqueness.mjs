export const imageCaptionKey=value=>String(value||'').replace(/^Illustrative image:\s*/i,'').trim().replace(/\s+/g,' ').toLowerCase()
export const imageKeys=photo=>[photo?.url||photo?.image,photo?.provenance?.imagePageUrl||photo?.imageProvenance?.imagePageUrl].filter(Boolean)
export function usedCatalogImages(stories){
 const urls=new Set(),captions=new Set()
 for(const story of stories)for(const page of story?.levelVariants?.['B1-B2']?.pages||story?.pages||[]){
  if(!page.image)continue
  for(const key of imageKeys(page))urls.add(key)
  if(page.caption)captions.add(imageCaptionKey(page.caption))
 }
 return {urls,captions}
}
export function coverDuplicates(stories){
 const urls=new Map(),captions=new Map(),duplicates=[]
 for(const story of stories){
  const cover=story?.levelVariants?.['B1-B2']?.pages?.[0]||story?.pages?.[0]
  if(!cover?.image)continue
  for(const key of imageKeys(cover)){
   if(urls.has(key))duplicates.push({type:'url',key,first:urls.get(key),second:story.sourceUrl})
   else urls.set(key,story.sourceUrl)
  }
  const caption=imageCaptionKey(cover.caption)
  if(caption){if(captions.has(caption))duplicates.push({type:'caption',key:caption,first:captions.get(caption),second:story.sourceUrl})
   else captions.set(caption,story.sourceUrl)}
 }
 return duplicates
}
