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
const wordCount=text=>String(text||'').trim().split(/\s+/).filter(Boolean).length

export async function auditExistingWikiImages({root=ROOT,sparseThreshold=28}={}){
 const catalog=await readWikiCatalog(root)
 const stories=catalog.stories||[]

 const nonEmbeddedArticles=[]
 const nonLeadPage1Articles=[]
 const missingPage1PhotoArticles=[]
 const sparsePage1Articles=[]
 const sparsePhotoPageArticles=[]

 let totalImages=0
 let totalNonEmbeddedImages=0

 for(const story of stories){
  const b1Pages=story.levelVariants?.['B1-B2']?.pages||story.pages||[]

  // 1. Check all images for originType !== 'wikipedia-embedded'
  const badOriginPages=[]
  b1Pages.forEach((page,idx)=>{
   if(!page?.image)return
   totalImages++
   const origin=String(page.imageProvenance?.originType||'').trim()
   if(origin!=='wikipedia-embedded'){
    totalNonEmbeddedImages++
    badOriginPages.push({
     pageNumber:idx+1,
     originType:origin||'missing',
     section:String(page.imageProvenance?.evidence?.articleSection||'unknown'),
     fileTitle:String(page.imageProvenance?.evidence?.fileTitle||page.image)
    })
   }
  })
  if(badOriginPages.length){
   nonEmbeddedArticles.push({
    id:story.id,
    sourceTitle:story.sourceTitle,
    title:story.title,
    category:story.category,
    pages:badOriginPages
   })
  }

  // 2. Check Page 1 image section (Lead/Infobox vs non-Lead or missing Page 1 image)
  const p0=b1Pages[0]
  if(!p0?.image){
   const firstImgIdx=b1Pages.findIndex(p=>Boolean(p?.image))
   const firstImgPage=firstImgIdx>=0?b1Pages[firstImgIdx]:null
   const promotedSection=String(firstImgPage?.imageProvenance?.evidence?.articleSection||'none')
   missingPage1PhotoArticles.push({
    id:story.id,
    sourceTitle:story.sourceTitle,
    title:story.title,
    category:story.category,
    firstImagePage:firstImgIdx>=0?firstImgIdx+1:null,
    firstImageSection:promotedSection
   })
   nonLeadPage1Articles.push({
    id:story.id,
    sourceTitle:story.sourceTitle,
    title:story.title,
    category:story.category,
    reason:'missing-page1-image',
    articleSection:promotedSection,
    firstImagePage:firstImgIdx>=0?firstImgIdx+1:null
   })
  }else{
   const sec=String(p0.imageProvenance?.evidence?.articleSection||'').trim()
   if(!LEAD_SECTION_RE.test(sec)){
    nonLeadPage1Articles.push({
     id:story.id,
     sourceTitle:story.sourceTitle,
     title:story.title,
     category:story.category,
     reason:'non-lead-section',
     articleSection:sec||'missing',
     fileTitle:String(p0.imageProvenance?.evidence?.fileTitle||'')
    })
   }
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
  totalArticles:stories.length,
  totalImages,
  totalNonEmbeddedImages,
  nonEmbeddedArticles,
  nonLeadPage1Articles,
  missingPage1PhotoArticles,
  sparsePage1Articles,
  sparsePhotoPageArticles
 }
}

function printReport(report){
 console.log('=================================================================')
 console.log('SAGA WIKI IMAGE & PHOTO-PAGE AUDIT REPORT (READ-ONLY)')
 console.log('=================================================================')
 console.log(`Total articles scanned:                    ${report.totalArticles}`)
 console.log(`Total attached images (B1-B2):             ${report.totalImages}`)
 console.log('-----------------------------------------------------------------')
 console.log(`1. Articles with non-embedded images:      ${report.nonEmbeddedArticles.length} (${report.totalNonEmbeddedImages} image(s) with originType !== "wikipedia-embedded")`)
 console.log(`2. Articles with non-Lead Page 1 images:   ${report.nonLeadPage1Articles.length}`)
 console.log(`   - Missing Page 1 image (later section): ${report.missingPage1PhotoArticles.length}`)
 console.log(`   - Page 1 image from non-Lead section:   ${report.nonLeadPage1Articles.length-report.missingPage1PhotoArticles.length}`)
 console.log(`3. Articles with sparse photo pages (<28w): ${report.sparsePhotoPageArticles.length}`)
 console.log('=================================================================')

 if(report.nonEmbeddedArticles.length){
  console.log('\n[1] Non-embedded images (originType !== "wikipedia-embedded"):')
  for(const a of report.nonEmbeddedArticles){
   const detail=a.pages.map(p=>`P${p.pageNumber}:${p.originType}(${p.section})`).join(', ')
   console.log(`  - ${a.id} | [${a.category}] ${a.sourceTitle} -> ${detail}`)
  }
 }

 if(report.nonLeadPage1Articles.length){
  console.log('\n[2] Page 1 images from non-Lead sections (or missing Lead photo):')
  for(const a of report.nonLeadPage1Articles.slice(0,50)){
   if(a.reason==='missing-page1-image'){
    console.log(`  - ${a.id} | [${a.category}] ${a.sourceTitle} -> no P1 image (first image on P${a.firstImagePage}: "${a.articleSection}")`)
   }else{
    console.log(`  - ${a.id} | [${a.category}] ${a.sourceTitle} -> P1 image section="${a.articleSection}" (${a.fileTitle})`)
   }
  }
  if(report.nonLeadPage1Articles.length>50){
   console.log(`  ... and ${report.nonLeadPage1Articles.length-50} more (pass --json for complete list)`)
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
