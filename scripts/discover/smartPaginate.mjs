/** Deterministic, content-driven sentence pagination. A page count is never a QA gate. */
const wordCount=s=>String(s||'').trim().split(/\s+/u).filter(Boolean).length
export function smartPaginate(textOrPages,{targetWords=60}={}){
 const input=Array.isArray(textOrPages)?textOrPages.map(p=>typeof p==='string'?p:p?.text||'').join(' '):String(textOrPages||'')
 const text=input.replace(/\s+/gu,' ').trim()
 if(!text)return []
 const sentences=text.split(/(?<=[.!?])\s+(?=["'“‘(]*[A-ZÀ-Ỹ0-9])/u).map(x=>x.trim()).filter(Boolean)
 if(!sentences.length)return [text]
 const pages=[];let page='',count=0
 const flush=()=>{if(page){pages.push(page.trim());page='';count=0}}
 for(const sentence of sentences){
  const length=wordCount(sentence)
  if(page && count+length>targetWords && count>=Math.floor(targetWords*.6))flush()
  page+=(page?' ':'')+sentence;count+=length
 }
 flush()
 return pages
}
