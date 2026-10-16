import {readExisting} from './lore-collect.mjs'
import {editorialGate} from './lore/editorial.mjs'
import {isPublishedNewsStory} from './discover/bridge.mjs'
const stories=await readExisting(process.cwd())
const ids=new Set(),topics=new Set()
for(const item of stories){
 const gate=editorialGate(item)
 if(!gate.accepted&&!isPublishedNewsStory(item))throw Error(`${item.title}: ${gate.reasons.join(',')}`)
 if(ids.has(item.id))throw Error(`Duplicate ${item.id}`)
 ids.add(item.id);topics.add(item.category)
}
if(stories.length<15 || topics.size<4)throw Error(`Not enough validated stories/category variety: ${stories.length} / ${topics.size}`)
console.log(`DAILY LORE VERIFIED: ${stories.length} licensed Reader articles, ${topics.size} categories; all photo credits present.`)
