import fs from 'node:fs/promises'

// Pilot only: reads public Wikipedia API, never changes the app or feed.
const TOPICS = ['Octopus','Aurora','Bioluminescence','Black hole','Volcano','Coral reef','Photosynthesis','Mars','Glacier','Tardigrade']
const MIN_WORDS = 200
const MAX_WORDS = 350
const UA = 'DailyLoreEnglish/3.1 (educational reading prototype; https://github.com/trantienbg2004-rgb/daily-lore-english)'
const words = s => (s.match(/\b[\p{L}\p{N}][\p{L}\p{N}'’-]*\b/gu) || []).length
const normalize = s => s.replace(/\s+/g, ' ').trim()
const sentences = s => (s.match(/[^.!?]+[.!?]+(?:[”"']|$)?|[^.!?]+$/g) || []).map(normalize).filter(s => words(s) >= 4)
const sleep = ms => new Promise(r => setTimeout(r, ms))
async function fetchExtract(topic) {
  const u = new URL('https://en.wikipedia.org/w/api.php')
  for (const [k,v] of Object.entries({action:'query',prop:'extracts|info',explaintext:'1',exsectionformat:'plain',inprop:'url',format:'json',formatversion:'2',redirects:'1',titles:topic})) u.searchParams.set(k,v)
  const res = await fetch(u, {headers:{'User-Agent':UA,'Accept':'application/json'},signal:AbortSignal.timeout(20000)})
  if (!res.ok) throw Error(`HTTP ${res.status}`)
  const json = await res.json()
  const p = json.query?.pages?.[0]
  if (!p || p.missing || !p.extract) throw Error('No article extract returned')
  return {title:p.title,url:p.fullurl || `https://en.wikipedia.org/wiki/${encodeURIComponent(topic.replace(/ /g,'_'))}`,extract:p.extract}
}
function makePages(text) {
  // Select complete introductory sentences only. No fabricated details or AI rewriting.
  const paras = text.split(/\n\s*\n/).map(normalize).filter(x => words(x)>15 && !/^see also|^references|^external links/i.test(x))
  const selected=[]
  for (const para of paras) {
    for (const s of sentences(para)) {
      if (words(selected.join(' ')) + words(s) > MAX_WORDS) break
      selected.push(s)
    }
    if (words(selected.join(' ')) >= MIN_WORDS) break
  }
  const result=[]; let current=[]; let n=0
  for (const s of selected) {
    if (n>=60 && result.length<4) { result.push(current.join(' '));current=[];n=0 }
    current.push(s);n+=words(s)
  }
  if(current.length) result.push(current.join(' '))
  return {pages:result.map(text=>({text})),words:words(selected.join(' '))}
}
await fs.mkdir('reports',{recursive:true})
const output=[]
for(const topic of TOPICS){
  try {
    const data=await fetchExtract(topic)
    const content=makePages(data.extract)
    output.push({topic,title:data.title,sourceUrl:data.url,license:'CC BY-SA 4.0; verify source page history and attribution before reuse',sourceWords:words(data.extract),words:content.words,pages:content.pages,status:content.words>=MIN_WORDS && content.pages.length>=3?'candidate':'needs-review'})
    console.log(`${topic}: ${content.words} words, ${content.pages.length} pages`)
  } catch(e) {output.push({topic,status:'fetch-failed',error:e.message});console.warn(`${topic}: ${e.message}`)}
  await sleep(250)
}
await fs.writeFile('reports/wikipedia-pilot.json',JSON.stringify({note:'Pilot only. No publication. Text is unmodified Wikipedia excerpt and needs editorial and licensing review.',generatedAt:new Date().toISOString(),articles:output},null,2)+'\n')
console.log(`Saved reports/wikipedia-pilot.json; candidates: ${output.filter(x=>x.status==='candidate').length}/${TOPICS.length}`)
