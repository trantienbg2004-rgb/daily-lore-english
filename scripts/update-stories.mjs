import fs from 'node:fs/promises'

// Daily Lore English: free, incremental feed builder (Node.js 22+).
// --publish-only rebuilds the feed without fetching external content.
const FILE = 'public/stories.json'
const FEED_DIR = 'public/feed'
const MAX_STORIES = 5000
const CHUNK_SIZE = 12
const NEWS_PER_SOURCE = 5
const KNOWLEDGE_PER_RUN = 18
const MAX_NEWS_AGE_HOURS = 72
const PUBLISH_ONLY = process.argv.includes('--publish-only')
const UA = 'DailyLoreEnglish/3.0 (educational reading; https://github.com/trantienbg2004-rgb/daily-lore-english)'
const topics = [
  'Aurora','Octopus','Bioluminescence','Coral reef','Hummingbird','Black hole','Honey bee','Volcano','Deep sea','Rainforest','Solar eclipse','Saturn','Mushroom','Ocean current','Antarctica','Dolphin','Photosynthesis','Mars','Glacier','Butterfly','Tardigrade','Milky Way','Sleep','Memory','Earthquake','Red panda','Mangrove','Comet','Seahorse','Meteor shower','Penguin','Tropical cyclone','Giant panda','Axolotl','Tsunami','Water cycle','Lunar eclipse','Koala','Venus','Cave','Platypus','Jellyfish','Earth atmosphere','Quantum mechanics','Ocean','Neutron star','Polar bear','Arctic Ocean','Blue whale','Cuttlefish','Baobab','Telescope','Volcanic lightning','Microbiome','Geothermal energy','Monsoon','Mangrove forest','Coral bleaching','Solar wind',
  'Pangolin','Narwhal','Orca','Sea otter','Manta ray','Whale shark','Electric eel','Leafcutter ant','Firefly','Praying mantis','Dragonfly','Chameleon','Komodo dragon','Snow leopard','Arctic fox','Fennec fox','Sloth','Capybara','Meerkat','Raven','Albatross','Puffin','Flamingo','Kingfisher','Toucan','Woodpecker','Owl','Bat','Cicada','Salamander','Poison dart frog','Sea turtle','Starfish','Sea anemone','Kelp forest','Seagrass','Peat bog','Wetland','Taiga','Tundra','Savanna','Desert','Sand dune','Oasis','Canyon','Fjord','Geyser','Hot spring','Sinkhole','Stalactite','Cenote','Delta','Estuary','Atoll','Barrier reef','Mid-ocean ridge','Mariana Trench','Great Barrier Reef','Amazon rainforest','Sahara','Himalayas','Mount Everest','Lake Baikal','Dead Sea','Galápagos Islands',
  'Northern lights','Light pollution','Rainbow','Halo (optical phenomenon)','Mirage','Lightning','Thunder','Hail','Snowflake','Cloud','Fog','Atmospheric river','Jet stream','El Niño','La Niña','Ocean gyre','Tide','Rip current','Rogue wave','Bioluminescent bay','Ecosystem','Food web','Symbiosis','Mutualism (biology)','Mycorrhiza','Pollination','Seed dispersal','Carnivorous plant','Venus flytrap','Pitcher plant','Bamboo','Redwood','Giant sequoia','Banyan','Ginkgo','Lichen','Moss','Fern','Algae','Phytoplankton','Zooplankton','Krill','Coral polyp','Cell (biology)','DNA','RNA','Chromosome','Evolution','Natural selection','Adaptation','Camouflage','Mimicry','Hibernation','Migration (ecology)','Circadian rhythm','REM sleep','Dream','Human brain','Neuron','Neuroplasticity','Synesthesia','Placebo','Immune system','Gut microbiota',
  'Exoplanet','Habitable zone','Proxima Centauri','Andromeda Galaxy','Nebula','Supernova','Pulsar','Magnetar','Quasar','Dark matter','Dark energy','Gravitational wave','Event horizon','Accretion disk','Asteroid','Kuiper belt','Oort cloud','Dwarf planet','Pluto','Europa (moon)','Enceladus','Titan (moon)','Io (moon)','Ganymede (moon)','Jupiter','Neptune','Uranus','Mercury (planet)','International Space Station','James Webb Space Telescope','Hubble Space Telescope','Voyager 1','Apollo 11','Artemis program','Solar flare','Coronal mass ejection','Magnetosphere','Van Allen radiation belt',
  'Plate tectonics','Continental drift','Subduction','Fault (geology)','Seismology','Geology','Fossil','Amber','Dinosaur','Trilobite','Ammonite','Mass extinction','Ice age','Permafrost','Greenhouse effect','Climate change','Carbon cycle','Nitrogen cycle','Ozone layer','Renewable energy','Wind turbine','Hydroelectricity','Tidal power','Solar power','Battery','Lithium-ion battery','Semiconductor','Transistor','Fiber-optic communication','Laser','Holography','Microscope','Electron microscope','Magnetic resonance imaging','3D printing','Robotics','Artificial intelligence','Machine learning','Cryptography','Internet','World Wide Web','GPS','Satellite navigation','Geostationary orbit','International Date Line','Time zone','Leap year','Calendar','Prime number','Fibonacci sequence','Fractal','Chaos theory','Probability','Infinity','Pi','Golden ratio'
]
const feeds = [
  { url: 'https://feeds.bbci.co.uk/news/world/rss.xml', category: 'WORLD NEWS', source: 'BBC News' },
  { url: 'https://feeds.bbci.co.uk/news/science_and_environment/rss.xml', category: 'SCIENCE NEWS', source: 'BBC News' },
  { url: 'https://feeds.bbci.co.uk/news/technology/rss.xml', category: 'TECH NEWS', source: 'BBC News' },
]
const decode = value => String(value || '')
  .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
  .replace(/<[^>]+>/g, ' ')
  .replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos|nbsp|ndash|mdash|hellip);/gi, (_, entity) => {
    const named = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ndash: '–', mdash: '—', hellip: '…' }
    if (entity.startsWith('#')) {
      const n = entity[1]?.toLowerCase() === 'x' ? parseInt(entity.slice(2), 16) : parseInt(entity.slice(1), 10)
      return Number.isFinite(n) && n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : ''
    }
    return named[entity.toLowerCase()] || ''
  }).replace(/\s+/g, ' ').trim()
