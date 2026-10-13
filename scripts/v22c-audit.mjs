/**
 * DAILY NEWS V22-C.6 — offline, read-only quality audit.
 * Reads the full-feed actually installed on the user's machine; does not
 * fetch websites, edit the feed, update history, or deploy anything.
 * Copyright status and completeness relative to originals need human review.
 */
import fs from 'node:fs/promises'
import path from 'node:path'
import {fileURLToPath} from 'node:url'

const wordCount=value=>String(value||'').trim().split(/\s+/u).filter(Boolean).length
const norm=value=>String(value||'').normalize('NFKC').toLowerCase().replace(/[^a-z0-9]+/g,' ').trim()
const urlKey=value=>{try {const u=new URL(value);u.hash='';u.pathname=u.pathname.replace(/\/+$/,'')||'/';for(const p of [...u.searchParams.keys()])if(/^(utm_|fbclid$|gclid$)/.test(p))u.searchParams.delete(p);return u.href}catch{return ''}}
const isSafeURL=value=>{try {const u=new URL(value);return u.protocol==='https:'&&!u.username&&!u.password&&!u.port}catch{return false}}
const groupPublisher=item=>String(item.publisher||item.newsSource||item.source||'Unknown').trim()
const preview=(s,n=190)=>String(s||'').replace(/\s+/g,' ').trim().slice(0,n)
const FLAGS={
 'NO_IMAGE':'No article photograph: needs image solution or explicit text-only decision',
 'NO_IMAGE_CREDIT':'Image is present, but its page has no visible credit/caption',
 'UNSAFE_IMAGE':'Photo URL is not a safe HTTPS link',
 'NO_SOURCE':'Original article URL is invalid/non-HTTPS',
 'NO_DATE':'Publication date is invalid',
 'FUTURE_DATE':'Publication date appears to be in the future',
 'OLD_DATE':'Publication date is more than 180 days old',
 'NO_CREDIT':'Source attribution or reuse information is missing',
 'LICENSE_REVIEW':'License text states a general policy; actual article reuse still needs checking',
 'CC_NO_AUTHOR':'CC article attribution lacks a named author',
 'SHORT_ARTICLE':'Article has fewer than 300 words (user preference)',
 'LONG_ARTICLE':'Article exceeds 1,500 words (user preference)',
 'FEW_PAGES':'Fewer than 3 reading pages',
 'MANY_PAGES':'More than 10 reading pages',
 'EMPTY_PAGE':'At least one reading page has no text',
 'TINY_PAGE':'At least one reading page has fewer than 24 words',
 'LONG_PAGE':'At least one reading page exceeds 180 words',
 'INCOMPLETE_SENTENCE':'Last content page may end mid-sentence',
 'SOURCE_WORDS_MISMATCH':'Stored word count differs materially from pages',
 'REPEATED_PARAGRAPH':'Page/paragraph content seems copied repeatedly',
 'HTML_LEFTOVER':'HTML fragments remain in reading content',
 'BOILERPLATE':'Potential navigation, social, or subscription text in story',
 'CONTACT_FOOTER':'Contact emails, media phone numbers, or site boilerplate may be included in article text',
 'TRAILING_ELLIPSIS':'Last text ends in ellipsis; check whether the original was cut short',
 'DUPLICATE_URL':'Another item uses the same original URL',
 'DUPLICATE_TEXT':'Another item has the same complete text',
 'INVALID_PAGES':'Reading pages are missing or malformed',
 'NOT_FULL_NEWS':'Not marked as a real full-length news item'
}

