import fs from 'node:fs/promises'

// Runs on Node 22. No API key or npm dependency required.
const FILE = 'public/stories.json'
const MAX_STORIES = 5000
const MAX_NEWS_AGE_HOURS = 48
const UA = 'DailyLoreEnglish/2.0 (personal English reading project; https://github.com/trantienbg2004-rgb/daily-lore-english)'
const topics = ['Aurora','Octopus','Bioluminescence','Coral reef','Hummingbird','Black hole','Honey bee','Volcano','Deep sea','Rainforest','Solar eclipse','Saturn','Mushroom','Ocean current','Antarctica','Dolphin','Photosynthesis','Mars','Glacier','Butterfly','Tardigrade','Milky Way','Sleep','Memory','Earthquake','Red panda','Mangrove','Comet','Seahorse','Meteor shower','Penguin','Tropical cyclone','Giant panda','Axolotl','Tsunami','Water cycle','Lunar eclipse','Koala','Venus','Cave','Platypus','Jellyfish','Earth atmosphere','Quantum mechanics','Ocean','Neutron star','Polar bear','Arctic Ocean','Blue whale','Cuttlefish','Baobab','Telescope','Volcanic lightning','Microbiome','Geothermal energy','Monsoon','Mangrove forest','Coral bleaching','Solar wind']
const feeds = [
  { url:'https://feeds.bbci.co.uk/news/world/rss.xml', category:'WORLD NEWS', source:'BBC News' },
  { url:'https://feeds.bbci.co.uk/news/science_and_environment/rss.xml', category:'SCIENCE NEWS', source:'BBC News' },
  { url:'https://feeds.bbci.co.uk/news/technology/rss.xml', category:'TECH NEWS', source:'BBC News' },
]
const decode = s => String(s || '').replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g,'$1').replace(/<[^>]+>/g,' ').replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos|nbsp);/gi, (_,e) => {
  const named = {amp:'&',lt:'<',gt:'>',quot:'"',apos:"'",nbsp:' '}
  if(e[0]==='#') { const n = e[1]?.toLowerCase()==='x' ? parseInt(e.slice(2),16) : parseInt(e.slice(1),10); return Number.isFinite(n) && n>0 && n<=0x10ffff ? String.fromCodePoint(n) : '' }
  return named[e.toLowerCase()] || ''
}).replace(/\s+/g,' ').trim()
const field = (xml,tag) => decode(xml.match(new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${tag}>`,'i'))?.[1] || '')
const get = async url => {
  const r = await fetch(url,{headers:{'User-Agent':UA,Accept:'application/rss+xml, application/json, text/xml, */*'},signal:AbortSignal.timeout(12000)})
  if(!r.ok) throw Error(`HTTP ${r.status}`)
  return r
}
const library = JSON.parse(await fs.readFile(FILE,'utf8'))
if (!Array.isArray(library) || !library.length) throw Error('Invalid story library; refusing to overwrite')
const existingUrls = new Set(library.map(x => x.sourceUrl).filter(Boolean))
const existingTopics = new Set(library.map(x => x.sourceTitle).filter(Boolean))
let count = 0

// News: short attributed previews, not fabricated articles or copied full reports.
for (const feed of (process.argv.includes('--publish-only') ? [] : feeds)) {
  try {
    const xml = await (await get(feed.url)).text()
    const items = [...xml.matchAll(/<item(?:\s[^>]*)?>([\s\S]*?)<\/item>/gi)].map(m=>m[1])
    let addedFromFeed=0
    for (const item of items) {
      if (addedFromFeed>=1) break
      const title = field(item,'title'), link = field(item,'link'), desc = field(item,'description')
      const date = Date.parse(field(item,'pubDate'))
      const image = item.match(/<media:thumbnail\b[^>]*\burl=["']([^"']+)["']/i)?.[1] || item.match(/<media:content\b[^>]*\burl=["']([^"']+)["'][^>]*\bmedium=["']image["']/i)?.[1]
      if (!title || !/^https:\/\//i.test(link) || existingUrls.has(link) || !desc || !image || !/^https:\/\//i.test(image)) continue
      if (!Number.isFinite(date) || date>Date.now()+3600000 || Date.now()-date>MAX_NEWS_AGE_HOURS*3600000) continue
      // Keep previews brief and visibly sourced. Original reporting remains at the link.
      const preview = desc.split(/\s+/).slice(0,28).join(' ').replace(/[\s,;:]+$/,'')
      if (preview.length<45) continue
      library.unshift({ category:feed.category, title:title.toUpperCase(), subtitle:`${feed.source} · ${new Date(date).toLocaleDateString('en-GB',{day:'numeric',month:'short',year:'numeric',timeZone:'UTC'})}`,
        sourceTitle:title, sourceUrl:link, publishedAt:new Date(date).toISOString(), contentType:'news',
        pages:[{image,caption:`News image · ${feed.source} (see original article for image credits)`,text:`${preview}${/[.!?]$/.test(preview)?'':'.'} This is a short news preview from ${feed.source}. Open the original source for the full report.`}] })
      existingUrls.add(link);count++;addedFromFeed++
      console.log(`News: ${title}`)
    }
  } catch(e) { console.warn(`${feed.source} feed skipped: ${e.message}`) }
}

// Knowledge: one evergreen discovery per run, from Wikipedia summary.
for (const topic of (process.argv.includes('--publish-only') ? [] : topics)) {
  if (existingTopics.has(topic)) continue
  try {
    const data = await (await get(`https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(topic)}`)).json()
    if(data.type==='disambiguation' || !data.extract || !data.thumbnail?.source || data.extract.length<210) continue
    const sentences = (data.extract.match(/[^.!?]+[.!?]+(?:[”"']|$)?|[^.!?]+$/g)||[]).map(x=>x.trim()).filter(Boolean)
    if(sentences.length<3) continue
    const pages=[]
    for(let i=0;i<sentences.length && pages.length<5;i+=2) pages.push({image:data.thumbnail.source,caption:`${data.title} · Wikipedia / Wikimedia Commons (see source for attribution)`,text:sentences.slice(i,i+2).join(' ')})
    library.push({category:'DISCOVER · FROM WIKIPEDIA',title:data.title.toUpperCase(),subtitle:data.description||'A short discovery about our world',sourceTitle:topic,sourceUrl:data.content_urls?.desktop?.page||`https://en.wikipedia.org/wiki/${encodeURIComponent(topic)}`,contentType:'knowledge',pages})
    count++;console.log(`Knowledge: ${topic}`);break
  } catch(e) { console.warn(`Wikipedia topic skipped (${topic}): ${e.message}`) }
}

if(count) {
  await fs.writeFile(FILE,JSON.stringify(library,null,2)+'\n')
}
console.log(`${count} new stories; total ${Math.min(library.length,MAX_STORIES)}`)

// Publish newest-first paginated chunks; never silently drop old articles.
// Each file is small enough to load on older phones.
const latest = count ? library : JSON.parse(await fs.readFile(FILE,'utf8'))
const ordered = [...latest].reverse()
const CHUNK_SIZE = 12
await fs.mkdir('public/feed',{recursive:true})
const chunks = Math.ceil(ordered.length / CHUNK_SIZE)
for(let i=0;i<chunks;i++) {
  await fs.writeFile(`public/feed/${String(i).padStart(4,'0')}.json`,JSON.stringify(ordered.slice(i*CHUNK_SIZE,(i+1)*CHUNK_SIZE)))
}
await fs.writeFile('public/feed/manifest.json',JSON.stringify({version:1,chunks,total:ordered.length,updatedAt:new Date().toISOString()}))
console.log(`Published ${chunks} feed chunks for ${ordered.length} stories`)
