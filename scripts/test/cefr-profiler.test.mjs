import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {
 countSyllables,
 evaluateArticleCEFR,
 loadCEFRWordlist,
 profileTextCEFR
} from '../wiki/cefrProfiler.mjs'
import {
 applyCEFRReviewRepairs,
 buildCEFRReviewRepairPrompt,
 buildCEFRReviewRepairSchema,
 buildQualityRetryPrompt,
 buildRoundRobinOrder,
 validateArticleQuality
} from '../publish_wiki_batch.mjs'
import {applyCEFRRequeue,auditStoriesCEFR} from '../audit_wiki_cefr.mjs'
import {makeWikiStory,rewriteWikiCatalog} from '../wiki/catalog.mjs'

test('data/cefr_wordlist.json is compact (120-250 KB) with 8,000-12,000 lemmas across A1-C2',async()=>{
 const wordlist=loadCEFRWordlist()
 const keys=Object.keys(wordlist)
 assert.ok(keys.length>=8000&&keys.length<=12000,`Expected 8,000-12,000 lemmas, got ${keys.length}`)
 const stat=await fs.stat(path.resolve('data/cefr_wordlist.json'))
 assert.ok(stat.size>=100_000&&stat.size<=260_000,`Expected compact wordlist file (~120-250KB), got ${stat.size} bytes`)
 assert.equal(wordlist.water,'A1')
 assert.equal(wordlist.modern,'A2')
 assert.equal(wordlist.economy,'B1')
})

test('profileTextCEFR excludes proper nouns and numbers while flagging over-level words like antimicrobial and promulgated in A1-A2',()=>{
 assert.equal(countSyllables('people'),2)
 assert.equal(countSyllables('science'),2)
 assert.equal(countSyllables('antimicrobial'),6)

 const cleanA1=`Long ago, people in Warsaw and Poland loved the short poems of Pushkin. In 1848, young students read his books at home and shared stories with friends. Every cold night, families sat by the warm fire and talked about life in the city.`
 const cleanProfile=profileTextCEFR(cleanA1,{targetLevel:'A1-A2',sourceTitle:'Alexander Pushkin'})
 assert.ok(cleanProfile.fkgl<=6.8,`Expected A1 FKGL <= 6.8, got ${cleanProfile.fkgl}`)
 assert.ok(cleanProfile.lexicalProfile.a1a2Pct>=78,`Expected A1-A2 >= 78%, got ${cleanProfile.lexicalProfile.a1a2Pct}%`)
 assert.equal(cleanProfile.lexicalProfile.c1c2OrUnlistedPct,0)
 assert.deepEqual(cleanProfile.overLevelWords,[])
 assert.ok(cleanProfile.excludedProperNouns.includes('Warsaw'))
 assert.ok(cleanProfile.excludedProperNouns.includes('Poland'))
 assert.ok(cleanProfile.excludedProperNouns.includes('Pushkin'))

 // Leaked C1-C2 / unlisted jargon into A1-A2 MUST be flagged in overLevelWords
 const pollutedA1=`Doctors in Warsaw studied antimicrobial medicine that officials promulgated during socioeconomic reform in 1920s Poland. Families still needed clean water and safe food.`
 const pollutedProfile=profileTextCEFR(pollutedA1,{targetLevel:'A1-A2',sourceTitle:'Public Health'})
 assert.ok(pollutedProfile.overLevelWords.includes('antimicrobial'))
 assert.ok(pollutedProfile.overLevelWords.includes('promulgated'))
 assert.ok(pollutedProfile.overLevelWords.includes('socioeconomic'))
 assert.ok(!pollutedProfile.overLevelWords.includes('warsaw'))
 assert.ok(!pollutedProfile.overLevelWords.includes('poland'))
 assert.ok(!pollutedProfile.overLevelWords.includes('1920s'))
 assert.ok(pollutedProfile.lexicalProfile.c1c2OrUnlistedPct>7)
})

