// TEST ONLY. The authored fixture is not independently CEFR-reviewed.
// Never commit or deploy its generated catalog. Exercise actual Reader DOM
// using the two reported source articles and their existing verified images.
import {readWikiCatalog,replaceWikiStory,validateWikiStory} from '../wiki/catalog.mjs'
import {EDITORIAL_PILOT_TEXTS} from './fixtures/editorial-pilot-texts.mjs'
const root=process.cwd()
const catalog=await readWikiCatalog(root)
for(const [id,variants] of Object.entries(EDITORIAL_PILOT_TEXTS)){
 const original=catalog.stories.find(s=>s.sourcePageId===Number(id))
 if(!original)throw Error('Missing offline fixture article '+id)
 const story=structuredClone(original)
 story.readerLayoutVersion=3
 for(const [level,texts] of Object.entries(variants)){
  const old=original.levelVariants[level].pages
  story.levelVariants[level].pages=texts.map((text,i)=>{
   if(Number(id)===79511869){
    const indexes=[[0],[1,2],[3],[4]][i]
    const extra=[[],[],['P8','P13','P14'],['P9','P15','P16']][i]
    return {...old[indexes[0]],text,caption:i===0?'Goat imagery in sports culture':'',evidenceIds:[...new Set([...indexes.flatMap(j=>old[j].evidenceIds),...extra])]}
   }
   return {...old[i],text,caption:['The original Magna Carta','A later depiction of the charter','Engraving of the 1215 charter','',''][i]}
  })
 }
 story.pages=story.levelVariants['B1-B2'].pages.map(p=>({...p}))
 story.editorialState='TEST FIXTURE ONLY — not an independent CEFR assessment'
 const gate=validateWikiStory(story)
 if(!gate.accepted)throw Error('Fixture structure rejected '+gate.errors.join(', '))
 await replaceWikiStory(root,story)
 console.log('OFFLINE FIXTURE',id,Object.fromEntries(Object.entries(story.levelVariants).map(([l,v])=>[l,v.pages.map(p=>({chars:p.text.replace(/\s+/g,' ').length,words:p.text.split(/\s+/).length,photo:!!p.image}))])))
}
