#!/usr/bin/env node
/**
 * Read-only audit script for existing SAGA Wiki articles in public/wiki-reader/.
 *
 * Scans every published story without modifying or deleting anything and reports:
 * 1. Articles with non-embedded images (originType !== 'wikipedia-embedded', e.g. Commons backfill).
 * 2. Articles with Page 1 images from non-Lead/Infobox sections (or missing a Page 1 Lead image).
 * 3. Articles with sparse Page 1 text (< 28 words in any CEFR level).
 */
import path from 'node:path'
import {fileURLToPath} from 'node:url'
import {readWikiCatalog} from './wiki/catalog.mjs'

const ROOT=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..')
const LEVELS=['A1-A2','B1-B2','C1-C2']
const LEAD_SECTION_RE=/^(?:lead|infobox)$/i
const VALID_IMAGE_URL_RE=/^https?:\/\/\S+/i
const wordCount=text=>String(text||'').trim().split(/\s+/).filter(Boolean).length

export function auditWikiStories(stories,{sparseThreshold=28}={}){
 const list=Array.isArray(stories)?stories:[]
 const nonEmbeddedArticles=[]
 const nonLeadPage1Articles=[]
 const missingPage1PhotoArticles=[]
 const page1ParityIssues=[]
 const sparsePage1Articles=[]
 const sparsePhotoPageArticles=[]

 let totalImages=0
 let totalNonEmbeddedImages=0

 for(const story of list){
  const b1Pages=story.levelVariants?.['B1-B2']?.pages||story.pages||[]
  const scopes=[
   {scope:'top',pages:Array.isArray(story.pages)?story.pages:[]},
   ...LEVELS.map(level=>({scope:level,pages:Array.isArray(story.levelVariants?.[level]?.pages)?story.levelVariants[level].pages:[]}))
  ]

  // 1. Check all images across top-level pages and all 3 CEFR levels for originType !== 'wikipedia-embedded'
  const badOriginPages=[]
  const seenBadOrigin=new Set()
  b1Pages.forEach(page=>{if(page?.image)totalImages++})

  for(const {scope,pages} of scopes){
   pages.forEach((page,idx)=>{
    if(!page?.image)return
    const origin=String(page.imageProvenance?.originType||'').trim()
    if(origin!=='wikipedia-embedded'){
     const dedupKey=`${scope}:${idx}:${page.image}`
     if(!seenBadOrigin.has(dedupKey)){
      seenBadOrigin.add(dedupKey)
      if(scope==='B1-B2')totalNonEmbeddedImages++
      badOriginPages.push({
       level:scope,
       pageNumber:idx+1,
       originType:origin||'missing',
       section:String(page.imageProvenance?.evidence?.articleSection||'unknown'),
       fileTitle:String(page.imageProvenance?.evidence?.fileTitle||page.image)
      })
     }
    }
   })
  }
  if(badOriginPages.length){
   if(totalNonEmbeddedImages===0)totalNonEmbeddedImages=badOriginPages.length
   nonEmbeddedArticles.push({
    id:story.id,
    sourceTitle:story.sourceTitle,
    title:story.title,
    category:story.category,
    pages:badOriginPages
   })
  }

  // 2. Check Page 1 image presence, valid URL, Lead/Infobox section, and cross-level parity across top + ALL 3 CEFR levels
  const missingScopes=[]
  const nonLeadScopes=[]
  const p0UrlsByScope={}

  for(const {scope,pages} of scopes){
   const p0=pages[0]
   const imgUrl=String(p0?.image||'').trim()
   p0UrlsByScope[scope]=imgUrl
   if(!imgUrl||!VALID_IMAGE_URL_RE.test(imgUrl)){
    const firstImgIdx=pages.findIndex(p=>Boolean(String(p?.image||'').trim()))
    const firstImgPage=firstImgIdx>=0?pages[firstImgIdx]:null
    missingScopes.push({
     level:scope,
     firstImagePage:firstImgIdx>=0?firstImgIdx+1:null,
     firstImageSection:String(firstImgPage?.imageProvenance?.evidence?.articleSection||'none')
    })
   }else{
    const sec=String(p0.imageProvenance?.evidence?.articleSection||'').trim()
    if(!LEAD_SECTION_RE.test(sec)){
     nonLeadScopes.push({
      level:scope,
      articleSection:sec||'missing',
      fileTitle:String(p0.imageProvenance?.evidence?.fileTitle||'')
     })
    }
   }
  }

  const distinctP0Urls=new Set(Object.values(p0UrlsByScope).filter(Boolean))
  const hasParityMismatch=missingScopes.length>0&&distinctP0Urls.size>0||distinctP0Urls.size>1

  if(hasParityMismatch){
   page1ParityIssues.push({
    id:story.id,
    sourceTitle:story.sourceTitle,
    title:story.title,
    category:story.category,
    urlsByScope:p0UrlsByScope
   })
  }

  if(missingScopes.length){
   const primary=missingScopes.find(s=>s.level==='B1-B2')||missingScopes[0]
   missingPage1PhotoArticles.push({
    id:story.id,
    sourceTitle:story.sourceTitle,
    title:story.title,
    category:story.category,
    missingLevels:missingScopes.map(s=>s.level),
    firstImagePage:primary.firstImagePage,
    firstImageSection:primary.firstImageSection
   })
   nonLeadPage1Articles.push({
    id:story.id,
    sourceTitle:story.sourceTitle,
    title:story.title,
    category:story.category,
    reason:'missing-page1-image',
    missingLevels:missingScopes.map(s=>s.level),
    articleSection:primary.firstImageSection,
    firstImagePage:primary.firstImagePage
   })
  }else if(nonLeadScopes.length){
   const primary=nonLeadScopes.find(s=>s.level==='B1-B2')||nonLeadScopes[0]
   nonLeadPage1Articles.push({
    id:story.id,
    sourceTitle:story.sourceTitle,
    title:story.title,
    category:story.category,
    reason:'non-lead-section',
    nonLeadLevels:nonLeadScopes.map(s=>s.level),
    articleSection:primary.articleSection,
    fileTitle:primary.fileTitle
   })
  }

  // 3. Check sparse photo pages (< sparseThreshold words) across ALL pages & all 3 CEFR levels
  const sparseLevels=[]
  const sparsePhotoPages=[]
  for(const level of LEVELS){
   const lvlPages=story.levelVariants?.[level]?.pages||[]
   const p0Words=wordCount(lvlPages[0]?.text)
   if(p0Words<sparseThreshold){
    sparseLevels.push({level,words:p0Words,hasImage:Boolean(lvlPages[0]?.image)})
   }
   lvlPages.forEach((pg,pIdx)=>{
    if(!pg?.image)return
    const wc=wordCount(pg.text)
    if(wc<sparseThreshold){
     sparsePhotoPages.push({level,pageNumber:pIdx+1,words:wc})
    }
   })
  }
  if(sparseLevels.length){
   sparsePage1Articles.push({
    id:story.id,
    sourceTitle:story.sourceTitle,
    title:story.title,
    category:story.category,
    sparseLevels
   })
  }
  if(sparsePhotoPages.length){
   sparsePhotoPageArticles.push({
    id:story.id,
    sourceTitle:story.sourceTitle,
    title:story.title,
    category:story.category,
    sparsePhotoPages
   })
  }
 }

 return {
  totalArticles:list.length,
  totalImages,
  totalNonEmbeddedImages,
  nonEmbeddedArticles,
  nonLeadPage1Articles,
  missingPage1PhotoArticles,
  page1ParityIssues,
  sparsePage1Articles,
  sparsePhotoPageArticles
 }
}

