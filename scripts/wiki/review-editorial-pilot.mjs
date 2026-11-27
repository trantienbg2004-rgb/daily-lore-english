// Review the two ChatGPT-authored, visually tested pilot articles with a
// separate Gemini model against the EXACT pinned Wikipedia source revision.
// This script cannot approve a draft without the independent descriptor gate.
import fs from 'node:fs/promises'
import {createHash} from 'node:crypto'
import {fetchWikipediaParsePage} from './source.mjs'
import {readWikiCatalog,validateWikiStory,replaceWikiStory} from './catalog.mjs'
import {buildCEFRReviewRepairPrompt,buildCEFRReviewRepairSchema,simplifyEditorialSchema,applyCEFRReviewRepairs,validateArticleQuality,resolveGeminiApiKeys,callGeminiWithFailover} from '../publish_wiki_batch.mjs'
import {openEditorialMeter} from './editorial-meter.mjs'
const root=process.cwd()
const levels=['A1-A2','B1-B2','C1-C2']
const output=process.env.SAGA_PILOT_APPROVED_FILE||'/tmp/saga-approved-pilots.json'
const factsById={
 20958:[
  ['John sealed a charter at Runnymede in 1215 in an attempt to settle the conflict with rebel barons.',['P1','P5','P6']],
  ['The 1215 settlement failed; Henry III’s government reissued the charter in 1216 with changes.',['P1','P2','P7']],
  ['Later reissues were connected with the political and fiscal relationship between the monarch and subjects.',['P2','P9','P10']],
  ['Early modern interpretations of ancient English liberty differed from the charter’s medieval purpose.',['P3','P4']],
  ['The charter influenced American constitutional thought and became a lasting symbol; most clauses no longer remain in law.',['P3','P4','P10']]
 ],
 79511869:[
  ['GOAT abbreviates greatest of all time; sports media sometimes uses imagery of the animal.',['P1','P4','P7']],
  ['The older negative usage contrasts with the positive association with Muhammad Ali and the company Greatest of All Time.',['P4','P6','P10']],
  ['Assessments vary with criteria, eras, positions and individual versus team sports.',['P2','P5','P8','P13','P14']],
  ['Players respond differently to GOAT discussions, including refusing to participate.',['P3','P9','P15','P16']],
  ['In 2017, Tom Brady’s teammates brought five goats representing his five Super Bowl wins at the time.',['P7']]
 ]
}
if(process.argv.includes('--install-approved')){
 const approved=JSON.parse(await fs.readFile(output,'utf8'))
 if(approved.length!==2||new Set(approved.map(s=>s.sourcePageId)).size!==2)throw Error('Both reviewed pilots required')
 for(const story of approved){
  if(!factsById[story.sourcePageId]||story.editorialState.includes('TEST FIXTURE')||!story.editorialPilotReview?.model||!validateWikiStory(story).accepted)throw Error('Invalid reviewed pilot')
  await replaceWikiStory(root,story)
 }
 console.log('INSTALLED independently reviewed pilots',approved.map(s=>s.sourcePageId))
 process.exit(0)
}
const catalog=await readWikiCatalog(root)
const meter=await openEditorialMeter(process.env.SAGA_EDITORIAL_BASE_URL||'http://127.0.0.1:4173')
const approved=[]
const keyState={keys:resolveGeminiApiKeys(),activeIndex:0}
try{
 for(const [id,defs] of Object.entries(factsById)){
  const story=catalog.stories.find(s=>s.sourcePageId===Number(id))
  if(!story||story.readerLayoutVersion!==3||!story.editorialState.includes('TEST FIXTURE'))throw Error('Missing isolated authored pilot '+id)
  const source=await fetchWikipediaParsePage(story.sourceTitle,{revisionId:story.sourceRevisionId,expectedPageId:story.sourcePageId})
  const hash=t=>createHash('sha256').update(t).digest('hex')
  const byHash=new Map(source.paragraphDetails.map(row=>[hash(row.text),row]))
  const evidence=story.sourceEvidence.map(old=>{
   const row=byHash.get(old.hash)
   if(!row)throw Error('Pinned source paragraph hash mismatch '+id+' '+old.id)
   return {...old,text:row.text,sectionIndex:row.sectionIndex,heading:row.heading}
  })
  console.log('PINNED SOURCE VERIFIED',id,source.sourceRevisionId,evidence.length)
  const coreFacts=defs.map(([fact,evidenceIds],i)=>({id:'F'+(i+1),fact,evidenceIds,hasUncertainty:false}))
  const all=coreFacts.map(f=>f.id)
  const variants=Object.fromEntries(levels.map(level=>[level,{headline:story.levelVariants[level].headline,pages:story.levelVariants[level].pages.map((p,i)=>({text:p.text,imageId:p.image?'IMG_'+i:null,caption:p.caption,evidenceIds:p.evidenceIds})),glossary:story.levelVariants[level].glossary||[]}]))
  const draft={variants,factSheet:{mainSubject:story.sourceTitle,coreFacts},outline:[],sharedCoreFactIds:all.slice(0,2),levelPlans:Object.fromEntries(levels.map((l,i)=>[l,{readerObjective:['Understand the essential story in simple English','Understand context, causes and implications','Evaluate the conceptual and historical nuances'][i],selectedFactIds:all,depthNotes:['Concrete explanations and short sentences','Develop context and relationships','Precise distinctions and layered reasoning'][i]}]))}
  const opts={source,evidence,editorialRhythm:true,measuredLayout:true,requireLevelPlans:true}
  const quality=validateArticleQuality(draft,story.sourceTitle,opts)
  console.log('PILOT DETERMINISTIC ISSUES',id,JSON.stringify(quality.errors))
  const required=new Set(quality.errors.map(e=>String(e).match(/^(A1-A2|B1-B2|C1-C2)/)?.[1]).filter(Boolean))
  if(quality.errors.length&&!required.size)for(const l of levels)required.add(l)
  const prompt=buildCEFRReviewRepairPrompt(source,story.category,evidence,draft,quality,{editorialRhythm:true,budgets:meter.budgets})+'\n\nAUTHOR IS CHATGPT, NOT GEMINI. You are the independent examiner. These draft pages already passed actual browser copyfitting. Preserve passing prose and captions. If a factual or CEFR correction is needed, replace rather than add whole sentences where possible, so body length remains similar. Do not change image placement or page count.'
  const response=await callGeminiWithFailover(prompt,keyState,{model:'gemini-3.5-flash-lite',fallbackModels:['gemini-3.1-flash-lite'],schema:simplifyEditorialSchema(buildCEFRReviewRepairSchema(draft)),deadlineMs:Date.now()+150000,requestTimeoutMs:60000})
  const reviewed=applyCEFRReviewRepairs(draft,response.draft,{requiredRepairLevels:[...required],validEvidenceIds:new Set(evidence.map(e=>e.id))})
  const final=validateArticleQuality(reviewed.draft,story.sourceTitle,opts)
  console.log('INDEPENDENT PILOT REVIEW',id,response.model,JSON.stringify({assessment:Object.fromEntries(levels.map(l=>[l,{band:reviewed.finalAssessment?.[l]?.finalBand,verdict:reviewed.finalAssessment?.[l]?.finalVerdict}])),reviewErrors:reviewed.errors,qualityErrors:final.errors}))
  if(!reviewed.ok||!final.ok)throw Error('Independent pilot review rejected '+id+': '+[...reviewed.errors,...final.errors].join(' | '))
  const next=structuredClone(story)
  for(const l of levels){
   const v=reviewed.draft.variants[l]
   next.levelVariants[l].headline=v.headline
   next.levelVariants[l].pages=next.levelVariants[l].pages.map((p,i)=>({...p,text:v.pages[i].text,evidenceIds:v.pages[i].evidenceIds}))
  }
  next.title=next.levelVariants['B1-B2'].headline
  next.pages=structuredClone(next.levelVariants['B1-B2'].pages)
  next.editorialState='Source-grounded ChatGPT adaptation; independently reviewed by Gemini; browser copyfitting required before publication.'
  next.editorialPilotReview={model:response.model,sourceRevisionId:source.sourceRevisionId,bands:Object.fromEntries(levels.map(l=>[l,reviewed.finalAssessment[l].finalBand]))}
  if(!validateWikiStory(next).accepted)throw Error('Catalog rejected reviewed pilot '+id)
  approved.push(next)
 }
 await fs.writeFile(output,JSON.stringify(approved,null,2))
}finally{await meter.close()}
