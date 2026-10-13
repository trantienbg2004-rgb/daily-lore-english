/** Reader-only cleanup: remove standalone image-credit lines from visible prose.
 * Rights and original text are retained in sourceMediaCredits, not erased.
 * Never drop meaningful editorial paragraphs just because they mention photos.
 */
const normalize = text => String(text || '').replace(/\s+/gu,' ').trim()
const creditLead = /^(?:image|images|photo|photos|photograph|photographs|screenshots?|picture|pictured|image remix|photo illustration)\s+(?:by|from|via|courtesy of|credit(?:s)?(?: to|:)?|remix(?:ed)? by)\b/i
const licenseNote = /\b(?:used with permission|used under (?:a |the )?(?:creative commons|pixabay|cc by)|licensed under|photo credit|image credit|screenshots? (?:via|by|from))\b/i
const shortCaption = /^(?:[^.!?]{10,200}?\b(?:screenshots?|photos?|images?)\s+(?:via|by|courtesy of)\s+[^.!?]{3,70}\.)\s*$/i
export function isMediaCredit(text) {
 const s=normalize(text)
 if(!s||s.length>450)return false
 // Reject only a standalone credit, never an entire first news paragraph.
 const shortStandalone=/^(?:image(?: remix on Canva)?|photographs?|photos?|screenshots?|pictures?)\s+(?:by|from|via|courtesy of)\s+[^.!?]{1,210}[.!?](?:\s+Used (?:with permission|under [^.!?]{1,80})[.!?])?$/i
 return shortStandalone.test(s) || shortCaption.test(s) || (s.split(/\s+/u).length<=42 && /^(?:courtesy|credit|©|source\s*:|image\s*:|photo\s*:)/i.test(s) && licenseNote.test(s))
}
function removeLeadingCredit(text) {
 let current=normalize(text),credits=[]
 // Some older published pages joined a photo caption and a genuine paragraph.
 // Consume only an unmistakable, short photo-credit sentence from the start.
 for(let i=0;i<2;i++){
  const m=current.match(/^(?:Image remix on Canva by|Image(?:s)? by|Photograph(?:s)? by|Photo(?:s)? by|Screenshots? via|Images? courtesy of)[^.!?]{1,210}[.!?](?:\s+(?:Used (?:with permission|under [^.!?]{4,75})\.)?)?/i)
  if(!m)break
  const segment=m[0].trim(),remainder=current.slice(m[0].length).trim()
  if(!isMediaCredit(segment) && !/^(?:Image remix|Images? by|Photos? by|Screenshots? via)/i.test(segment))break
  credits.push(segment);current=remainder
 }
 return {text:current,credits}
}
export function sanitizeReadingArticle(article) {
 if(!Array.isArray(article?.pages))return article
 const credits=[...(Array.isArray(article.sourceMediaCredits)?article.sourceMediaCredits:[])]
 if(article.sourceMediaCredit)credits.push(article.sourceMediaCredit)
 let changed=false
 const pages=[]
 for(const page of article.pages){
  if(!page||typeof page.text!=='string'){pages.push(page);continue}
  let text=normalize(page.text)
  const result=removeLeadingCredit(text)
  if(result.credits.length){credits.push(...result.credits);text=result.text;changed=true}
  if(isMediaCredit(text)){credits.push(text);text='';changed=true}
  if(text || page.image)pages.push({...page,text})
 }
 if(!changed)return article
 const unique=[...new Set(credits.map(normalize).filter(Boolean))]
 return {...article,pages,sourceMediaCredits:unique,sourceMediaCredit:unique.join(' | ')}
}
