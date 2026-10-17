/** A short display headline can never replace the publisher's source title. */
const compact=value=>String(value||'').replace(/\s+/gu,' ').trim()
const words=value=>compact(value).toLowerCase().normalize('NFKD').replace(/[^a-z0-9 ]/g,' ').split(/\s+/).filter(x=>x.length>=4&&!['about','after','from','with','this','that','their','these','into','over','under','when','what','would'].includes(x))
const numbers=value=>[...compact(value).matchAll(/\b\d+(?:[.,]\d+)*\b/g)].map(x=>x[0])

export function validatedNewsHeadline(value,sourceTitle,sourceText=null){
 const headline=compact(value),source=compact(sourceTitle)
 if(!source||headline.length<14||headline.length>48||headline.split(/\s+/).length>8||/[!?…]$/.test(headline))return ''
 const sourceWords=new Set(words(source))
 if([...new Set(words(headline))].filter(x=>sourceWords.has(x)).length<Math.min(2,sourceWords.size))return ''
 if(sourceText!==null){
  const evidence=source+' '+sourceText,allowed=new Set(numbers(evidence))
  if(numbers(headline).some(x=>!allowed.has(x)))return ''
  if([...headline.matchAll(/\b[A-Z][A-Za-z]{2,}\b/g)].some(match=>match.index>0 &&
    !new RegExp(`\\b${match[0]}\\b`,'i').test(evidence)))return ''
 }
 return headline
}

// A publisher's own short title is preferable to spending another free AI
// request on a display title. A complete clause before a contrast also works.
export function sourceNewsHeadline(sourceTitle,sourceText){
 const source=compact(sourceTitle)
 const options=[source,source.split(/,\s+but\b/i)[0],source.split(/\s+[—–]\s+|:\s+/u)[0]]
 for(const option of options){
  if(option.split(/\s+/).length>=5){
   const valid=validatedNewsHeadline(option,source,sourceText)
   if(valid)return valid
  }
 }
 return ''
}