test('validateArticleQuality keeps profiler cutoffs advisory and retry prompt shows contextual diagnostics',()=>{
 const a1BadPages=[
  {text:`Long ago, people in Warsaw studied antimicrobial compounds that leaders promulgated for socioeconomic transformation. Early teams used contemporaneous methodologies and wrote multifaceted paradigms. Soon, many young learners wanted to understand this heterogeneous institutional framework.`,imageId:'IMG_0',evidenceIds:['P1']},
  {text:`In the first years, small teams evaluated bureaucratic protocols while officials promulgated antimicrobial rules and heterogeneous statutes. They kept meticulous archival records in plain notebooks. Each empirical experiment demonstrated one salient methodological insight for subsequent practitioners.`,imageId:null,evidenceIds:['P1']},
  {text:`Later, small teams scrutinized socioeconomic reform and epistemological debates across nearby municipalities. Advanced instrumentation accelerated analytical scrutiny and administrative accountability. Young scholars reviewed dense monographs about constitutional governance and regulatory compliance.`,imageId:null,evidenceIds:['P1']},
  {text:`Today, this multifaceted historiography still shapes how contemporaneous institutions formulate bureaucratic policy. Analytical scrutiny can yield substantive transformation when administrators disseminate empirical documentation openly across disparate jurisdictions.`,imageId:null,evidenceIds:['P1']}
 ]
 const b1Pages=[
  {text:`Long before modern teams studied local towns, early thinkers saw clear patterns in how people lived. Their notes soon spread through letters, books, and public talks. What began as a small question slowly grew into a strong movement that changed how citizens viewed daily work.`,imageId:'IMG_0',evidenceIds:['P1']},
  {text:`During its early years, careful teams compared written records from several regions while testing better ways to work. They wrote down clear wins and hard setbacks in plain reports that everyday readers could follow. Those honest notes helped younger builders learn from proven facts instead of making costly old mistakes again. Across workshops and libraries, close study slowly replaced guesswork with steady standards.`,imageId:null,evidenceIds:['P1']},
  {text:`Still, fast change rarely came without tension, because different groups often argued about rules, fairness, and long-term costs. Careful critics warned leaders not to move faster than real field tests could support. Strong backers answered that smart reform could finally solve tough daily problems that older systems had ignored for years. Settling those debates took patient talks among writers and watchful citizens.`,imageId:null,evidenceIds:['P1']},
  {text:`Looking back across decades of steady trial and careful change, the lasting story shows how shared public study slowly builds stronger human knowledge. Even as modern tools and social goals shift quickly, checking bold claims against clear written records remains vital for wise choices. Curious readers and trained workers still draw real guidance from this rich record whenever new tests challenge old habits.`,imageId:null,evidenceIds:['P1']}
 ]
 const c1Pages=[
  {text:`Long before contemporary scholarship systematically categorized regional institutions, observant practitioners recognized subtle historical anomalies that quietly undermined conventional assumptions across established intellectual traditions. Over subsequent decades, those recurring methodological questions catalyzed an enduring re-evaluation of both formal theoretical frameworks and everyday institutional practice across diverse territories.`,imageId:'IMG_0',evidenceIds:['P1']},
  {text:`Throughout its foundational period, methodical investigators synthesized comparative archival documentation from disparate regions while rigorously interrogating prevailing frameworks through sustained empirical scrutiny. By publishing transparent analytical records detailing both structural breakthroughs and persistent methodological uncertainties, they established durable intellectual benchmarks that enabled subsequent scholars to distinguish verifiable causal mechanisms from speculative consensus. Within emerging scholarly networks, disciplined peer verification gradually transformed scattered regional observations into coherent comparative historical knowledge.`,imageId:null,evidenceIds:['P1']},
  {text:`Nevertheless, rapid institutional transformation invariably generated substantive intellectual tension whenever competing constituencies negotiated unfamiliar standards of public accountability, long-term civic governance, and rigorous evidentiary transparency. While cautious observers insisted that comprehensive empirical verification must necessarily precede sweeping structural reform, persistent advocates countered that delaying essential modernization carried equally severe economic and administrative consequences. Resolving those competing imperatives demanded sustained public deliberation across legislative forums and independent research committees.`,imageId:null,evidenceIds:['P1']},
  {text:`Viewed within a broader comparative historical perspective, this enduring trajectory vividly illustrates how cumulative critical inquiry continually renegotiates the boundaries between established institutional orthodoxy and empirical scientific discovery. Rather than settling into a static historical footnote, the subject still provides contemporary analysts an indispensable conceptual framework for evaluating complex social adaptation under uncertainty. Ultimately, its relevance underscores why transparent archival documentation and methodological humility remain vital during transformative historical change.`,imageId:null,evidenceIds:['P1']}
 ]

 const draft={
  variants:{
   'A1-A2':{headline:'How Simple Plans Changed Daily Town Life',pages:a1BadPages,glossary:[]},
   'B1-B2':{headline:'Inside the Steady Growth of Modern Public Standards',pages:b1Pages,glossary:[]},
   'C1-C2':{headline:'Why Comparative Institutional Reform Still Shapes Modern Governance',pages:c1Pages,glossary:[]}
  }
 }

 const quality=validateArticleQuality(draft,'Public Health')
 assert.equal(quality.ok,true,'FKGL and wordlist cutoffs are diagnostics, not a standalone CEFR verdict')
 assert.equal(quality.cefr.ok,false,'The internal profiler should still expose its heuristic warning')
 assert.ok(quality.metrics.cefrHeuristicWarnings.length>0)
 assert.ok(quality.cefr.profiles['A1-A2'].overLevelWords.includes('antimicrobial'))
 assert.ok(quality.cefr.profiles['A1-A2'].overLevelWords.includes('promulgated'))
 assert.ok(quality.cefr.profiles['A1-A2'].overLevelWords.includes('socioeconomic'))

 const retryPrompt=buildQualityRetryPrompt(
  {sourceTitle:'Public Health'},
  'Health',
  [{id:'P1',sectionIndex:0,heading:'Lead',text:'Public health reforms improved water safety across European cities.'}],
  draft,
  quality.errors,
  [{imageId:'IMG_0',sectionIndex:0,sectionHeading:'Lead',fileTitle:'File:Health.jpg',caption:'Health clinic'}],
  quality
 )
 assert.match(retryPrompt,/ADVISORY CEFR SCREENING SIGNALS/i)
 assert.match(retryPrompt,/antimicrobial/i)
 assert.match(retryPrompt,/promulgated/i)
 assert.match(retryPrompt,/socioeconomic/i)
 assert.match(retryPrompt,/NOT A PASS\/FAIL STANDARD/i)
 assert.doesNotMatch(retryPrompt,/MANDATORY A1-A2 WORD SWAPS/i)
})

