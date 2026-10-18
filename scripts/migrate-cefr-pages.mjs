/** One-time, reviewed headline and lossless page migration for the current catalog. */
import fs from 'node:fs/promises'
import path from 'node:path'
import {createHash} from 'node:crypto'
import {smartPaginate} from './discover/smartPaginate.mjs'

const levels=['A1-A2','B1-B2','C1-C2']
// Ordered against the active catalog at migration time; fail closed if it changes.
const reviewed=[
 ['Hoax links Brazil’s Lula to child abuse','False Story Spreads About Brazil’s Lula','Online Hoax Targets Brazil’s President Lula'],
 ['Peru’s Indigenous people face Amazon fires','Peru’s People Fight Fires in the Amazon','Indigenous Peruvians Confront Amazon Wildfires'],
 ['Authoritarian states build surveillance market','Governments Sell Tools to Watch People','Authoritarian States Commercialize Surveillance'],
 ['Telenor faces Myanmar data lawsuit','Telenor Faces a Case Over Myanmar Data','Telenor Confronts Myanmar Data Litigation'],
 ['Nepal seeks clear flood aid plan','Nepal Needs a Clear Flood Aid Plan','Nepal Demands Accountability for Flood Aid'],
 ['Poetry book promotes Chabacano','Poetry Book Helps Keep Chabacano Alive','Poetry Sustains Asia’s Chabacano Language'],
 ['Bangladesh–Malaysia recruitment costs questioned','Workers Question Bangladesh–Malaysia Job Costs','Migration Reforms Reignite Recruitment Cost Debate'],
 ['Ukrainian small businesses endure war','Small Businesses Survive War in Ukraine','Ukrainian Enterprises Navigate Prolonged War'],
 ['Haiti vendors protest gang violence','Haiti Sellers Protest Gang Violence','Haiti Vendors Challenge Entrenched Gang Violence'],
 ['Alibaba Sues Pentagon Over Military Ties','Alibaba Sues Over Pentagon Military Label','Alibaba Disputes Pentagon Military Classification'],
 ["El Niño Tests Latin America's Food Security",'El Niño Puts Latin American Food at Risk','El Niño Exacerbates Latin American Food Insecurity'],
 ['Venezuela Earthquakes Leave Children In Crisis','Venezuela Quakes Hurt Children and Families','Venezuelan Earthquakes Deepen Child Displacement'],
 ['Thousands of little penguins get vaccine','Small Penguins Get Bird Flu Vaccines','Penguin Vaccination Counters Avian Influenza'],
 ['Women and Capulana Dresses at Nampula Protests','Women Protest in Nampula, Mozambique','Nampula Protests Highlight Violence Against Women'],
 ['LGBTQ+ Experiences in Mozambique','LGBTQ+ People Speak About Life in Mozambique','Mozambique’s LGBTQ+ Community Navigates Visibility'],
 ['Rana Tharu women preserve Nepal heritage','Rana Tharu Women Keep Nepal Traditions Alive','Rana Tharu Women Sustain Nepalese Heritage'],
 ["Africa's courts lag on internet protests",'African Courts Face New Internet Protests','African Courts Lag Behind Digital Protest'],
 ['Trinidad and Tobago Special Operations Bill','Trinidad and Tobago Weighs New Security Bill','Special Operations Bill Reshapes Trinidad’s Development'],
 ['Bangladeshi Migrants Face Cyber Slavery','Bangladeshi Workers Face Online Job Traps','Digital Recruitment Exposes Bangladeshi Migrants'],
 ['Deep Sea Mining Risks for Jamaica Fisherfolk','Jamaica Fishers Worry About Deep Sea Mining','Deep Sea Mining Threatens Jamaican Fisheries'],
 ['Nepal Reflects on Gen Z Protests Anniversary','Nepal Remembers Young People’s Protests','Nepal Reassesses the Gen Z Protests'],
 ['Bangladesh: Protests can change governments','Bangladesh Protests Bring Change and Questions','Bangladesh Protests Test Democratic Institutions'],
 ['Brazil residents grow heat-fighting solutions','Brazil Residents Grow Plants to Fight Heat','Brazil Communities Cultivate Urban Heat Solutions'],
 ['Mob violence rises across Bangladesh','More Mob Violence Troubles Bangladesh','Bangladesh Confronts Escalating Mob Violence'],
 ['An exiled Myanmar journalist’s story','Myanmar Journalist Tells Life in Exile','Exiled Myanmar Journalist Chronicles Public Resilience'],
 ['Maternity leave is expanding in Bangladesh','Bangladesh Mothers Get More Time Off','Bangladesh Maternity Reform Exposes Childcare Gaps'],
 ['When the lights go out in Libya’s Cyrenaica','Power Cuts Hit Libya’s Cyrenaica','Cyrenaica’s Power Outages Expose Infrastructure Strain'],
 ['Two elections reshaped India-Bangladesh border','Elections Change the India-Bangladesh Border','Elections Reconfigure India-Bangladesh Border Politics'],
 ['Cambodia law curtailed right to protest','Cambodia Law Limits Public Protests','Cambodian Legislation Restricts Protest Rights'],
 ['Plants offer Ghanaians a medicine alternative','Ghana Plants Offer Another Way to Heal','Indigenous Plants Broaden Ghana’s Medical Options'],
 ['Croatian communities fight slaughterhouse plans','Croatian Towns Oppose New Poultry Plants','Croatian Communities Contest Poultry Expansion'],
 ['Casablanca musicians struggle as scene grows','Casablanca Musicians Face Hard Times','Casablanca’s Music Growth Masks Artist Struggles'],
 ['Indigenous Groups Fight Kok River Pollution','Local Groups Fight Kok River Pollution','Indigenous Communities Confront Kok River Contamination'],
 ['Peregrine Falcons Are Melbourne Streaming Stars','Melbourne Falcons Become Online Stars','Melbourne Peregrines Captivate Streaming Audiences'],
 ['From plants and waste to everyday products','Europe Makes Products from Plants and Waste','European Bioeconomy Converts Waste into Products'],
 ['SPACE USB Makes Satellites Easier To Repair','New Space Tools Help Repair Satellites','Modular Space Technology Simplifies Satellite Repair'],
 ['Tackling Invisible Pollution in Indoor Spaces','Europe Studies Pollution Inside Buildings','Indoor Pollution Demands More Precise Monitoring'],
 ['Open Source Tech Helps Farmers Trust Tools','Open Tools Help Farmers Trust Technology','Open Source Tools Strengthen Farmers’ Trust'],
 ['New climate models assess regional risks','New Climate Models Show Local Risks','Climate Models Sharpen Regional Risk Assessment'],
 ['AI Dives Into Sea Of Data','AI Helps Study Life in the Sea','AI Analyzes Extensive Ocean Data'],
 ['AI Could Replace Animal Testing Methods','AI May Reduce Tests on Animals','AI Methods Could Supplant Animal Testing'],
 ['Building Climate Resilience in European Cities','European Cities Prepare for Climate Change','European Cities Build Climate Resilience'],
 ['Capturing Lost Sunlight for Satellites','Satellites May Use More Sunlight','Satellite Design Recaptures Wasted Solar Energy'],
 ['Advanced Materials Could Boost Electric Motors','New Materials Help Electric Motors Work Better','Advanced Materials Enhance Electric Motor Efficiency'],
 ['Europe’s Housing Crisis and Energy Poverty','Europe’s Homes Can Cost More to Heat','Housing Crisis Intensifies European Energy Poverty'],
 ['Digital Tools for Europe’s Fisheries','Digital Tools Help Europe’s Fishers','Digital Tools Refine European Fisheries Oversight'],
 ['Street art in Russia faces war','War Changes Street Art in Russia','War Recasts Russia’s Street Art Landscape'],
 ['Too young to run, old enough to protest','West Africa’s Youth Demand Political Change','West African Youth Contest Political Exclusion'],
]

