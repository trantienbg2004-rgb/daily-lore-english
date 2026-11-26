// Research-only CMUdict comparison; never imported into publishing.
import fs from 'node:fs/promises'
import path from 'node:path'
import {readWikiCatalog} from './wiki/catalog.mjs'
import {countSyllables,profileTextCEFR,splitSentences} from './wiki/cefrProfiler.mjs'

const dictFile=process.argv[2]
if(!dictFile)throw Error('Usage: node scripts/cefr-cmudict-audit.mjs CMU_SYLLABLE_COUNTS.json [catalog root]')
const dict=JSON.parse(await fs.readFile(dictFile,'utf8'))
const root=path.resolve(process.argv[3]||'.')
const {stories}=await readWikiCatalog(root)
if(!stories.length)throw Error('Empty catalog; cannot audit')
const levels=['A1-A2','B1-B2','C1-C2']
const fk=(w,s,y)=>Number(Math.max(0,0.39*w/s+11.8*y/w-15.59).toFixed(2))
const rows=[]
for(const story of stories)for(const level of levels){
 const text=story.levelVariants[level].pages.map(p=>String(p.text||'').trim()).filter(Boolean).join(' ')
 const old=profileTextCEFR(text,{targetLevel:level,sourceTitle:story.sourceTitle})
 const sentences=splitSentences(text)
 const words=sentences.flatMap(s=>s.match(/[A-Za-z0-9]+(?:['’-][A-Za-z0-9]+)*/g)||[])
 let matched=0,legacy=0,low=0,high=0
 for(const raw of words){
  const w=raw.toLowerCase().replace(/’/g,"'")
  const n=/[a-z]/.test(w)?countSyllables(w):1
  legacy+=n
  let variants=Object.hasOwn(dict,w)?dict[w]:null
  if(!variants&&w.includes('-')){
   const parts=w.split('-').map(p=>Object.hasOwn(dict,p)?dict[p]:null)
   if(parts.every(Boolean))variants=[parts.reduce((s,p)=>s+Math.min(...p),0),parts.reduce((s,p)=>s+Math.max(...p),0)]
  }
  if(Array.isArray(variants)&&variants.length&&variants.every(x=>Number.isInteger(x)&&x>0)){
   matched++;low+=Math.min(...variants);high+=Math.max(...variants)
  }else{low+=n;high+=n}
 }
 if(words.length!==old.wordCount||legacy!==old.syllableCount||sentences.length!==old.sentenceCount||
 fk(words.length,sentences.length,legacy)!==old.fkgl)throw Error('Legacy metric parity failed: '+story.sourceTitle+' '+level)
 rows.push({title:story.sourceTitle,level,words:words.length,legacyFkgl:old.fkgl,cmuLow:fk(words.length,sentences.length,low),cmuHigh:fk(words.length,sentences.length,high),coverage:matched/words.length})
}
const mean=a=>a.reduce((s,v)=>s+v,0)/a.length
const summary=levels.map(level=>{
 const list=rows.filter(r=>r.level===level),cap=level==='A1-A2'?6.8:level==='B1-B2'?10.8:null
 return {level,n:list.length,meanCoverage:mean(list.map(r=>r.coverage)),meanLegacy:mean(list.map(r=>r.legacyFkgl)),
 meanCMULow:mean(list.map(r=>r.cmuLow)),meanCMUHigh:mean(list.map(r=>r.cmuHigh)),
 outsideCMURange:list.filter(r=>r.legacyFkgl<r.cmuLow||r.legacyFkgl>r.cmuHigh).length,
 maxDistanceToRange:Math.max(...list.map(r=>Math.max(0,r.cmuLow-r.legacyFkgl,r.legacyFkgl-r.cmuHigh))),
 legacyAboveCap:cap===null?null:list.filter(r=>r.legacyFkgl>cap).length,
 cmuDefinitelyAboveCap:cap===null?null:list.filter(r=>r.cmuLow>cap).length,
 cmuPossiblyAboveCap:cap===null?null:list.filter(r=>r.cmuHigh>cap).length}
})
const report={stories:stories.length,variants:rows.length,summary,rows,limitations:'Same legacy sentence and token rules; unknown pronunciations use legacy estimate. CMUdict ranges are pronunciation bounds, not a CEFR diagnosis. No failed pilot drafts available.'}
await fs.writeFile('cefr-cmudict-report.json',JSON.stringify(report,null,2)+'\n')
console.log(JSON.stringify({stories:report.stories,variants:report.variants,summary},null,2))