test('CEFR descriptor reviewer accepts in-band assessments, merges partial repairs and attaches an auditable excerpt',()=>{
 const dims={vocabulary:'fit',syntax:'fit',cohesion:'fit',abstraction:'fit',inference:'fit',terms:'fit'}
 const assessment=(band,quote,initialBand=band,initialVerdict='pass')=>({
  initialBand,initialVerdict,finalBand:band,finalVerdict:'pass',
  initialDimensions:{...dims},finalDimensions:{...dims},evidence:[quote],rationale:'The text matches the target reading descriptor.'
 })
 const draft={variants:{
  'A1-A2':{headline:'A Simple Story About Town Life',pages:[{text:'People built a small town near the river. Families shared food and tools.',imageId:'IMG_0',evidenceIds:['P1']}]},
  'B1-B2':{headline:'How the Town Developed Over Time',pages:[{text:'Local builders compared plans and improved the town over several years.',imageId:'IMG_0',evidenceIds:['P1']}]},
  'C1-C2':{headline:'The Town and Its Lasting Civic Influence',pages:[{text:'The settlement gradually evolved into a regional centre whose institutions shaped later civic arrangements.',imageId:'IMG_0',evidenceIds:['P1']}]}
 }}
 const passPayload={assessment:{
  'A1-A2':assessment('A2','People built a small town'),
  'B1-B2':assessment('B1','Local builders compared plans'),
  'C1-C2':assessment('C1','The settlement gradually evolved')
 },repairs:[]}
 const pass=applyCEFRReviewRepairs(draft,passPayload)
 assert.equal(pass.ok,true,pass.errors.join(' | '))

 const needsRepair=structuredClone(passPayload)
 needsRepair.assessment['B1-B2']=assessment('B1','Builders changed the town','C1','revise')
 needsRepair.repairs=[{level:'B1-B2',headline:'How Builders Changed the Town',pages:[{pageIndex:0,text:'Builders changed the town over time. They compared plans and shared useful ideas with nearby places.',evidenceIds:['P1']}]}]
 const repaired=applyCEFRReviewRepairs(draft,needsRepair)
 assert.equal(repaired.ok,true,repaired.errors.join(' | '))
 assert.match(repaired.draft.variants['B1-B2'].pages[0].text,/Builders changed the town/)
 assert.equal(repaired.draft.variants['B1-B2'].pages[0].imageId,'IMG_0','Repair must preserve image binding')

 const twoPageDraft=structuredClone(draft)
 for(const level of ['A1-A2','B1-B2','C1-C2'])twoPageDraft.variants[level].pages.push({text:'The next page explains another part of the story.',imageId:null,evidenceIds:['P1']})
 const partialPayload=structuredClone(passPayload)
 partialPayload.assessment['B1-B2']=assessment('B1','Builders changed the town','C1','revise')
 partialPayload.repairs=[{level:'B1-B2',pages:[{pageIndex:0,text:'Builders changed the town over time. They compared plans and shared useful ideas with nearby places.',evidenceIds:['P1']}]}]
 const partial=applyCEFRReviewRepairs(twoPageDraft,partialPayload)
 assert.equal(partial.ok,true,partial.errors.join(' | '))
 assert.equal(partial.draft.variants['B1-B2'].pages[1].text,'The next page explains another part of the story.','Untouched page must be preserved')

 const dimensionMismatch=structuredClone(passPayload)
 dimensionMismatch.assessment['B1-B2'].initialDimensions.syntax='high'
 dimensionMismatch.repairs=[{level:'B1-B2',pages:[{pageIndex:0,text:'Builders changed the town over time. They compared plans and shared useful ideas with nearby places.',evidenceIds:['P1']}]}]
 const dimensionRepair=applyCEFRReviewRepairs(draft,dimensionMismatch)
 assert.equal(dimensionRepair.ok,true,dimensionRepair.errors.join(' | '))
 assert.match(dimensionRepair.draft.variants['B1-B2'].pages[0].text,/Builders changed the town/)

 const wrongBand=structuredClone(passPayload)
 wrongBand.assessment['C1-C2'].finalBand='B2'
 const rejected=applyCEFRReviewRepairs(draft,wrongBand)
 assert.equal(rejected.ok,false)
 assert.ok(rejected.errors.some(e=>/outside its assigned CEFR group/.test(e)))

 const noModelQuotes=structuredClone(passPayload)
 for(const level of ['A1-A2','B1-B2','C1-C2'])delete noModelQuotes.assessment[level].evidence
 const audited=applyCEFRReviewRepairs(draft,noModelQuotes)
 assert.equal(audited.ok,true,audited.errors.join(' | '))
 assert.equal(audited.finalAssessment['A1-A2'].verbatimExcerpt,'People built a small town near the river.')

})

