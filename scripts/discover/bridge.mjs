/** Converts licensed, QA-checked Discover drafts to Reader entries. */
import fs from 'node:fs/promises'
import path from 'node:path'
import {createHash} from 'node:crypto'
import {readableStory,validStories,storyId} from '../../src/lib/feedQueue.js'
export const LEVELS=['A1-A2','B1-B2','C1-C2']
export const wordCount=s=>String(s||'').trim().split(/\s+/u).filter(Boolean).length
const sha=x=>createHash('sha256').update(JSON.stringify(x)).digest('hex')
const titleWords=s=>new Set(String(s||'').toLowerCase().normalize('NFKD').replace(/[^a-z0-9 ]/g,' ').split(/\s+/).filter(x=>x.length>3&&!['about','from','after','their','with','this','that','have','into','against','says','news','when','world'].includes(x)))
export function sameEvent(a,b){const x=titleWords(a.title),y=titleWords(b.title);const intersection=[...x].filter(v=>y.has(v)).length;return intersection>=4&&intersection/Math.max(1,Math.min(x.size,y.size))>=.78 &&Math.abs(Date.parse(a.publishedAt)-Date.parse(b.publishedAt))<7*864e5}
function safeSource(sourceId,url){try{const u=new URL(url);if(u.protocol!=='https:')return false;return sourceId==='global-voices'?['globalvoices.org','www.globalvoices.org'].includes(u.hostname):sourceId==='voa'&&u.hostname==='learningenglish.voanews.com'}catch{return false}}
export function licensedDraft(d){const r=d?.rights;return safeSource(d?.sourceId,d?.sourceUrl)&&r?.textAllowed===true&&r?.mode==='gemini-eligible'&&(d.sourceId==='voa'?/Public domain/i.test(r.license||''):/^https:\/\/creativecommons\.org\/licenses\/by\/\d/i.test(r.licenseUrl||''))}
const verifiedPhoto=d=>!d?.imageUrl || (d.imageRightsVerified===true && /^https:\/\/creativecommons\.org\/licenses\/(?:by|by-sa)\/(?:2\.0|2\.5|3\.0|4\.0)\/?/i.test(d.imageProvenance?.licenseUrl||'') && typeof d.imageProvenance?.credit==='string' && d.imageProvenance.credit.length>=3 && d.imageProvenance?.sourceImageUrl===d.sourceUrl)
const photoCreditFields=['credit','license','licenseUrl','sourceImageUrl','imagePageUrl']
export function photoCreditMatches(d,page){
 if(!d?.imageUrl)return !page?.imageProvenance
 return !!page?.imageProvenance && photoCreditFields.every(key=>(page.imageProvenance[key]||'')===(d.imageProvenance?.[key]||''))
}
export function validateDraft(d){const problems=[];if(!d?.id||!d?.title||!licensedDraft(d))problems.push('unlicensed-or-invalid-source');if(!verifiedPhoto(d))problems.push('unverified-image')
 const variants=d?.levelVariants||{},texts=[];for(const level of LEVELS){const v=variants[level];if(!Array.isArray(v?.pages)||v.pages.length<1){problems.push(`pages:${level}`);continue}
  if(v.pages.some((p,i)=>typeof p?.text!=='string'||!p.text.trim()||(i===0?(p.image||'')!==(d.imageUrl||''):(p.image||p.caption))))problems.push(`length:${level}`)
  if(!photoCreditMatches(d,v.pages[0])||v.pages.slice(1).some(p=>p.imageProvenance))problems.push(`photo-credit:${level}`)
  const total=v.pages.reduce((t,p)=>t+wordCount(p.text),0);if(total<10)problems.push(`total:${level}`)
  if(!Array.isArray(v.evidence)||v.evidence.length<3||v.evidence.some(s=>typeof s!=='string'||s.length<16))problems.push(`evidence:${level}`)
  if(!Array.isArray(v.keyVocabulary)||v.keyVocabulary.length!==3)problems.push(`vocabulary:${level}`)
  texts.push(v.pages.map(p=>p.text).join(' '))
 }if(new Set(texts).size!==3)problems.push('levels-not-distinct');return problems}