const field = (xml, tag) => decode(xml.match(new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${tag}>`, 'i'))?.[1] || '')
const isHttps = value => typeof value === 'string' && /^https:\/\//i.test(value)
const fetchWithTimeout = async (url, accept = 'application/json') => {
  const response = await fetch(url, { headers: { 'User-Agent': UA, Accept: accept }, signal: AbortSignal.timeout(14000) })
  if (!response.ok) throw Error(`HTTP ${response.status} for ${url}`)
  return response
}
const storyId = item => item.sourceUrl || item.sourceTitle || `${item.category}:${item.title}`
const validStory = item => item && typeof item.title === 'string' && Array.isArray(item.pages) && item.pages.length > 0 && item.pages.every(page => typeof page.text === 'string' && typeof page.image === 'string')
const sentenceSplit = text => (text.match(/[^.!?]+[.!?]+(?:[”"']|$)?|[^.!?]+$/g) || []).map(s => s.trim()).filter(Boolean)
const articlePages = (sentences, image, caption) => {
  const pages = []
  for (let i = 0; i < sentences.length && pages.length < 5; i += 2) {
    const text = sentences.slice(i, i + 2).join(' ')
    if (text) pages.push({ image, caption, text })
  }
  return pages
}
const rawLibrary = JSON.parse(await fs.readFile(FILE, 'utf8'))
if (!Array.isArray(rawLibrary) || !rawLibrary.length || !rawLibrary.every(validStory)) throw Error('Invalid story library; refusing to overwrite')
// Preserve existing read-history IDs; never mutate existing story URLs or titles.
const unique = new Map()
for (const item of rawLibrary) if (!unique.has(storyId(item))) unique.set(storyId(item), item)
const library = [...unique.values()]
const knownUrls = new Set(library.map(x => x.sourceUrl).filter(Boolean))
const knownTopics = new Set(library.map(x => x.sourceTitle).filter(Boolean))
let newsAdded = 0
let knowledgeAdded = 0

if (!PUBLISH_ONLY) {
  for (const feed of feeds) {
    try {
      const xml = await (await fetchWithTimeout(feed.url, 'application/rss+xml, application/xml, text/xml, */*')).text()
      const items = [...xml.matchAll(/<item(?:\s[^>]*)?>([\s\S]*?)<\/item>/gi)].map(m => m[1])
      let fromThisFeed = 0
      for (const item of items) {
        if (fromThisFeed >= NEWS_PER_SOURCE || library.length >= MAX_STORIES) break
        const title = field(item, 'title')
        const link = field(item, 'link')
        const desc = field(item, 'description')
        const date = Date.parse(field(item, 'pubDate'))
        const image = item.match(/<media:content\b[^>]*\burl=["']([^"']+)["'][^>]*\bmedium=["']image["']/i)?.[1]
          || item.match(/<media:thumbnail\b[^>]*\burl=["']([^"']+)["']/i)?.[1]
          || item.match(/<media:content\b[^>]*\burl=["']([^"']+)["']/i)?.[1]
        if (!title || !isHttps(link) || knownUrls.has(link) || !desc || !isHttps(image)) continue
        if (!Number.isFinite(date) || date > Date.now() + 3600000 || Date.now() - date > MAX_NEWS_AGE_HOURS * 3600000) continue
        const preview = desc.split(/\s+/).slice(0, 45).join(' ').trim()
        if (preview.length < 55) continue
        // RSS previews are deliberately short: never invent a full article from a headline.
        library.unshift({
          category: feed.category,
          title: title.toUpperCase(),
          subtitle: `${feed.source} · ${new Date(date).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' })}`,
          sourceTitle: title, sourceUrl: link, publishedAt: new Date(date).toISOString(), contentType: 'news',
          pages: [{ image, caption: `Image from ${feed.source} RSS · see original source for credits`, text: `${preview}${/[.!?]$/.test(preview) ? '' : '.'}` }],
        })
        knownUrls.add(link)
        fromThisFeed++
        newsAdded++
      }
      console.log(`News source ${feed.category}: ${fromThisFeed} new previews`)
    } catch (error) { console.warn(`News source ${feed.category} skipped: ${error.message}`) }
  }

  for (const topic of topics) {
    if (knowledgeAdded >= KNOWLEDGE_PER_RUN || library.length >= MAX_STORIES) break
    if (knownTopics.has(topic)) continue
    try {
      const url = `https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(topic)}`
      const data = await (await fetchWithTimeout(url)).json()
      if (data.type === 'disambiguation' || !data.extract || data.extract.length < 220) continue
      const sentences = sentenceSplit(data.extract)
      if (sentences.length < 4) continue
      // originalimage is generally higher resolution than thumbnail.
      const image = isHttps(data.originalimage?.source) ? data.originalimage.source : data.thumbnail?.source
      if (!isHttps(image)) continue
      const sourceUrl = data.content_urls?.desktop?.page || `https://en.wikipedia.org/wiki/${encodeURIComponent(topic.replace(/ /g, '_'))}`
      if (knownUrls.has(sourceUrl)) { knownTopics.add(topic); continue }
      const pages = articlePages(sentences, image, `${data.title} · Wikimedia Commons / Wikipedia; image license and author: see source`)
      if (pages.length < 2) continue
      library.unshift({ category: 'DISCOVER · FROM WIKIPEDIA', title: data.title.toUpperCase(), subtitle: data.description || 'Discover something about our world', sourceTitle: topic, sourceUrl, contentType: 'knowledge', pages })
      knownTopics.add(topic)
      knownUrls.add(sourceUrl)
      knowledgeAdded++
      console.log(`Knowledge: ${topic} (${pages.length} pages)`)
    } catch (error) { console.warn(`Wikipedia topic skipped (${topic}): ${error.message}`) }
  }
}