test('CEFR reviewer prompt uses official reading descriptors and treats FKGL/wordlist as advisory diagnostics',()=>{
 const source={sourceTitle:'Sample Topic',pageId:12,sourceRevisionId:34}
 const evidence=[{id:'P1',sectionIndex:0,heading:'Lead',text:'A factual source passage about the sample topic.'}]
 const draft={factSheet:{coreFacts:[]},outline:[],levelPlans:{},variants:{
  'A1-A2':{headline:'A simple title',pages:[{text:'People use this tool every day.'}]},
  'B1-B2':{headline:'A clear factual title',pages:[{text:'People use this tool for several practical reasons.'}]},
  'C1-C2':{headline:'A nuanced title about the subject',pages:[{text:'The tool illustrates a wider institutional shift in practice.'}]}
 }}
 const quality={ok:true,errors:[],metrics:{cefrHeuristicWarnings:['FKGL outside internal band'],'A1-A2':{fkgl:8,overLevelWords:['technical']}}}
 const prompt=buildCEFRReviewRepairPrompt(source,'General',evidence,draft,quality)
 const repairSchema=buildCEFRReviewRepairSchema(draft)
 assert.equal(repairSchema.properties.repairs.items.properties.pages.minItems,1)
 assert.equal(repairSchema.properties.repairs.items.properties.pages.maxItems,1)
 assert.equal(repairSchema.properties.repairs.items.properties.pages.items.properties.pageIndex.minimum,0)
 assert.equal(repairSchema.properties.repairs.items.properties.pages.items.properties.pageIndex.maximum,0)
 assert.match(prompt,/Council of Europe CEFR Companion Volume/i)
 assert.match(prompt,/six dimensions/i)
 assert.match(prompt,/NOT CEFR DEFINITIONS/i)
 assert.match(prompt,/A1-A2/)
 assert.match(prompt,/finalVerdict/)
 assert.match(prompt,/program will attach a verbatim sentence/)
})

