import {selectNarrative,makeStory,editorialGate} from './editorial.mjs'
const UA='DailyLoreEnglish/1.0 (https://github.com/trantienbg2004-rgb/daily-lore-english; educational encyclopedia reader)'
const strip=t=>String(t||'').replace(/<[^>]+>/g,' ').replace(/&amp;/g,'&').replace(/&quot;/g,'"').replace(/&#39;/g,"'").replace(/&nbsp;/g,' ').replace(/\s+/g,' ').trim()
const excluded=/(?:^|[_\s-])(?:logo|icon|coat[_\s-]of[_\s-]arms|flag[_\s-]of|wikidata|wikimedia|commons[_\s-]logo|locator[_\s-]map|disambiguation|question[_\s-]mark|symbol|seal[_\s-]of|emblem|blank[_\s-]map)(?:[_\s.-]|$)/i
function getUrl(endpoint,params){return `${endpoint}?${new URLSearchParams({format:'json',formatversion:'2',...params})}`}
export async function getJson(url,{fetchImpl=fetch,attempts=3}={}){
 for(let n=0;n<attempts;n++){
  try{
   const controller=new AbortController();const timer=setTimeout(()=>controller.abort(),18000)
   try{
    const response=await fetchImpl(url,{headers:{'User-Agent':UA,Accept:'application/json'},signal:controller.signal})
    if(!response.ok)throw Error(`HTTP ${response.status}`)
    const result=await response.json()
    if(result?.error)throw Error(`API ${result.error.code||'unknown'}`)
    return result
   }finally{clearTimeout(timer)}
  }catch(e){if(n===attempts-1)throw e;await new Promise(r=>setTimeout(r,(n+1)*650))}
 }
}
export function approvedCommonsImage(page){
 const info=page?.imageinfo?.[0]
 if(!info||!/^https:\/\/(?:upload|thumb)\.wikimedia\.org\//.test(info.thumburl||info.url||''))return null
 const width=Number(info.width),height=Number(info.height)
 if(width<640||height<350||width/height<.5||width/height>3.8)return null
 if(excluded.test(String(page.title||'').replace(/^File:/i,'')))return null
 const meta=info.extmetadata||{}
 const license=strip(meta.LicenseShortName?.value||meta.License?.value||'')
 const licenseUrl=String(meta.LicenseUrl?.value||'')
 const pd=/(?:public domain|^pd-|^cc0\b)/i.test(license)
 const cc=/^CC BY(?:-SA)?(?:\s|$)/i.test(license)
 if(!(pd||cc) || /\b(?:NC|ND)\b/i.test(license))return null
 const descriptionUrl=String(info.descriptionurl||'')
 if(!/^https:\/\/(?:commons\.wikimedia\.org|en\.wikipedia\.org)\/wiki\//.test(descriptionUrl))return null
 const credit=strip(meta.Artist?.value||meta.Credit?.value||'Wikimedia Commons contributors').slice(0,280)
 return {url:info.thumburl||info.url,descriptionUrl,license,licenseUrl,credit,caption:String(page.title||'').replace(/^File:/,'').replace(/_/g,' ').replace(/\.[^.]+$/,'').slice(0,120)}
}
export async function collectWikipediaTopic(topic,{fetchImpl=fetch,now=new Date()}={}){
 const api='https://en.wikipedia.org/w/api.php'
 const pageData=await getJson(getUrl(api,{
  action:'query',titles:topic.title,redirects:'1',prop:'extracts|images|info|pageimages|revisions',
  explaintext:'1',exsectionformat:'plain',exintro:'0',imlimit:'40',inprop:'url',piprop:'name',rvprop:'ids'
 }),{fetchImpl})
 const page=pageData?.query?.pages?.[0]
 if(!page || page.missing || !page.extract || !page.fullurl || page.ns!==0)return {reason:'page-missing'}
 const paragraphs=selectNarrative(page.extract)
 if(!paragraphs.length)return {reason:'short-or-non-narrative'}
 const embedded=(page.images||[]).map(x=>x.title).filter(x=>!excluded.test(x))
 const chosen=[...(page.pageimage?[`File:${page.pageimage.replace(/^File:/,'')}`]:[]),...embedded]
 const filenames=[...new Set(chosen)].slice(0,18)
 if(!filenames.length)return {reason:'no-embedded-images'}
 const imageData=await getJson(getUrl('https://commons.wikimedia.org/w/api.php',{
  action:'query',titles:filenames.join('|'),prop:'imageinfo',iiprop:'url|size|extmetadata',iiurlwidth:'900'
 }),{fetchImpl})
 const found=(imageData?.query?.pages||[]).map(approvedCommonsImage).filter(Boolean)
 // Favor the actual lead image, then other directly embedded and licensed images.
 const primary=page.pageimage?.toLowerCase()||''
 found.sort((a,b)=>Number(b.descriptionUrl.toLowerCase().includes(encodeURIComponent(primary).toLowerCase()))-Number(a.descriptionUrl.toLowerCase().includes(encodeURIComponent(primary).toLowerCase())))
 const images=[...new Map(found.map(p=>[p.descriptionUrl,p])).values()].slice(0,3)
 if(!images.length)return {reason:'no-reusable-embedded-images'}
 const story=makeStory({page,topic,paragraphs,images,now})
 const audit=editorialGate(story)
 return audit.accepted?{story,audit}:{reason:audit.reasons.join(','),audit}
}