// New additions are at the beginning; older existing stories remain available.
// Enforce the cap without silently removing already-published stories.
if (library.length > MAX_STORIES) console.warn(`Library has ${library.length} stories; preserving existing entries rather than deleting read-history references`)
if (newsAdded || knowledgeAdded || library.length !== rawLibrary.length) {
  await fs.writeFile(FILE, JSON.stringify(library, null, 2) + '\n')
}
await fs.mkdir(FEED_DIR, { recursive: true })
const chunks = Math.ceil(library.length / CHUNK_SIZE)
for (let i = 0; i < chunks; i++) {
  await fs.writeFile(`${FEED_DIR}/${String(i).padStart(4, '0')}.json`, JSON.stringify(library.slice(i * CHUNK_SIZE, (i + 1) * CHUNK_SIZE)))
}
// Remove only obsolete numbered feed chunks.
for (const name of await fs.readdir(FEED_DIR)) {
  if (/^\d{4}\.json$/.test(name) && Number(name.slice(0, 4)) >= chunks) await fs.unlink(`${FEED_DIR}/${name}`)
}
const manifest = { version: 2, chunks, total: library.length, updatedAt: new Date().toISOString() }
await fs.writeFile(`${FEED_DIR}/manifest.json`, JSON.stringify(manifest))
console.log(`${newsAdded} news previews, ${knowledgeAdded} knowledge stories added; total ${library.length}`)
console.log(`Published ${chunks} feed chunks for ${library.length} stories`)