function auditItem(item,i,now){
 const flags=[];const flag=x=>{if(!flags.includes(x))flags.push(x)}
 const pages=Array.isArray(item?.pages)?item.pages:[]
 const pageText=pages.map(p=>typeof p?.text==='string'?p.text:'')
 const all=pageText.join(' ')
 const words=wordCount(all)
 const sourceUrl=String(item?.sourceUrl||'')
 const imagePages=pages.filter(p=>Boolean(p?.image))
 const image=String(item?.image||imagePages[0]?.image||'')
 const publishedAt=item?.publishedAt||''
 const date=Date.parse(publishedAt)
 if(item?.contentType!=='news'||item?.readingKind!=='full')flag('NOT_FULL_NEWS')
 if(!isSafeURL(sourceUrl))flag('NO_SOURCE')
 if(!Number.isFinite(date))flag('NO_DATE')
 else if(date>+now+86400000)flag('FUTURE_DATE')
 else if(+now-date>180*86400000)flag('OLD_DATE')
 if(!item?.attribution||!item?.license)flag('NO_CREDIT')
 if(/first-party reporting only|publisher use policy/i.test(item?.license||''))flag('LICENSE_REVIEW')
 if(/creative commons/i.test(item?.license||'')&&!/original author:\s*\S/i.test(item.license))flag('CC_NO_AUTHOR')
 if(!image)flag('NO_IMAGE')
 else{
  if(!isSafeURL(image))flag('UNSAFE_IMAGE')
  if(imagePages.some(p=>!String(p.caption||'').trim()))flag('NO_IMAGE_CREDIT')
 }
 if(!Array.isArray(item?.pages)||!pages.length||pages.some(p=>typeof p?.text!=='string'||typeof p?.image!=='string'))flag('INVALID_PAGES')
 if(words<300)flag('SHORT_ARTICLE')
 if(words>1500)flag('LONG_ARTICLE')
 if(pages.length<3)flag('FEW_PAGES')
 if(pages.length>10)flag('MANY_PAGES')
 if(pageText.some(s=>!String(s).trim()))flag('EMPTY_PAGE')
 if(pageText.some(s=>wordCount(s)>0&&wordCount(s)<24))flag('TINY_PAGE')
 if(pageText.some(s=>wordCount(s)>180))flag('LONG_PAGE')
 if(all&&/[a-z0-9,)\]"']$/i.test(all.trim())&&!/\b(?:et al|vs)\.?$/i.test(all.trim()))flag('INCOMPLETE_SENTENCE')
 if(Number.isFinite(Number(item?.sourceWords))&&Number(item.sourceWords)>0&&Math.abs(words-Number(item.sourceWords))>Math.max(15,Number(item.sourceWords)*.08))flag('SOURCE_WORDS_MISMATCH')
 if(/<\/?(?:div|p|article|script|style|a|section)\b|&(?:nbsp|amp|lt|gt);/i.test(all))flag('HTML_LEFTOVER')
 if(/\b(?:share this article|click here to subscribe|newsletter signup|follow us on social|cookie policy|privacy policy|sign up for updates)\b/i.test(all))flag('BOILERPLATE')
 const tail=String(pageText.at(-1)||'').slice(-520)
 if(/[\w.+-]+@[\w.-]+\.[a-z]{2,}/i.test(tail)||/\b(?:for media inquiries|contact us|open access to nasa|visit the nasa website)\b/i.test(tail))flag('CONTACT_FOOTER')
 if(/(?:\.\.\.|…)[\s\u201d"']*$/u.test(tail))flag('TRAILING_ELLIPSIS')
 const paragraphLike=pageText.flatMap(t=>String(t).split(/\n\n|(?<=[.!?])\s+(?=[A-Z])/u)).map(norm).filter(t=>t.split(' ').length>=12)
 const repeated=paragraphLike.length-new Set(paragraphLike).size
 if(repeated>=2)flag('REPEATED_PARAGRAPH')
 return {index:i+1,title:String(item?.title||''),publisher:groupPublisher(item),sourceUrl,publishedAt,
  words,sourceWords:item?.sourceWords??null,pages:pages.length,imagePresent:Boolean(image),imageKind:item?.imageKind||'unknown',image,
  license:String(item?.license||'').slice(0,400),flags,firstText:preview(pageText[0]),lastText:preview(pageText.at(-1))}
}
export function auditFeed(items,{now=new Date(),manifest={}}={}){
 if(!Array.isArray(items))throw Error('Input is not an article array')
 const rows=items.map((item,i)=>auditItem(item,i,now));const urls=new Map(),texts=new Map()
 for(const [i,item] of items.entries()){
  const row=rows[i],url=urlKey(row.sourceUrl),full=norm((item.pages||[]).map(p=>p?.text||'').join(' '))
  if(url){if(urls.has(url)){row.flags.push('DUPLICATE_URL');rows[urls.get(url)].flags.push('DUPLICATE_URL')}else urls.set(url,i)}
  if(full.length>100){if(texts.has(full)){row.flags.push('DUPLICATE_TEXT');rows[texts.get(full)].flags.push('DUPLICATE_TEXT')}else texts.set(full,i)}
 }
 for(const r of rows)r.flags=[...new Set(r.flags)]
 const byPublisher={},issues={}
 for(const r of rows){byPublisher[r.publisher]=(byPublisher[r.publisher]||0)+1;for(const f of r.flags)issues[f]=(issues[f]||0)+1}
 const featured=[];for(const publisher of Object.keys(byPublisher)){
  const choices=rows.filter(r=>r.publisher===publisher)
  for(const item of [choices[0],choices[Math.floor(choices.length/2)],choices.at(-1)])if(item&&!featured.includes(item))featured.push(item)
 }
 const clean=rows.filter(r=>!r.flags.length).length
 return {auditVersion:'V22-C.6',generatedAt:now.toISOString(),method:'OFFLINE_METADATA_AND_TEXT_CHECK_ONLY',
  limitations:['Does not compare every article against its live original','Does not verify whether actual source images may be redistributed','Does not confirm image bytes load in a browser','Does not certify reading layout on a phone','A source policy URL is not proof every item is licensed'],
  summary:{total:rows.length,manifestTotal:manifest.total??null,manifestReady:manifest.ready??null,publishers:Object.keys(byPublisher).length,byPublisher,
   images:rows.filter(r=>r.imagePresent).length,noImages:issues.NO_IMAGE||0,clean,withFlags:rows.length-clean,issues,
   manifestMatch:manifest.total===items.length,manualReviewRequired:true},sample:featured.map(r=>({index:r.index,title:r.title,publisher:r.publisher,sourceUrl:r.sourceUrl,words:r.words,pages:r.pages,imagePresent:r.imagePresent,flags:r.flags,firstText:r.firstText,lastText:r.lastText})),rows}
}

export async function readRawFeed(base){
 const folder=path.join(base,'public','full-feed')
 const manifest=JSON.parse(await fs.readFile(path.join(folder,'manifest.json'),'utf8'))
 if(!Number.isInteger(manifest.chunks)||manifest.chunks<0||manifest.chunks>500)throw Error('Bad manifest chunks')
 const rows=[]
 for(let i=0;i<manifest.chunks;i++){
  const file=path.join(folder,`${String(i).padStart(4,'0')}.json`)
  const parsed=JSON.parse(await fs.readFile(file,'utf8'))
  if(!Array.isArray(parsed))throw Error(`Chunk ${i} is not a list`)
  rows.push(...parsed)
 }
 return {manifest,items:rows}
}
export function reportText(audit){
 const s=audit.summary;const out=[
 'DAILY NEWS - KIEM TRA CHAT LUONG V22-C.6',
 `Ngay kiem tra (UTC): ${audit.generatedAt}`,
 'Kiem tra du lieu tren may, KHONG thay doi hoac dang bai.',
 '',
 `BAI TRONG KHO: ${s.total} | manifest: ${s.manifestTotal} | khop: ${s.manifestMatch?'CO':'KHONG'}`,
 `SO NHA XUAT BAN: ${s.publishers}`,
 `CO ANH: ${s.images}/${s.total} | KHONG CO ANH: ${s.noImages}`,
 `BAI CO CANH BAO: ${s.withFlags}/${s.total}`,
 'NGUON: '+Object.entries(s.byPublisher).map(([k,v])=>`${k}: ${v}`).join('; '),
 '', 'CAC VAN DE CAN KIEM TRA (so bai bi anh huong):',
 ...Object.entries(s.issues).sort((a,b)=>b[1]-a[1]).map(([k,v])=>`- ${k}: ${v} - ${FLAGS[k]||k}`),
 '', 'LUU Y: Bao cao tu dong KHONG xac minh ban quyen tung bai, tung anh, hay su trung khop voi bai goc.',
 'Khong dua len website cho den khi co buoc xem mau tren dien thoai va doi chieu nguon.',
 '', 'MAU CAN XEM THU CONG (moi nguon dau-giua-cuoi):',
 ...audit.sample.flatMap((x,i)=>[
 `${i+1}. [#${x.index}] ${x.publisher} | ${x.words} tu | ${x.pages} trang | anh: ${x.imagePresent?'co':'khong'}`,
 `   ${x.title}`,
 `   ${x.sourceUrl}`,
 `   Canh bao: ${x.flags.join(', ')||'khong'}`,
 `   Mo dau: ${x.firstText}`,
 `   Ket thuc: ${x.lastText}`
 ]),
 '', 'Buoc tiep: gui file DAILY_NEWS_AUDIT_REPORT.txt vao ChatGPT de phan tich va sua loi.'
 ]
 return out.join('\n')+'\n'
}
export async function runAudit(base=process.cwd(),{now=new Date()}={}){
 const {manifest,items}=await readRawFeed(base)
 const audit=auditFeed(items,{now,manifest})
 const summaryPath=path.join(base,'DAILY_NEWS_AUDIT_REPORT.txt')
 const detailPath=path.join(base,'DAILY_NEWS_AUDIT_DETAILS.json')
 await fs.writeFile(summaryPath,reportText(audit),'utf8')
 await fs.writeFile(detailPath,JSON.stringify(audit,null,2)+'\n','utf8')
 console.log('DAILY NEWS AUDIT:',JSON.stringify(audit.summary))
 console.log('DA TAO FILE:',summaryPath)
 console.log('DA TAO FILE:',detailPath)
 console.log('KHONG THAY DOI 94 BAI. KHONG DEPLOY.')
 return audit
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))runAudit().catch(e=>{console.error('AUDIT FAILED:',e.message);process.exitCode=1})
