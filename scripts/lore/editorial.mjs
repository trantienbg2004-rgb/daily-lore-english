/** Deterministic quality gates. These are explicitly NOT semantic fact checks. */
export const words = text => String(text||'').trim().split(/\s+/u).filter(Boolean)
export const wordCount = text => words(text).length
const unhelpful = /^(?:see also|references|external links|further reading|bibliography|notes|footnotes|citations|gallery|sources|index|awards|discography|list of|tourism|transport|hotels|restaurants)$/i
export function paragraphsFromExtract(extract) {
 const text=String(extract||'').replace(/\r/g,'').replace(/\[\s*edit\s*\]/gi,'').trim()
 const blocks=text.split(/\n\s*\n+/).flatMap(s=>s.split(/\n(?=\S)/))
 const out=[],seen=new Set()
 for(const line of blocks){
  const p=line.replace(/\s+/gu,' ').trim()
  const n=wordCount(p)
  if(unhelpful.test(p) || p.length>3000 || n<35 || n>250)continue
  if(/^(?:coordinates:|isbn\b|doi\b|retrieved |source: |last updated: )/i.test(p))continue
  if((p.match(/\b(?:http|www\.)/gi)||[]).length>1 || (p.match(/\|/g)||[]).length>3)continue
  if((p.match(/[.!?](?:\s|$)/gu)||[]).length<2)continue
  const fingerprint=p.toLocaleLowerCase('en').replace(/[^a-z0-9]+/g,' ').trim()
  if(seen.has(fingerprint))continue
  seen.add(fingerprint)
  out.push(p)
 }
 return out
}
export function selectNarrative(extract,{minimum=400,maximum=800}={}){
 const chunks=paragraphsFromExtract(extract)
 const selected=[]; let size=0
 for(const p of chunks){
  const length=wordCount(p)
  if(size+length>maximum){ if(size>=minimum)break;continue }
  selected.push(p);size+=length
  if(size>=560)break
 }
 return size>=minimum ? selected : []
}
export function editorialGate(story){
 const reasons=[]
 if(!/^(History|Culture|Society|Geography|Economics|Science|Civilizations|People & Ideas)$/.test(story.category||''))reasons.push('category')
 if(!story.title||story.title.length<4||story.title.length>110)reasons.push('title')
 if(!/^https:\/\/en\.(?:wikipedia|wikivoyage)\.org\/wiki\//.test(story.sourceUrl||''))reasons.push('source-url')
 if(!/^CC BY-SA 4\.0/.test(story.license||''))reasons.push('text-license')
 const text=(story.pages||[]).map(p=>p.text).join(' '),n=wordCount(text)
 if(n<400||n>800)reasons.push('length')
 if(!Array.isArray(story.pages)||story.pages.length<3)reasons.push('pages')
 if(/\b(?:references|external links|see also)\s*(?:\n|$)/i.test(text))reasons.push('navigation')
 if(!Array.isArray(story.pages)||story.pages.some(p=>!p?.text||!p.text.trim()||wordCount(p.text)<35))reasons.push('thin-page')
 const photoPages=(story.pages||[]).filter(p=>p.image)
 if(!photoPages.length)reasons.push('image-required')
 if(photoPages.some(p=>!/^https:\/\/(?:upload|thumb)\.wikimedia\.org\//.test(p.image)||!p.imageProvenance?.license||!p.imageProvenance?.sourceImageUrl))reasons.push('image-rights')
 // Structural points are machine-observable, not invented semantic scores.
 return {accepted:reasons.length===0,reasons,words:n,photos:photoPages.length,needsHumanEditorialReview:true}
}
export function makeStory({page,topic,paragraphs,images,now}){
 const pageSize=115, pages=[]
 let i=0
 while(i<paragraphs.length){let buffer='',part=[]
  while(i<paragraphs.length && wordCount(buffer)+wordCount(paragraphs[i])<=pageSize+65){part.push(paragraphs[i++]);buffer=part.join(' '); if(wordCount(buffer)>=75)break}
  if(!part.length){part=[paragraphs[i++]];buffer=part.join(' ')}
  pages.push({text:buffer,image:'',caption:''})
 }
 // Move a tiny tail paragraph into previous page without discarding words.
 if(pages.length>1 && wordCount(pages.at(-1).text)<35){pages[pages.length-2].text+=' '+pages.at(-1).text;pages.pop()}
 images.slice(0,Math.min(3,pages.length)).forEach((img,j)=>{
  const at=j===0?0:Math.min(pages.length-1,j*2)
  const p=pages[at]
  p.image=img.url;p.caption=img.caption
  p.imageProvenance={credit:img.credit,license:img.license,sourceImageUrl:img.descriptionUrl,originArticleUrl:page.fullurl,licenseUrl:img.licenseUrl||''}
 })
 return {id:`wikipedia:${page.pageid}`,title:page.title,sourceTitle:page.title,sourceUrl:page.fullurl,sourceRevisionId:page.revisions?.[0]?.revid||null,sourceName:'Wikipedia',publisher:'English Wikipedia',
  contentType:'lore',readingKind:'full',category:topic.category,subtitle:paragraphs[0].split(/(?<=[.!?])\s/u)[0].slice(0,165),
  license:'CC BY-SA 4.0 (Wikipedia text; see original page and revision history)',licenseUrl:'https://creativecommons.org/licenses/by-sa/4.0/',attribution:'Wikipedia contributors',
  editorialVersion:1,publishedAt:now.toISOString(),pages,sourceMediaCredits:images.map(i=>`${i.credit} · ${i.license} · ${i.descriptionUrl}`),
  editorialState:'machine-screened; human factual and narrative review pending'}
}