export function toReaderStory(d){const errors=validateDraft(d);if(errors.length)throw Error('Discover QA blocked: '+errors.join(', '))
 const levels=Object.fromEntries(LEVELS.map(level=>[level,{pages:d.levelVariants[level].pages.map((p,i)=>({text:p.text.trim(),image:i===0?(p.image||''):'',caption:i===0?(p.caption||''):'',...(i===0 && p.imageProvenance?{imageProvenance:p.imageProvenance}:{})})),keyVocabulary:d.levelVariants[level].keyVocabulary,evidence:d.levelVariants[level].evidence}]))
 const category=/\b(market|business|trade|econom\w*|tariff|bank|inflation|finance)\b/i.test(d.title)?'Economics'
  :/\b(politic\w*|government|election|parliament|diplomat\w*|summit|war|conflict|sanction\w*|junta)\b/i.test(d.title)?'Politics'
  :/\b(science|research|health|space|climate|technology)\b/i.test(d.title)?'Science':'Society'
 const item={id:d.id,title:d.title,sourceTitle:d.title,sourceUrl:d.sourceUrl,sourceName:d.sourceName,publisher:d.sourceName,contentType:'news',readingKind:'full',editorialVersion:1,
  category,publishedAt:d.originalPublishedAt||new Date().toISOString(),license:d.rights.license,licenseUrl:d.rights.licenseUrl,
  attribution:`${d.sourceName} — original reporting; SAGA AI-assisted educational adaptation`,
  editorialState:'Machine screened and source-attributed; not a guarantee of semantic accuracy',levelVariants:levels,pages:levels['B1-B2'].pages}
 if(!validStories([item])||!readableStory(item))throw Error('Reader contract blocked news')
 return item}
export function isPublishedNewsStory(s){return s?.contentType==='news'&&s?.readingKind==='full'&&!!s.sourceUrl&&!!s.license&&Array.isArray(s.levelVariants?.['A1-A2']?.pages)&&Array.isArray(s.levelVariants?.['B1-B2']?.pages)&&Array.isArray(s.levelVariants?.['C1-C2']?.pages)&&validStories([s])&&readableStory(s)}
export function selectFreshStories(existing,drafts,limit=2){const accepted=[],rejected=[],ids=new Set(existing.map(storyId))
 for(const d of drafts){try{const story=toReaderStory(d),id=storyId(story);if(ids.has(id))throw Error('duplicate-source-url');if([...existing,...accepted].some(s=>s.contentType==='news'&&sameEvent(s,story)))throw Error('duplicate-event');accepted.push(story);ids.add(id);if(accepted.length>=limit)break}catch(e){rejected.push({title:d?.title||'',reason:String(e.message||e)})}}
 return {accepted,rejected}}
export async function readCatalog(root=process.cwd()){const dir=path.join(root,'public','lore-reader'),manifest=JSON.parse(await fs.readFile(path.join(dir,'manifest.json'),'utf8'))
 if(!(['lore','news'].includes(manifest.feedType))||manifest.ready!==true||!Number.isSafeInteger(manifest.chunks)||manifest.chunks<1)throw Error('Invalid existing Reader manifest')
 const stories=[];for(let i=0;i<manifest.chunks;i++){const name=`${String(i).padStart(4,'0')}.json`,batch=JSON.parse(await fs.readFile(path.join(dir,name),'utf8'));if(!validStories(batch))throw Error('Invalid shard '+name);stories.push(...batch)}
 const published=manifest.newsOnly===true?stories.filter(s=>s.contentType==='news'):stories
 if(published.length!==manifest.total)throw Error('Existing catalog count mismatch');return {dir,manifest,stories:published}}
export async function publishDiscover({root=process.cwd(),drafts=[],limit=2,now=new Date()}={}){
 const {dir,manifest,stories}=await readCatalog(root),{accepted,rejected}=selectFreshStories(stories,drafts,limit)
 if(!accepted.length)return {published:false,added:0,total:stories.length,rejected}
 // Do not touch old shards. Commit manifest last to expose a complete publication.
 const addedFiles=[]
 try{for(let i=0;i<accepted.length;i+=20){const num=manifest.chunks+Math.floor(i/20),filename=String(num).padStart(4,'0')+'.json',target=path.join(dir,filename)
   const tmp=target+'.stage-'+process.pid;await fs.writeFile(tmp,JSON.stringify(accepted.slice(i,i+20))+'\n');await fs.rename(tmp,target);addedFiles.push(target)}
  const updated={...manifest,total:manifest.total+accepted.length,chunks:manifest.chunks+addedFiles.length,
   sourceCount:new Set([...stories,...accepted].map(s=>s.sourceName||s.publisher)).size,
   withVerifiedPhoto:[...stories,...accepted].filter(s=>s.pages.some(p=>p.image)).length,
   contentHash:sha({previous:manifest.contentHash,added:accepted.map(s=>[s.id,s.pages,s.levelVariants])}),updatedAt:now.toISOString(),
   byTopic:{...manifest.byTopic}}
  for(const story of accepted)updated.byTopic[story.category]=(updated.byTopic[story.category]||0)+1
  delete updated.catalogIndexHash
  const tmp=path.join(dir,'manifest.json.stage-'+process.pid);await fs.writeFile(tmp,JSON.stringify(updated,null,2)+'\n');await fs.rename(tmp,path.join(dir,'manifest.json'))
  return {published:true,added:accepted.length,total:updated.total,rejected,newShards:addedFiles.map(f=>path.basename(f))}
 }catch(error){for(const file of addedFiles)await fs.rm(file,{force:true}).catch(()=>{});throw error}
}
