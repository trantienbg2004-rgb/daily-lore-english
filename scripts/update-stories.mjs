import fs from 'node:fs/promises'

// Daily Lore English: full-text Wikipedia reader; no AI key, no paid service.
// Existing story records and their IDs are preserved for reading history.
const FILE = 'public/stories.json'
const DIR = 'public/feed'
const PER_RUN = 12
const CHUNK_SIZE = 12
const UA = 'DailyLoreEnglish/4.0 (educational reading; https://github.com/trantienbg2004-rgb/daily-lore-english)'
const PUBLISH_ONLY = process.argv.includes('--publish-only')
const topics = [

  'Aurora','Octopus','Bioluminescence','Coral reef','Hummingbird','Black hole','Honey bee','Volcano','Deep sea','Rainforest','Solar eclipse','Saturn','Mushroom','Ocean current','Antarctica','Dolphin','Photosynthesis','Mars','Glacier','Butterfly','Tardigrade','Milky Way','Sleep','Memory','Earthquake','Red panda','Mangrove','Comet','Seahorse','Meteor shower','Penguin','Tropical cyclone','Giant panda','Axolotl','Tsunami','Water cycle','Lunar eclipse','Koala','Venus','Cave','Platypus','Jellyfish','Earth atmosphere','Quantum mechanics','Ocean','Neutron star','Polar bear','Arctic Ocean','Blue whale','Cuttlefish','Baobab','Telescope','Volcanic lightning','Microbiome','Geothermal energy','Monsoon','Mangrove forest','Coral bleaching','Solar wind',
  'Pangolin','Narwhal','Orca','Sea otter','Manta ray','Whale shark','Electric eel','Leafcutter ant','Firefly','Praying mantis','Dragonfly','Chameleon','Komodo dragon','Snow leopard','Arctic fox','Fennec fox','Sloth','Capybara','Meerkat','Raven','Albatross','Puffin','Flamingo','Kingfisher','Toucan','Woodpecker','Owl','Bat','Cicada','Salamander','Poison dart frog','Sea turtle','Starfish','Sea anemone','Kelp forest','Seagrass','Peat bog','Wetland','Taiga','Tundra','Savanna','Desert','Sand dune','Oasis','Canyon','Fjord','Geyser','Hot spring','Sinkhole','Stalactite','Cenote','Delta','Estuary','Atoll','Barrier reef','Mid-ocean ridge','Mariana Trench','Great Barrier Reef','Amazon rainforest','Sahara','Himalayas','Mount Everest','Lake Baikal','Dead Sea','Galápagos Islands',
  'Northern lights','Light pollution','Rainbow','Halo (optical phenomenon)','Mirage','Lightning','Thunder','Hail','Snowflake','Cloud','Fog','Atmospheric river','Jet stream','El Niño','La Niña','Ocean gyre','Tide','Rip current','Rogue wave','Bioluminescent bay','Ecosystem','Food web','Symbiosis','Mutualism (biology)','Mycorrhiza','Pollination','Seed dispersal','Carnivorous plant','Venus flytrap','Pitcher plant','Bamboo','Redwood','Giant sequoia','Banyan','Ginkgo','Lichen','Moss','Fern','Algae','Phytoplankton','Zooplankton','Krill','Coral polyp','Cell (biology)','DNA','RNA','Chromosome','Evolution','Natural selection','Adaptation','Camouflage','Mimicry','Hibernation','Migration (ecology)','Circadian rhythm','REM sleep','Dream','Human brain','Neuron','Neuroplasticity','Synesthesia','Placebo','Immune system','Gut microbiota',
  'Exoplanet','Habitable zone','Proxima Centauri','Andromeda Galaxy','Nebula','Supernova','Pulsar','Magnetar','Quasar','Dark matter','Dark energy','Gravitational wave','Event horizon','Accretion disk','Asteroid','Kuiper belt','Oort cloud','Dwarf planet','Pluto','Europa (moon)','Enceladus','Titan (moon)','Io (moon)','Ganymede (moon)','Jupiter','Neptune','Uranus','Mercury (planet)','International Space Station','James Webb Space Telescope','Hubble Space Telescope','Voyager 1','Apollo 11','Artemis program','Solar flare','Coronal mass ejection','Magnetosphere','Van Allen radiation belt',
  'Plate tectonics','Continental drift','Subduction','Fault (geology)','Seismology','Geology','Fossil','Amber','Dinosaur','Trilobite','Ammonite','Mass extinction','Ice age','Permafrost','Greenhouse effect','Climate change','Carbon cycle','Nitrogen cycle','Ozone layer','Renewable energy','Wind turbine','Hydroelectricity','Tidal power','Solar power','Battery','Lithium-ion battery','Semiconductor','Transistor','Fiber-optic communication','Laser','Holography','Microscope','Electron microscope','Magnetic resonance imaging','3D printing','Robotics','Artificial intelligence','Machine learning','Cryptography','Internet','World Wide Web','GPS','Satellite navigation','Geostationary orbit','International Date Line','Time zone','Leap year','Calendar','Prime number','Fibonacci sequence','Fractal','Chaos theory','Probability','Infinity','Pi','Golden ratio']
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
  if (!pages.length) throw Error('Insufficient clean text')
  return { category: 'DISCOVER · WIKIPEDIA', title: p.title.toUpperCase(), subtitle: 'Read the full story · Wikipedia', sourceTitle: topic, sourceUrl: url, contentType: 'knowledge', license: 'CC BY-SA 4.0 (verify source page and media license)', attribution: `Wikipedia contributors, “${p.title}”, ${url}`, pages }
}

const raw = JSON.parse(await fs.readFile(FILE, 'utf8'))
if (!Array.isArray(raw) || !raw.length || !raw.every(valid)) throw Error('Invalid existing library; refusing to overwrite')
const map = new Map()
for (const s of raw) if (!map.has(id(s))) map.set(id(s), s)
const library = [...map.values()]
const urls = new Set(library.map(s => s.sourceUrl).filter(Boolean))
const titles = new Set(library.map(s => (s.sourceTitle || '').toLowerCase()).filter(Boolean))
let added = 0
if (!PUBLISH_ONLY) {
  for (const topic of topics) {
    if (added >= PER_RUN) break
    if (titles.has(topic.toLowerCase())) continue
    try {
      const story = await getArticle(topic)
      if (urls.has(story.sourceUrl)) continue
      library.unshift(story)
      urls.add(story.sourceUrl)
      titles.add(topic.toLowerCase())
      added++
      console.log(`Full article: ${story.title} (${story.pages.length} pages, ${story.pages.reduce((n, p) => n + countWords(p.text), 0)} words)`)
    } catch (error) { console.warn(`Skipped ${topic}: ${error.message}`) }
  }
}
if (added) await fs.writeFile(FILE, JSON.stringify(library, null, 2) + '\n')
await fs.mkdir(DIR, { recursive: true })
const chunks = Math.ceil(library.length / CHUNK_SIZE)
for (let i = 0; i < chunks; i++) await fs.writeFile(`${DIR}/${String(i).padStart(4, '0')}.json`, JSON.stringify(library.slice(i * CHUNK_SIZE, (i + 1) * CHUNK_SIZE)))
for (const filename of await fs.readdir(DIR)) if (/^\d{4}\.json$/.test(filename) && Number(filename.slice(0, 4)) >= chunks) await fs.unlink(`${DIR}/${filename}`)
await fs.writeFile(`${DIR}/manifest.json`, JSON.stringify({ version: 2, chunks, total: library.length, updatedAt: new Date().toISOString() }))
console.log(`${added} full articles added; total ${library.length}; published ${chunks} chunks`)
