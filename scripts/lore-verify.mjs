import {readExisting} from './lore-collect.mjs'
import {editorialGate} from './lore/editorial.mjs'
const stories=await readExisting(process.cwd())
const ids=new Set(),topics=new Set()
for(const item of stories){
 const gate=editorialGate(item)
 if(!gate.accepted)throw Error(`${item.title}: ${gate.reasons.join(',')}`)
 if(ids.has(item.id))throw Error(`Duplicate ${item.id}`)
 ids.add(item.id);topics.add(item.category)
}
if(stories.length<15 || topics.size<4)throw Error(`Not enough validated stories/category variety: ${stories.length} / ${topics.size}`)
console.log(`DAILY LORE VERIFIED: ${stories.length} authentic encyclopedia stories, ${topics.size} categories; all photo credits present.`)