export async function auditExistingWikiImages({root=ROOT,sparseThreshold=28}={}){
 const catalog=await readWikiCatalog(root)
 return auditWikiStories(catalog.stories||[],{sparseThreshold})
}

function printReport(report){
 console.log('=================================================================')
 console.log('SAGA WIKI IMAGE & PHOTO-PAGE AUDIT REPORT (READ-ONLY)')
 console.log('=================================================================')
 console.log(`Total articles scanned:                    ${report.totalArticles}`)
 console.log(`Total attached images (B1-B2):             ${report.totalImages}`)
 console.log('-----------------------------------------------------------------')
 console.log(`1. Articles with non-embedded images:      ${report.nonEmbeddedArticles.length} (checked top + A1-A2/B1-B2/C1-C2)`)
 console.log(`2. Articles with non-Lead Page 1 images:   ${report.nonLeadPage1Articles.length} (checked top + A1-A2/B1-B2/C1-C2)`)
 console.log(`   - Missing Page 1 image (any level):     ${report.missingPage1PhotoArticles.length}`)
 console.log(`   - Page 1 image from non-Lead section:   ${report.nonLeadPage1Articles.length-report.missingPage1PhotoArticles.length}`)
 console.log(`   - Page 1 cross-level parity mismatches: ${report.page1ParityIssues.length}`)
 console.log(`3. Articles with sparse photo pages (<28w): ${report.sparsePhotoPageArticles.length}`)
 console.log('=================================================================')

 if(report.nonEmbeddedArticles.length){
  console.log('\n[1] Non-embedded images (originType !== "wikipedia-embedded"):')
  for(const a of report.nonEmbeddedArticles){
   const detail=a.pages.map(p=>`${p.level}:P${p.pageNumber}:${p.originType}(${p.section})`).join(', ')
   console.log(`  - ${a.id} | [${a.category}] ${a.sourceTitle} -> ${detail}`)
  }
 }

 if(report.nonLeadPage1Articles.length){
  console.log('\n[2] Page 1 images from non-Lead sections (or missing Lead photo):')
  for(const a of report.nonLeadPage1Articles.slice(0,50)){
   if(a.reason==='missing-page1-image'){
    console.log(`  - ${a.id} | [${a.category}] ${a.sourceTitle} -> missing P1 image in [${(a.missingLevels||[]).join(', ')}] (first image on P${a.firstImagePage}: "${a.articleSection}")`)
   }else{
    console.log(`  - ${a.id} | [${a.category}] ${a.sourceTitle} -> P1 image section="${a.articleSection}" in [${(a.nonLeadLevels||[]).join(', ')}] (${a.fileTitle})`)
   }
  }
  if(report.nonLeadPage1Articles.length>50){
   console.log(`  ... and ${report.nonLeadPage1Articles.length-50} more (pass --json for complete list)`)
  }
 }

 if(report.page1ParityIssues.length){
  console.log('\n[2b] Page 1 cross-level parity mismatches:')
  for(const a of report.page1ParityIssues){
   console.log(`  - ${a.id} | [${a.category}] ${a.sourceTitle} -> ${JSON.stringify(a.urlsByScope)}`)
  }
 }

 if(report.sparsePhotoPageArticles.length){
  console.log('\n[3] Sparse photo pages (< 28 words):')
  for(const a of report.sparsePhotoPageArticles){
   const lvls=a.sparsePhotoPages.map(s=>`${s.level}:P${s.pageNumber}=${s.words}w`).join(', ')
   console.log(`  - ${a.id} | [${a.category}] ${a.sourceTitle} (${a.title}) -> ${lvls}`)
  }
 }
}

if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 const asJson=process.argv.includes('--json')
 auditExistingWikiImages()
  .then(report=>{
   if(asJson)console.log(JSON.stringify(report,null,2))
   else printReport(report)
  })
  .catch(err=>{
   console.error('Audit failed:',err.message)
   process.exit(1)
  })
}
