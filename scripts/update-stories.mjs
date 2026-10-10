// Free daily story update using Wikipedia's public summary API.
// Run: node scripts/update-stories.mjs
import fs from 'node:fs/promises'
const path = 'public/stories.json'
const library = JSON.parse(await fs.readFile(path, 'utf8'))
const topics = [
  'Aurora','Octopus','Bioluminescence','Coral reef','Hummingbird','Black hole',
  'Northern lights','Honey bee','Volcano','Deep sea','Migration of birds',
  'Rainforest','Solar eclipse','Saturn','Mushroom','Ocean current','Antarctica',
  'Dolphin','Photosynthesis','Mars','Glacier','Butterfly','Tardigrade',
  'Milky Way','Sleep','Memory','Earthquake','Red panda','Mangrove','Comet',
  'Seahorse','Meteor shower','Penguin','Tropical cyclone','Giant panda',
  'Axolotl','Tsunami','Water cycle','Lunar eclipse','Koala','Venus','Cave'
]
const existing = new Set(library.map(x => x.sourceTitle).filter(Boolean))
const splitSentences = text => (text.match(/[^.!?]+[.!?]+(?:[”"']|$)?|[^.!?]+$/g) || []).map(s=>s.trim()).filter(Boolean)
let added = false
for (const title of topics) {
  if (existing.has(title)) continue
  try {
    const url = `https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(title)}`
    const response = await fetch(url, { headers: { 'User-Agent':'DailyLoreEnglish/1.0 (educational personal project; contact: https://github.com/)', Accept:'application/json' }, signal: AbortSignal.timeout(12000) })
    if (!response.ok) continue
    const data = await response.json()
    if (data.type === 'disambiguation' || !data.extract || !data.thumbnail?.source) continue
    const sentences = splitSentences(data.extract)
    if (sentences.length < 3 || data.extract.length < 210) continue
    const groups=[]
    for(let i=0;i<sentences.length;i+=2) groups.push(sentences.slice(i,i+2).join(' '))
    const pages = groups.slice(0,5).map((text,i)=>({image:data.thumbnail.source,caption:`${data.title} · Image from Wikimedia Commons / Wikipedia (see source for attribution)`,text}))
    library.push({category:'DISCOVER · FROM WIKIPEDIA',title:data.title.toUpperCase(),subtitle:data.description || 'A short discovery about our world',sourceTitle:title,sourceUrl:data.content_urls?.desktop?.page || `https://en.wikipedia.org/wiki/${encodeURIComponent(title)}`,pages})
    added=true
    console.log(`Added: ${title}`)
    break
  } catch(e) { console.warn(`Skipped ${title}: ${e.message}`) }
}
if (!added) { console.log('No new story available today.'); process.exit(0) }
await fs.writeFile(path,JSON.stringify(library,null,2)+'\n')