const dir=path.resolve('public/lore-reader')
const manifest=JSON.parse(await fs.readFile(path.join(dir,'manifest.json'),'utf8'))
const retired=new Set(manifest.retiredSourceUrls||[])
const originals=[]
for(let i=0;i<manifest.chunks;i++)originals.push(JSON.parse(await fs.readFile(path.join(dir,`${String(i).padStart(4,'0')}.json`),'utf8')))
const active=originals.flat().filter(story=>story.contentType==='news'&&!retired.has(story.sourceUrl))
if(active.length!==reviewed.length||active.some((story,i)=>story.headline!==reviewed[i][0]))throw Error('Catalog changed; review title mapping before migration')
const headlines=new Map(active.map((story,i)=>[story.id,reviewed[i].slice(1)]))
let changed=0
for(let i=0;i<originals.length;i++){
 let dirty=false
 for(const story of originals[i]){
  if(story.contentType!=='news')continue
  for(const [index,level] of levels.entries()){
   const variant=story.levelVariants[level]
   const original=variant.pages
   const paginated=smartPaginate(original)
   const media=original.filter(page=>page.image)
   variant.pages=paginated.map((text,pageIndex)=>({text,image:media[pageIndex]?.image||'',caption:media[pageIndex]?.caption||'',...(media[pageIndex]?.imageProvenance?{imageProvenance:media[pageIndex].imageProvenance}:{})}))
   if(headlines.has(story.id))variant.headline=index===1?story.headline:headlines.get(story.id)[index===0?0:1]
   else variant.headline=story.headline
   if(variant.pages.map(page=>page.text).join(' ')!==original.map(page=>page.text).join(' ').replace(/\s+/gu,' ').trim())throw Error(`Text changed: ${story.id} ${level}`)
   if(media.some((page,j)=>page.image!==variant.pages[j].image))throw Error(`Image changed: ${story.id} ${level}`)
  }
  story.pages=story.levelVariants['B1-B2'].pages
  changed++;dirty=true
 }
 if(dirty)await fs.writeFile(path.join(dir,`${String(i).padStart(4,'0')}.json`),JSON.stringify(originals[i])+'\n')
}
manifest.contentHash=createHash('sha256').update(JSON.stringify(active.map(story=>[story.id,story.levelVariants]))).digest('hex')
manifest.updatedAt=new Date().toISOString()
delete manifest.catalogIndexHash
await fs.writeFile(path.join(dir,'manifest.json'),JSON.stringify(manifest,null,2)+'\n')
console.log(`Migrated ${changed} news records; ${active.length} active titles reviewed`)
