/** Static Wiki catalog. A new versioned index is written before an atomic
 * manifest switch, so an interrupted job cannot corrupt the last good feed. */
import fs from 'node:fs/promises'
import path from 'node:path'
import {createHash} from 'node:crypto'
import {WIKI_TOPICS} from './discovery.mjs'

const hash=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex')
const catalogHash=(entries,stories)=>hash({entries:entries.map(row=>[row.id,row.shard,row.category]),
 stories:stories.map(story=>hash(story))})
const levels=['A1-A2','B1-B2','C1-C2']
export const WIKI_TARGET_STORIES=200
export const WIKI_TARGET_PER_TOPIC=15
export const EDITORIAL_PROFILE_LORE_V1='lore-v1'
export const wikiTargetMet=(total,counts)=>total>=WIKI_TARGET_STORIES&&
 WIKI_TOPICS.every(topic=>(counts?.[topic]||0)>=WIKI_TARGET_PER_TOPIC)
const exists=async file=>fs.access(file).then(()=>true,()=>false)
const nonempty=value=>typeof value==='string'&&value.trim().length>0

export function makeWikiStory({source,topic,draft,photos,evidence=[],now=new Date()}={}){
 if(!WIKI_TOPICS.includes(topic)||!source?.pageId||!draft?.variants||!photos?.length)throw Error('Incomplete Wiki story')
 const variants=Object.fromEntries(levels.map(level=>[level,{headline:draft.variants[level]?.headline,
  pages:draft.variants[level]?.pages?.map(page=>({text:page.text,image:page.image||'',caption:page.caption||'',
   ...(page.imageProvenance?{imageProvenance:page.imageProvenance}:{}),evidenceIds:page.evidenceIds,
   // Page Contract v1: focus words shown on the vocabulary card of pages without a photo.
   ...(Array.isArray(page.focus)&&page.focus.length?{focus:page.focus.map(f=>({surface:String(f?.surface||''),ipa:String(f?.ipa||''),vi:String(f?.vi||'')}))}:{})})),
  ...(Array.isArray(draft.variants[level]?.glossary)&&draft.variants[level].glossary.length?{glossary:draft.variants[level].glossary.map(item=>({...item}))}:{})}]))
 const story={id:`saga-wiki:${source.pageId}`,title:variants['B1-B2'].headline,sourceTitle:source.sourceTitle,
  sourceUrl:source.sourceUrl,sourceName:'English Wikipedia',publisher:'Wikipedia contributors',
  sourcePageId:source.pageId,sourceRevisionId:source.sourceRevisionId,sourceRevisionUrl:source.sourceRevisionUrl,
  sourceRetrievedAt:source.sourceRetrievedAt,contentType:'wiki',readingKind:'full',editorialVersion:2,
  ...(draft.readerLayoutVersion===3?{readerLayoutVersion:3}:{}),
  ...(draft.pageContractVersion===1?{pageContractVersion:1}:{}),
  ...(nonempty(draft.editorialProfile)?{editorialProfile:draft.editorialProfile.trim()}:{}),
  ...(nonempty(draft.slug)?{slug:draft.slug.trim()}:{}),
  category:topic,publishedAt:now.toISOString(),license:'CC BY-SA 4.0',licenseUrl:'https://creativecommons.org/licenses/by-sa/4.0/',
  attribution:'Adapted from English Wikipedia contributors; see pinned revision and history. SAGA AI-assisted adaptation under CC BY-SA 4.0. Wikipedia does not endorse SAGA.',
  levelVariants:variants,pages:variants['B1-B2'].pages.map(page=>({...page})),
  ...(variants['B1-B2'].glossary?{glossary:variants['B1-B2'].glossary.map(item=>({...item}))}:{}),
  sourceEvidence:evidence.map(row=>({id:row.id,hash:row.hash,excerpt:row.excerpt,...(row.heading?{heading:row.heading}:{})})),
  editorialState:'Source-grounded automated checks; not a guarantee of semantic accuracy'}
 const gate=validateWikiStory(story)
 if(!gate.accepted)throw Error('Wiki story gate: '+gate.errors.join(','))
 return story
}