test('applyCEFRRequeue enforces safety floor, prepends removed stories to FRONT of queue without duplicates, and buildRoundRobinOrder prioritizes them first',async()=>{
 const tmpDir=await fs.mkdtemp(path.join(os.tmpdir(),'saga-cefr-requeue-'))
 const dataDir=path.join(tmpDir,'data')
 await fs.mkdir(dataDir,{recursive:true})

 const makeStory=(idx,a1Bad)=>{
  const source={
   pageId:1000+idx,
   sourceTitle:`Sample Topic ${idx}`,
   sourceUrl:`https://en.wikipedia.org/wiki/Sample_Topic_${idx}`,
   sourceRevisionId:5000+idx,
   sourceRevisionUrl:`https://en.wikipedia.org/w/index.php?oldid=${5000+idx}`,
   sourceRetrievedAt:'2026-11-21T00:00:00.000Z'
  }
  const photo={
   pageIndex:0,
   url:`https://upload.wikimedia.org/wikipedia/commons/thumb/a/a1/Topic_${idx}.jpg/960px-Topic_${idx}.jpg`,
   caption:`Historic landmark view ${idx}`,
   provenance:{
    originType:'wikipedia-embedded',
    credit:'Jane Photographer',
    imagePageUrl:`https://commons.wikimedia.org/wiki/File:Topic_${idx}.jpg`,
    sourceImageUrl:source.sourceUrl,
    sourceRevisionUrl:source.sourceRevisionUrl,
    license:'CC BY-SA 4.0',
    licenseUrl:'https://creativecommons.org/licenses/by-sa/4.0/',
    evidence:{
     articleSection:'Lead',
     fileTitle:`File:Topic_${idx}.jpg`,
     sourcePageId:source.pageId,
     sourceRevisionId:source.sourceRevisionId,
     pageIndex:0
    }
   }
  }
  const a1Text=a1Bad
   ?'Antimicrobial socioeconomic methodologies systematically promulgated heterogeneous paradigms across contemporaneous institutional frameworks without simplifying complex terminology.'
   :'Long ago, people built strong stone walls near the river. They shared tools and fresh food each day. Families felt safe in the quiet town.'
  const b1Text='During the early years, local builders compared written notes from nearby towns while testing better ways to build walls. Their clear records helped younger workers avoid costly mistakes and create steady standards.'
  const c1Text='Throughout subsequent institutional transformations, multidisciplinary investigators synthesized comparative archival documentation while systematically interrogating prevailing theoretical frameworks through rigorous empirical scrutiny across disparate jurisdictions.'
  const makeVar=(hl,txt)=>({
   headline:hl,
   pages:[
    {text:txt,image:photo.url,caption:photo.caption,imageProvenance:photo.provenance,evidenceIds:['P1']},
    {text:txt,evidenceIds:['P1']},
    {text:txt,evidenceIds:['P1']},
    {text:txt,evidenceIds:['P1']}
   ]
  })
  return makeWikiStory({
   source,
   topic:'History & Geography',
   draft:{
    variants:{
     'A1-A2':makeVar(`How Topic ${idx} Shaped Daily Life`,a1Text),
     'B1-B2':makeVar(`Inside the Story of Topic ${idx}`,b1Text),
     'C1-C2':makeVar(`Why Topic ${idx} Still Matters Today`,c1Text)
    }
   },
   photos:[photo],
   evidence:[{id:'P1',sectionIndex:0,heading:'Lead',text:'Evidence text.',hash:'a'.repeat(64),excerpt:'Evidence text.'}]
  })
 }

 // 1 passing story + 4 failing stories; safety floor minKeep = 3 -> keep 3, requeue 2
 const stories=[
  makeStory(1,false),
  makeStory(2,true),
  makeStory(3,true),
  makeStory(4,true),
  makeStory(5,true)
 ]
 await rewriteWikiCatalog(tmpDir,stories)

 const queueFile=path.join(dataDir,'wiki_queue.json')
 await fs.writeFile(queueFile,JSON.stringify({
  version:1,
  items:[
   {title:'Existing Queue Item',pageId:9999,topic:'History & Geography',priority:1,hasLeadImage:true,views:50000,status:'pending'},
   {title:'Sample Topic 5',pageId:1005,topic:'History & Geography',priority:1,hasLeadImage:true,views:100,status:'published'}
  ]
 },null,2))

 const auditBefore=auditStoriesCEFR(stories,{minKeep:3})
 assert.equal(auditBefore.totalArticles,5)
 assert.equal(auditBefore.passedCount,1)
 assert.equal(auditBefore.plannedKeptCount,3)
 assert.equal(auditBefore.plannedRequeueCount,2)

 const applied=await applyCEFRRequeue({root:tmpDir,queueFile,minKeep:3})
 assert.equal(applied.applied,true)
 assert.equal(applied.keptCount,3)
 assert.equal(applied.requeuedCount,2)

 const updatedQueue=JSON.parse(await fs.readFile(queueFile,'utf8'))
 // Requeued items must be at the FRONT (indexes 0..1), status='pending', priority=0, zero duplicates
 assert.equal(updatedQueue.items[0].status,'pending')
 assert.equal(updatedQueue.items[0].priority,0)
 assert.equal(updatedQueue.items[1].status,'pending')
 assert.equal(updatedQueue.items[1].priority,0)
 const pageIds=updatedQueue.items.map(i=>i.pageId)
 assert.equal(new Set(pageIds).size,pageIds.length,'Queue must have zero duplicate pageIds')

 // buildRoundRobinOrder must schedule priority=0 requeued articles BEFORE priority=1 existing pending item
 const schedule=buildRoundRobinOrder(updatedQueue.items)
 assert.equal(schedule[0].priority,0)
 assert.equal(schedule[1].priority,0)
 assert.equal(schedule[2].title,'Existing Queue Item')

 await fs.rm(tmpDir,{recursive:true,force:true})
})
