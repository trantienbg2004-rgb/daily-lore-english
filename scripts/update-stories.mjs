import fs from 'node:fs/promises'

// Daily Lore English: full-text Wikipedia reader; no AI key, no paid service.
// Existing story records and their IDs are preserved for reading history.
const FILE = 'public/stories.json'
const DIR = 'public/feed'
const PER_RUN = 30
const CHUNK_SIZE = 12
const UA = 'DailyLoreEnglish/4.0 (educational reading; https://github.com/trantienbg2004-rgb/daily-lore-english)'
const PUBLISH_ONLY = process.argv.includes('--publish-only')
// No topic restrictions: use diverse categories and random encyclopedia articles.
const DISCOVERY_FILE = 'public/feed/discovery-state.json'
const categories = [
  {name:'History',category:'Category:World history'},
  {name:'Politics',category:'Category:Political concepts'},
  {name:'Philosophy',category:'Category:Philosophical concepts'},
  {name:'Science',category:'Category:Natural sciences'},
  {name:'Geography',category:'Category:Geography'},
  {name:'Technology',category:'Category:Technology'},
  {name:'Medicine',category:'Category:Medicine'},
  {name:'Art',category:'Category:Visual arts'},
  {name:'Music',category:'Category:Music'},
  {name:'Literature',category:'Category:Literature'},
  {name:'Sports',category:'Category:Sports'},
  {name:'Film',category:'Category:Cinema'},
  {name:'Food',category:'Category:Food and drink'},
  {name:'Economics',category:'Category:Economics'},
  {name:'Nature',category:'Category:Biology'},
  {name:'Mathematics',category:'Category:Mathematics'},
  {name:'Education',category:'Category:Education'},
  {name:'Psychology',category:'Category:Psychology'},
  {name:'Architecture',category:'Category:Architecture'},
  {name:'Business',category:'Category:Business'},
  {name:'Environment',category:'Category:Environment'},
  {name:'Culture',category:'Category:Culture'},
]
const MAX_CANDIDATES = 130
const valid = s => s && typeof s.title === 'string' && Array.isArray(s.pages) && s.pages.length > 0 && s.pages.every(p => typeof p.text === 'string' && typeof p.image === 'string')
const id = s => s.sourceUrl || s.sourceTitle || `${s.category}:${s.title}`
const countWords = s => (s.match(/\b[\p{L}\p{N}]+(?:['’\-][\p{L}\p{N}]+)*\b/gu) || []).length
const sentenceSegmenter = new Intl.Segmenter('en', { granularity: 'sentence' })
const sentences = text => [...sentenceSegmenter.segment(text)].map(x => x.segment.trim()).filter(Boolean)
const normalize = text => String(text || '').replace(/\[[0-9]+\]/g, '').replace(/\s+/g, ' ').trim()
const cleanParagraphs = extract => String(extract || '').split(/\n\s*\n|\n/)
  .map(normalize)
  .filter(p => countWords(p) >= 18 && !/^(see also|references|external links|notes|further reading|bibliography)\b/i.test(p))

function buildPages(extract, image, caption) {
  const paragraphs = cleanParagraphs(extract)
  const pieces = []
  for (const paragraph of paragraphs) {
    if (pieces.reduce((n, p) => n + countWords(p), 0) >= 800) break
    for (const sentence of sentences(paragraph)) {
      // The plain-text Wikipedia API occasionally exposes broken IPA/parentheses.
      if (/^[\s:;,.)\]]/.test(sentence) || /[([]\s*$/.test(sentence)) continue
      if (countWords(sentence) < 5) continue
      pieces.push(sentence)
      if (pieces.reduce((n, p) => n + countWords(p), 0) >= 800) break
    }
  }
  const pages = []
  let current = []
  let currentWords = 0
  for (const sentence of pieces) {
    const n = countWords(sentence)
    if (currentWords + n > 115 && currentWords >= 45) {
      pages.push({ image, caption, text: current.join(' ') })
      current = []
      currentWords = 0
    }
    current.push(sentence)
    currentWords += n
  }
  if (current.length) {
    if (pages.length && currentWords < 35) pages[pages.length - 1].text += ' ' + current.join(' ')
    else pages.push({ image, caption, text: current.join(' ') })
  }
  // Reject broken/short extracts; do not publish RSS-length filler.
  if (pages.length < 3 || pages.reduce((n, p) => n + countWords(p.text), 0) < 240) return []
  return pages
}
async function fetchJson(url) {
  const response = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'application/json' }, signal: AbortSignal.timeout(20000) })
  if (!response.ok) throw Error(`HTTP ${response.status}`)
  return response.json()
}
// Wikipedia image gallery: use images embedded in the original article, not random search.
// Images are only attached when Wikimedia metadata provides an open licence.
async function getArticleImages(title, leadImage, leadCaption) {
  const result = [{ image: leadImage, caption: leadCaption }]
  try {
    const u = new URL('https://en.wikipedia.org/w/api.php')
    Object.entries({action:'parse',page:title,prop:'images',format:'json'}).forEach(([k,v])=>u.searchParams.set(k,v))
    const parsed = await fetchJson(u)
    const names = (parsed.parse?.images || []).filter(name =>
      /\.(jpg|jpeg|png|webp)$/i.test(name) && !/\b(icon|logo|flag|map locator|symbol|coat of arms|wikimedia|commons|question mark|edit|button)\b/i.test(name)
    ).slice(0, 22)
    if (!names.length) return result
    const info = new URL('https://en.wikipedia.org/w/api.php')
    Object.entries({action:'query',prop:'imageinfo',iiprop:'url|size|extmetadata',iiurlwidth:'1100',titles:names.map(n=>'File:'+n).join('|'),format:'json',formatversion:'2'}).forEach(([k,v])=>info.searchParams.set(k,v))
    const data = await fetchJson(info)
    for (const file of data.query?.pages || []) {
      const image = file.imageinfo?.[0]
      const meta = image?.extmetadata || {}
      const license = String(meta.LicenseShortName?.value || '')
      const url = image?.thumburl || image?.url
      if (!url?.startsWith('https://') || image.width < 650 || image.height < 300) continue
      if (!/CC BY|CC0|Public domain|PD-/i.test(license)) continue
      if (url === leadImage || result.some(x=>x.image === url)) continue
      result.push({image:url,caption:`${file.title.replace(/^File:/,'')} · Wikimedia Commons · ${license} · See source for credits`})
      if (result.length >= 4) break
    }
  } catch (error) { console.warn(`Extra article images unavailable (${title}): ${error.message}`) }
  return result
}

async function getArticle(topic) {
  const u = new URL('https://en.wikipedia.org/w/api.php')
  Object.entries({ action: 'query', prop: 'extracts|pageimages|info', exintro: '0', explaintext: '1', exsectionformat: 'plain', piprop: 'original|thumbnail', pithumbsize: '1200', inprop: 'url', redirects: '1', format: 'json', formatversion: '2', titles: topic }).forEach(([k, v]) => u.searchParams.set(k, v))
  const data = await fetchJson(u)
  const p = data.query?.pages?.[0]
  if (!p || p.missing || !p.extract) throw Error('No article text')
  const image = p.original?.source || p.thumbnail?.source
  if (!image || !/^https:\/\//.test(image)) throw Error('No article image')
  const url = p.fullurl || `https://en.wikipedia.org/wiki/${encodeURIComponent(p.title.replace(/ /g, '_'))}`
  const caption = `Wikipedia / Wikimedia Commons · Attribution and image licensing: see original source`
  const pages = buildPages(p.extract, image, caption)
  // Source images are spread across sections; no invented or unrelated photographs.
  const gallery = await getArticleImages(p.title, image, caption)
  if (gallery.length > 1) {
    for (let i = 0; i < pages.length; i++) {
      const choice = gallery[Math.min(gallery.length - 1, Math.floor(i * gallery.length / pages.length))]
      pages[i].image = choice.image
      pages[i].caption = choice.caption
    }
  }
  if (!pages.length) throw Error('Insufficient clean text')
  return { category: 'DISCOVER · WIKIPEDIA', title: p.title.toUpperCase(), subtitle: 'Read the full story · Wikipedia', sourceTitle: topic, sourceUrl: url, contentType: 'knowledge', license: 'CC BY-SA 4.0 (verify source page and media license)', attribution: `Wikipedia contributors, “${p.title}”, ${url}`, pages }
}

async function discoverCategory(category, cursor) {
  const u = new URL('https://en.wikipedia.org/w/api.php')
  Object.entries({action:'query',list:'categorymembers',cmtitle:category,cmtype:'page',cmnamespace:'0',cmlimit:'100',format:'json'}).forEach(([k,v])=>u.searchParams.set(k,v))
  if (cursor) u.searchParams.set('cmcontinue',cursor)
  const result = await fetchJson(u)
  return {titles:(result.query?.categorymembers||[]).map(x=>x.title),next:result.continue?.cmcontinue||null}
}
async function discoverRecent() {
  const u = new URL('https://en.wikipedia.org/w/api.php')
  Object.entries({action:'query',list:'recentchanges',rctype:'new',rcnamespace:'0',rclimit:'50',rcprop:'title',format:'json'}).forEach(([k,v])=>u.searchParams.set(k,v))
  const result = await fetchJson(u)
  return (result.query?.recentchanges||[]).map(x=>x.title)
}
async function discoverRandom() {
  const u = new URL('https://en.wikipedia.org/w/api.php')
  Object.entries({action:'query',list:'random',rnnamespace:'0',rnlimit:'50',format:'json'}).forEach(([k,v])=>u.searchParams.set(k,v))
  const result = await fetchJson(u)
  return (result.query?.random || []).map(x=>x.title)
}
function normalizedTitle(value) { return String(value||'').replace(/_/g,' ').trim().toLowerCase() }
const skipTitle = title => !title || /^(list of|outline of|index of|timeline of|glossary of|bibliography of|portal:)/i.test(title) || /\(disambiguation\)$/i.test(title)
const raw = JSON.parse(await fs.readFile(FILE, 'utf8'))
if (!Array.isArray(raw) || !raw.length || !raw.every(valid)) throw Error('Invalid existing library; refusing to overwrite')
const map = new Map()
for (const s of raw) if (!map.has(id(s))) map.set(id(s), s)
const library = [...map.values()]
const urls = new Set(library.map(s => s.sourceUrl).filter(Boolean))
const titles = new Set(library.flatMap(s => [s.sourceTitle, s.title, s.sourceUrl?.split('/wiki/')[1] ? decodeURIComponent(s.sourceUrl.split('/wiki/')[1]) : ''].filter(Boolean).map(normalizedTitle)))
let added = 0
let attempted = 0
let state = {round:0,cursors:{}}
try { state = {...state,...JSON.parse(await fs.readFile(DISCOVERY_FILE,'utf8'))} } catch {}
if (!state.cursors || typeof state.cursors !== 'object') state.cursors = {}
if (!PUBLISH_ONLY) {
  const randomCandidates = []
  const categoryCandidates = []
  const recentCandidates = []
  // Random pages span all topics, not just the selected category list.
  try { randomCandidates.push(...(await discoverRandom()).filter(t=>!skipTitle(t)).map(title=>({title,category:'All topics'}))) }
  catch(e) { console.warn(`Random discovery unavailable: ${e.message}`) }
  const start = state.round % categories.length
  const order = [...categories.slice(start),...categories.slice(0,start)]
  for (const group of order) {
    try {
      let page = await discoverCategory(group.category,state.cursors[group.category])
      if (!page.titles.length && state.cursors[group.category]) page = await discoverCategory(group.category,null)
      state.cursors[group.category] = page.next
      categoryCandidates.push(...page.titles.filter(t=>!skipTitle(t)).slice(0,7).map(title=>({title,category:group.name})))
    } catch(e) { console.warn(`Discovery unavailable (${group.category}): ${e.message}`) }
  }
  try { recentCandidates.push(...(await discoverRecent()).filter(t=>!skipTitle(t)).slice(0,40).map(title=>({title,category:'New on Wikipedia'}))) }
  catch(e) { console.warn(`Recent pages unavailable: ${e.message}`) }
  state.round = (state.round + 1) % categories.length
  // Mix the three discovery streams fairly, so all subjects have a chance.
  const candidates = []
  const pools = [randomCandidates, categoryCandidates, recentCandidates]
  while (pools.some(p => p.length) && candidates.length < 240) {
    for (const pool of pools) if (pool.length) candidates.push(pool.shift())
  }
  const uniqueCandidates = [...new Map(candidates.map(x=>[normalizedTitle(x.title),x])).values()]
  // Interleave sources to keep subject variety; do not publish pages with poor text or no image.
  for (const candidate of uniqueCandidates) {
    if (added >= PER_RUN || attempted >= MAX_CANDIDATES) break
    if (titles.has(normalizedTitle(candidate.title))) continue
    attempted++
    try {
      const story = await getArticle(candidate.title)
      if (urls.has(story.sourceUrl) || titles.has(normalizedTitle(story.title))) continue
      story.sourceTitle = story.title.replace(/_/g,' ')
      story.category = `DISCOVER · ${candidate.category.toUpperCase()}`
      library.unshift(story)
      urls.add(story.sourceUrl)
      titles.add(normalizedTitle(story.title))
      added++
      console.log(`Discovered [${candidate.category}]: ${story.title} (${story.pages.length} pages)`)
    } catch(error) { console.warn(`Skipped ${candidate.title}: ${error.message}`) }
  }
  await fs.mkdir(DIR,{recursive:true})
  await fs.writeFile(DISCOVERY_FILE,JSON.stringify(state,null,2)+'\n')
}
if (added) await fs.writeFile(FILE, JSON.stringify(library, null, 2) + '\n')
await fs.mkdir(DIR, { recursive: true })
const chunks = Math.ceil(library.length / CHUNK_SIZE)
for (let i = 0; i < chunks; i++) await fs.writeFile(`${DIR}/${String(i).padStart(4, '0')}.json`, JSON.stringify(library.slice(i * CHUNK_SIZE, (i + 1) * CHUNK_SIZE)))
for (const filename of await fs.readdir(DIR)) if (/^\d{4}\.json$/.test(filename) && Number(filename.slice(0, 4)) >= chunks) await fs.unlink(`${DIR}/${filename}`)
await fs.writeFile(`${DIR}/manifest.json`, JSON.stringify({ version: 2, chunks, total: library.length, updatedAt: new Date().toISOString() }))
console.log(`${added} discovered articles added; total ${library.length}; published ${chunks} chunks; ${attempted} candidates checked`)