export function validateWikiStory(story){
 const errors=[]
 if(story?.contentType!=='wiki'||story.editorialVersion!==2||!WIKI_TOPICS.includes(story.category))errors.push('identity')
 if(!Number.isSafeInteger(story?.sourcePageId)||!Number.isSafeInteger(story?.sourceRevisionId)||
  !/^https:\/\/en\.wikipedia\.org\/w\/index\.php\?oldid=\d+$/.test(story.sourceRevisionUrl||''))errors.push('source-revision')
 if(story?.license!=='CC BY-SA 4.0'||!nonempty(story.attribution))errors.push('text-license')
 const evidence=story?.sourceEvidence
 const evidenceIds=new Set()
 if(!Array.isArray(evidence)||!evidence.length||evidence.some(row=>{
  if(!/^P[1-9]\d*$/.test(row?.id||'')||!/^[a-f0-9]{64}$/.test(row?.hash||'')||!nonempty(row?.excerpt)||evidenceIds.has(row.id))return true
  evidenceIds.add(row.id);return false
 }))errors.push('source-evidence')
 const covers=[]
 for(const level of levels){
  const variant=story?.levelVariants?.[level],pages=variant?.pages
  if(!nonempty(variant?.headline)||!Array.isArray(pages)||pages.length<4||pages.length>(story.readerLayoutVersion===3?8:7)){errors.push(level+':structure');continue}
  for(const [pageIndex,page] of pages.entries()){
   if(!nonempty(page?.text)||!Array.isArray(page.evidenceIds)||!page.evidenceIds.length||
    page.evidenceIds.some(id=>!evidenceIds.has(id)))errors.push(level+':page-evidence')
   if(page.image){
    const p=page.imageProvenance||{}
    if(!nonempty(page.caption)||!nonempty(p.credit)||!nonempty(p.license)||!nonempty(p.licenseUrl)||
     !/^https:\/\/(?:thumb|upload)\.wikimedia\.org\//.test(page.image)||
     !/^https:\/\/creativecommons\.org\/(?:licenses\/(?:by|by-sa)\/(?:2\.0|2\.5|3\.0|4\.0)|publicdomain\/(?:zero|mark)\/1\.0)(?:\/|$|[?#])/i.test(p.licenseUrl||'')||
     !/^https:\/\/commons\.wikimedia\.org\/wiki\/File:/i.test(p.imagePageUrl||'')||
     p.sourceImageUrl!==story.sourceUrl||p.sourceRevisionUrl!==story.sourceRevisionUrl||
     p.evidence?.sourcePageId!==story.sourcePageId||p.evidence?.sourceRevisionId!==story.sourceRevisionId||
     p.evidence?.pageIndex!==pageIndex||!/^File:/.test(p.evidence?.fileTitle||''))errors.push(level+':image-rights')
   }
  }
  if(story.readerLayoutVersion===3&&new Set(pages.filter(p=>p.image).map(p=>p.image)).size!==pages.filter(p=>p.image).length)errors.push(level+':repeated-image-in-story')
  if(!pages.some(page=>page.image))errors.push(level+':verified-image')
  covers.push(pages[0]?.image)
 }
 if(new Set(covers).size!==1)errors.push('cross-level-cover-mismatch')
 const b=story?.levelVariants?.['B1-B2']?.pages||[]
 if(JSON.stringify(story?.pages)!==JSON.stringify(b))errors.push('root-pages-mismatch')
 if(new Set(b.filter(page=>page.image).map(page=>page.image)).size!==b.filter(page=>page.image).length)errors.push('repeated-image-in-story')
 return {accepted:errors.length===0,errors:[...new Set(errors)]}
}

export async function readWikiCatalog(base){
 const dir=path.join(base,'public','wiki-reader'),file=path.join(dir,'manifest.json')
 if(!await exists(file))return {dir,manifest:null,entries:[],stories:[]}
 const manifest=JSON.parse(await fs.readFile(file,'utf8'))
 if(manifest.feedType!=='wiki'||manifest.editorialVersion!==2||!/^catalog-index-[0-9a-f]{12}\.json$/.test(manifest.catalogIndex||''))throw Error('Wiki manifest invalid')
 const index=JSON.parse(await fs.readFile(path.join(dir,manifest.catalogIndex),'utf8'))
 if(index.contentHash!==manifest.contentHash||index.total!==manifest.total||index.entries?.length!==manifest.total)throw Error('Wiki catalog index mismatch')
 // A replacement is appended in a new immutable shard. The previous shard
 // may still contain other active entries and historical copies. The versioned
 // index, not the physical order of all rows in referenced shards, is canonical.
 const shards=new Map()
 for(const shard of new Set(index.entries.map(row=>row.shard))){
  if(!/^\d{4}$/.test(shard))throw Error('Wiki shard unsafe')
  const data=JSON.parse(await fs.readFile(path.join(dir,shard+'.json'),'utf8'))
  if(!Array.isArray(data)||data.some(story=>!validateWikiStory(story).accepted))throw Error('Stored Wiki shard invalid')
  shards.set(shard,data)
 }
 const seen=new Set()
 const stories=index.entries.map(row=>{
  if(seen.has(row.sourcePageId))throw Error('Wiki catalog duplicate indexed page')
  seen.add(row.sourcePageId)
  const matches=shards.get(row.shard).filter(s=>s.sourcePageId===row.sourcePageId&&s.sourceUrl===row.id)
  if(matches.length!==1)throw Error('Wiki catalog index entry missing or duplicated')
  return matches[0]
 })
 if(stories.length!==manifest.total)throw Error('Wiki catalog total mismatch')
 if(index.entries.some((row,i)=>row.id!==stories[i]?.sourceUrl||row.sourcePageId!==stories[i]?.sourcePageId)||
  catalogHash(index.entries,stories)!==manifest.contentHash)throw Error('Wiki catalog content mismatch')
 return {dir,manifest,entries:index.entries,stories}
}

async function writeFileAtomic(filePath,content){
 const tmp=`${filePath}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2,8)}`
 try{
  await fs.writeFile(tmp,content)
  await fs.rename(tmp,filePath)
 }catch(err){
  await fs.unlink(tmp).catch(()=>{})
  throw err
 }
}

 async function cleanUncommittedCatalogFiles(dir,{nextShard,referencedShards=new Set()}={}){
  const filesAfter=await fs.readdir(dir).catch(()=>[])
  for(const file of filesAfter){
   if(/\.tmp-/.test(file)){
    await fs.unlink(path.join(dir,file)).catch(()=>{})
   }else if(/^\d{4}\.json$/.test(file)){
    const shardId=file.slice(0,4)
    const shardNum=Number(shardId)
    if(Number.isSafeInteger(nextShard)&&shardNum>=nextShard&&!referencedShards.has(shardId)){
     await fs.unlink(path.join(dir,file)).catch(()=>{})
    }
   }
  }
 }

 export async function appendWikiStories(base,newStories,{now=new Date()}={}){
  const before=await readWikiCatalog(base)
  const usedIds=new Set(before.stories.map(story=>story.sourcePageId))
  const usedImages=new Set(before.stories.flatMap(story=>story.pages.map(page=>page.image).filter(Boolean)))
  const accepted=[]
  for(const story of newStories){
   const gate=validateWikiStory(story)
   if(!gate.accepted)throw Error('New Wiki story invalid: '+gate.errors.join(','))
   if(usedIds.has(story.sourcePageId))continue
   for(const image of story.pages.map(page=>page.image).filter(Boolean)){
    if(usedImages.has(image))throw Error('Image already belongs to another Wiki story')
    usedImages.add(image)
   }
   usedIds.add(story.sourcePageId);accepted.push(story)
  }
  if(!accepted.length)return {added:0,total:before.stories.length,ready:before.manifest?.ready||false}
  await fs.mkdir(before.dir,{recursive:true})
  const referencedNums=before.entries
   .map(entry=>Number(entry.shard))
   .filter(n=>Number.isSafeInteger(n)&&n>=0)
  const priorChunks=Number.isSafeInteger(before.manifest?.chunks)?before.manifest.chunks:0
  let nextShard=Math.max(-1,...referencedNums,priorChunks-1)+1
  const entries=[...before.entries]
  for(let i=0;i<accepted.length;i+=10){
   const shard=String(nextShard++).padStart(4,'0'),stories=accepted.slice(i,i+10)
   await writeFileAtomic(path.join(before.dir,shard+'.json'),JSON.stringify(stories)+'\n')
   entries.push(...stories.map(story=>({id:story.sourceUrl,sourcePageId:story.sourcePageId,shard,
    category:story.category,publisher:story.publisher,publishedAt:story.publishedAt,contentType:'wiki',title:story.title})))
  }
  const counts=Object.fromEntries(WIKI_TOPICS.map(topic=>[topic,0]))
  for(const entry of entries)counts[entry.category]++
  const ready=entries.length>0
  const targetMet=wikiTargetMet(entries.length,counts)
  const verifiedImageCount=[...before.stories,...accepted].reduce((total,story)=>total+
   story.pages.filter(page=>page.image).length,0)
  const contentHash=catalogHash(entries,[...before.stories,...accepted])
  const indexName=`catalog-index-${contentHash.slice(0,12)}.json`
  await writeFileAtomic(path.join(before.dir,indexName),JSON.stringify({version:3,contentHash,total:entries.length,entries})+'\n')
  const manifest={feedType:'wiki',editorialVersion:2,ready,targetStories:WIKI_TARGET_STORIES,
   targetPerTopic:WIKI_TARGET_PER_TOPIC,targetMet,total:entries.length,chunks:nextShard,
   withVerifiedPhoto:entries.length,verifiedImageCount,byTopic:counts,contentHash,catalogIndex:indexName,catalogIndexVersion:3,
   updatedAt:now.toISOString(),licenseNotice:'Wikipedia text adaptations: CC BY-SA 4.0; each embedded image has separate credit and rights.'}
  await writeFileAtomic(path.join(before.dir,'manifest.json'),JSON.stringify(manifest,null,2)+'\n')
  // Preserve previous catalog indexes and all referenced shards; clean ONLY verified temp/uncommitted orphan files
  const referencedShards=new Set([...before.entries,...entries].map(e=>e.shard))
  await cleanUncommittedCatalogFiles(before.dir,{nextShard,referencedShards})
  return {added:accepted.length,total:entries.length,ready,byTopic:counts,catalogIndex:indexName,chunks:nextShard}
 }

 /**
  * Safely replace one existing validated Wiki story in an immutable new shard + versioned index.
  * Preserves story.id, sourcePageId, category, publishedAt, attribution, and all previous shards/indexes for recovery.
  */
 export async function replaceWikiStory(base,updatedStory,{now=new Date()}={}){
  const before=await readWikiCatalog(base)
  const index=before.stories.findIndex(story=>story.sourcePageId===updatedStory?.sourcePageId)
  if(index<0)throw Error(`Published Wiki story not found for pageId=${updatedStory?.sourcePageId}`)
  const existing=before.stories[index]
  const normalized=structuredClone(updatedStory)
  normalized.id=existing.id
  if(existing.slug!==undefined)normalized.slug=existing.slug
  normalized.sourcePageId=existing.sourcePageId
  normalized.category=existing.category
  normalized.publishedAt=existing.publishedAt
  normalized.regeneratedAt=now.toISOString()

  const gate=validateWikiStory(normalized)
  if(!gate.accepted)throw Error('Replacement Wiki story invalid: '+gate.errors.join(','))

  // Ensure images do not collide with any OTHER published story (reusing this story's own article images is allowed)
  const otherImages=new Set(
   before.stories
    .filter((_,i)=>i!==index)
    .flatMap(story=>story.pages.map(page=>page.image).filter(Boolean))
  )
  for(const image of normalized.pages.map(page=>page.image).filter(Boolean)){
   if(otherImages.has(image))throw Error('Replacement image already belongs to another Wiki story')
  }

  const referencedNums=before.entries
   .map(entry=>Number(entry.shard))
   .filter(n=>Number.isSafeInteger(n)&&n>=0)
  const priorChunks=Number.isSafeInteger(before.manifest?.chunks)?before.manifest.chunks:0
  const files=await fs.readdir(before.dir)
  const diskNums=files.filter(f=>/^\d{4}\.json$/.test(f)).map(f=>Number(f.slice(0,4)))
  const nextShard=Math.max(-1,...referencedNums,priorChunks-1,...diskNums)+1
  const shard=String(nextShard).padStart(4,'0')
  await writeFileAtomic(path.join(before.dir,shard+'.json'),JSON.stringify([normalized])+'\n')

  const entries=before.entries.map((entry,i)=>i===index
   ?{...entry,shard,title:normalized.title,publishedAt:normalized.publishedAt,category:normalized.category}
   :entry)
  const stories=before.stories.map((story,i)=>i===index?normalized:story)
  const counts=Object.fromEntries(WIKI_TOPICS.map(topic=>[topic,0]))
  for(const entry of entries)counts[entry.category]++
  const verifiedImageCount=stories.reduce((total,story)=>total+story.pages.filter(page=>page.image).length,0)
  const contentHash=catalogHash(entries,stories)
  const indexName=`catalog-index-${contentHash.slice(0,12)}.json`
  await writeFileAtomic(path.join(before.dir,indexName),JSON.stringify({version:3,contentHash,total:entries.length,entries})+'\n')

  const manifest={
   ...before.manifest,
   total:entries.length,
   chunks:nextShard+1,
   withVerifiedPhoto:entries.length,
   verifiedImageCount,
   byTopic:counts,
   contentHash,
   catalogIndex:indexName,
   catalogIndexVersion:3,
   updatedAt:now.toISOString()
  }
  await writeFileAtomic(path.join(before.dir,'manifest.json'),JSON.stringify(manifest,null,2)+'\n')
  const referencedShards=new Set([...before.entries,...entries].map(e=>e.shard))
  await cleanUncommittedCatalogFiles(before.dir,{nextShard:nextShard+1,referencedShards})
  return {replaced:true,id:normalized.id,sourcePageId:normalized.sourcePageId,shard,catalogIndex:indexName,previousCatalogIndex:before.manifest?.catalogIndex||null,total:entries.length}
 }

 /** List all preserved versioned catalog indexes available for safe rollback/recovery. */
 export async function listWikiCatalogSnapshots(base){
  const dir=path.join(base,'public','wiki-reader')
  const files=await fs.readdir(dir).catch(()=>[])
  const snapshots=[]
  for(const file of files.filter(f=>/^catalog-index-[0-9a-f]{12}\.json$/.test(f)).sort()){
   try{
    const idx=JSON.parse(await fs.readFile(path.join(dir,file),'utf8'))
    snapshots.push({catalogIndex:file,contentHash:idx.contentHash,total:idx.total})
   }catch{}
  }
  return snapshots
 }

 /** Atomically restore manifest.json to a previously preserved, fully verified catalog index snapshot. */
 export async function restoreWikiCatalogSnapshot(base,indexName,{now=new Date()}={}){
  if(!/^catalog-index-[0-9a-f]{12}\.json$/.test(String(indexName||'')))throw Error('Unsafe catalog index snapshot name')
  const dir=path.join(base,'public','wiki-reader')
  const index=JSON.parse(await fs.readFile(path.join(dir,indexName),'utf8'))
  if(!Array.isArray(index.entries)||index.entries.length!==index.total)throw Error('Snapshot index entries invalid')
  const stories=[]
  const shardNums=[]
  for(const shard of new Set(index.entries.map(row=>row.shard))){
   if(!/^\d{4}$/.test(shard))throw Error('Snapshot shard unsafe')
   shardNums.push(Number(shard))
   const data=JSON.parse(await fs.readFile(path.join(dir,shard+'.json'),'utf8'))
   if(!Array.isArray(data)||data.some(story=>!validateWikiStory(story).accepted))throw Error(`Snapshot shard ${shard} invalid`)
   stories.push(...data)
  }
  if(stories.length!==index.total)throw Error('Snapshot story total mismatch')
  if(index.entries.some((row,i)=>row.id!==stories[i]?.sourceUrl||row.sourcePageId!==stories[i]?.sourcePageId)||
   catalogHash(index.entries,stories)!==index.contentHash)throw Error('Snapshot content hash mismatch')

  const counts=Object.fromEntries(WIKI_TOPICS.map(topic=>[topic,0]))
  for(const entry of index.entries)counts[entry.category]++
  const verifiedImageCount=stories.reduce((total,story)=>total+story.pages.filter(page=>page.image).length,0)
  const chunks=shardNums.length?Math.max(...shardNums)+1:0
  const manifest={
   feedType:'wiki',editorialVersion:2,ready:index.entries.length>0,
   targetStories:WIKI_TARGET_STORIES,targetPerTopic:WIKI_TARGET_PER_TOPIC,
   targetMet:wikiTargetMet(index.entries.length,counts),total:index.entries.length,chunks,
   withVerifiedPhoto:index.entries.length,verifiedImageCount,byTopic:counts,
   contentHash:index.contentHash,catalogIndex:indexName,catalogIndexVersion:3,
   updatedAt:now.toISOString(),
   licenseNotice:'Wikipedia text adaptations: CC BY-SA 4.0; each embedded image has separate credit and rights.'
  }
  await writeFileAtomic(path.join(dir,'manifest.json'),JSON.stringify(manifest,null,2)+'\n')
  return {restored:true,catalogIndex:indexName,total:index.entries.length,contentHash:index.contentHash}
 }

 /** Restore a caption from its already recorded, source-embedded evidence.
  * Write a new shard and index; never alter a published shard in place. */
 export async function restoreWikiSourceCaptions(base,pageId,{now=new Date()}={}){
  const before=await readWikiCatalog(base)
  const index=before.stories.findIndex(story=>story.sourcePageId===pageId)
  if(index<0)throw Error('Published Wiki story not found')
  const revised=structuredClone(before.stories[index])
  let restored=0
  for(const pages of [revised.pages,...levels.map(level=>revised.levelVariants[level].pages)]){
   for(const page of pages){
    if(!page.image)continue
    const sourceCaption=String(page.imageProvenance?.evidence?.articleCaption||'').replace(/\s+/g,' ').trim()
    if(!sourceCaption||!sourceCaption.startsWith(page.caption))throw Error('Caption lacks exact source evidence')
    if(sourceCaption.length>page.caption.length){page.caption=sourceCaption;restored++}
   }
  }
  if(!restored)return {restored:0,total:before.stories.length}
  const gate=validateWikiStory(revised)
  if(!gate.accepted)throw Error('Revised Wiki story invalid: '+gate.errors.join(','))
  const files=await fs.readdir(before.dir)
  const nextShard=Math.max(-1,...files.filter(file=>/^\d{4}\.json$/.test(file)).map(file=>Number(file.slice(0,4))))+1
  const shard=String(nextShard).padStart(4,'0')
  await fs.writeFile(path.join(before.dir,shard+'.json'),JSON.stringify([revised])+'\n',{flag:'wx'})
  const entries=before.entries.map((entry,i)=>i===index?{...entry,shard}:entry)
  const stories=before.stories.map((story,i)=>i===index?revised:story)
  const contentHash=catalogHash(entries,stories)
  const catalogIndex=`catalog-index-${contentHash.slice(0,12)}.json`
  await fs.writeFile(path.join(before.dir,catalogIndex),JSON.stringify({version:3,contentHash,total:entries.length,entries})+'\n',{flag:'wx'})
  const manifest={...before.manifest,chunks:nextShard+1,contentHash,catalogIndex,updatedAt:now.toISOString()}
  const stage=path.join(before.dir,'manifest.json.tmp-'+process.pid)
  await fs.writeFile(stage,JSON.stringify(manifest,null,2)+'\n')
  await fs.rename(stage,path.join(before.dir,'manifest.json'))
  return {restored,total:entries.length,shard}
 }

 /** Copy only new, fully verified stories into the production catalog. */
 export async function promoteWikiCatalog(sourceRoot,targetRoot){
  const source=await readWikiCatalog(sourceRoot),target=await readWikiCatalog(targetRoot)
  const existing=new Map(target.stories.map(story=>[story.sourcePageId,story]))
  const additions=[]
  for(const story of source.stories){
   const prior=existing.get(story.sourcePageId)
   if(prior){if(hash(prior)!==hash(story))throw Error(`Conflicting published Wiki story ${story.sourcePageId}`);continue}
   additions.push(story)
  }
  return appendWikiStories(targetRoot,additions)
 }

/** Repack the static Wiki catalog from an exact verified story list, removing stale shards/indexes. */
export async function rewriteWikiCatalog(base,cleanStories,{now=new Date()}={}){
 const dir=path.join(base,'public','wiki-reader')
 const usedIds=new Set()
 const usedImages=new Set()
 const verified=[]
 for(const story of cleanStories||[]){
  const gate=validateWikiStory(story)
  if(!gate.accepted)throw Error(`Clean Wiki story invalid (${story?.id}): ${gate.errors.join(',')}`)
  if(usedIds.has(story.sourcePageId))throw Error(`Duplicate Wiki story pageId: ${story.sourcePageId}`)
  for(const image of story.pages.map(page=>page.image).filter(Boolean)){
   if(usedImages.has(image))throw Error(`Repeated Wiki image across stories: ${image}`)
   usedImages.add(image)
  }
  usedIds.add(story.sourcePageId)
  verified.push(story)
 }

 await fs.mkdir(dir,{recursive:true})
 const existingFiles=await fs.readdir(dir)
 for(const file of existingFiles){
  if(/^\d{4}\.json$/.test(file)||/^catalog-index-[0-9a-f]{12}\.json$/.test(file)){
   await fs.unlink(path.join(dir,file))
  }
 }

 const entries=[]
 let nextShard=0
 for(let i=0;i<verified.length;i+=10){
  const shard=String(nextShard++).padStart(4,'0')
  const slice=verified.slice(i,i+10)
  await fs.writeFile(path.join(dir,shard+'.json'),JSON.stringify(slice)+'\n')
  entries.push(...slice.map(story=>({
   id:story.sourceUrl,
   sourcePageId:story.sourcePageId,
   shard,
   category:story.category,
   publisher:story.publisher,
   publishedAt:story.publishedAt,
   contentType:'wiki',
   title:story.title
  })))
 }

 const counts=Object.fromEntries(WIKI_TOPICS.map(topic=>[topic,0]))
 for(const entry of entries)counts[entry.category]++
 const ready=entries.length>0
 const targetMet=wikiTargetMet(entries.length,counts)
 const verifiedImageCount=usedImages.size
 const contentHash=catalogHash(entries,verified)
 const indexName=`catalog-index-${contentHash.slice(0,12)}.json`

 await fs.writeFile(path.join(dir,indexName),JSON.stringify({version:3,contentHash,total:entries.length,entries})+'\n')
 const manifest={
  feedType:'wiki',
  editorialVersion:2,
  ready,
  targetStories:WIKI_TARGET_STORIES,
  targetPerTopic:WIKI_TARGET_PER_TOPIC,
  targetMet,
  total:entries.length,
  chunks:nextShard,
  withVerifiedPhoto:entries.length,
  verifiedImageCount,
  byTopic:counts,
  contentHash,
  catalogIndex:indexName,
  catalogIndexVersion:3,
  updatedAt:now.toISOString(),
  licenseNotice:'Wikipedia text adaptations: CC BY-SA 4.0; each embedded image has separate credit and rights.'
 }
 const stage=path.join(dir,'manifest.json.tmp-'+process.pid)
 await fs.writeFile(stage,JSON.stringify(manifest,null,2)+'\n')
 await fs.rename(stage,path.join(dir,'manifest.json'))
 return {total:entries.length,chunks:nextShard,verifiedImageCount,byTopic:counts,contentHash,catalogIndex:indexName}
}
