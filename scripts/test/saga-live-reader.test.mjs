import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import {refreshCatalog,refillCatalog,REFRESH_INTERVAL_MS} from '../../src/lib/continuousReader.js'
import {approvedCommonsPhoto,searchCommonsImages,commonsQueryFor,commonsQueryIsContextual} from '../discover/commonsMedia.mjs'
import {validatedNewsHeadline} from '../discover/headline.mjs'
import {buildThreeLevelRequest} from '../discover/geminiLevels.mjs'
import {displayHeadline} from '../../src/lib/editorial.js'
import {photoLabel} from '../../src/lib/photoPresentation.js'

test('uncached catalog growth prioritizes a new news story without removing the loaded story',async()=>{
 const stories=JSON.parse(fs.readFileSync('public/lore-reader/0014.json','utf8')).filter(s=>s.contentType==='news')
 const old=stories[0],fresh=stories[1]
 let revision=1
 const requests=[]
 const response=data=>({ok:true,json:async()=>data})
 const fetchImpl=async(url,options)=>{
  requests.push({url,options})
  if(url.includes('catalog-index.json'))return response({version:2,total:revision,contentHash:`hash-${revision}`,
   entries:stories.slice(0,revision).map(s=>({id:s.sourceUrl,shard:'0014',contentType:'news',category:s.category,publisher:s.publisher,publishedAt:s.publishedAt}))})
  if(url.includes('/0014.json'))return response(stories)
  throw Error(`Unexpected request ${url}`)
 }
 const manifest=async()=>({ready:true,editorialVersion:1,count:1,total:revision,newsOnly:true,feedType:'news',
  version:`hash-${revision}`,contentHash:`hash-${revision}`,indexFile:'catalog-index.json'})
 const first=await refreshCatalog({fetchImpl,baseUrl:'/',now:100,pools:[],fetchManifestImpl:manifest})
 assert.deepEqual(first.newIds,[])
 const loaded=new Set([old.sourceUrl])
 revision=2
 const next=await refreshCatalog({fetchImpl,baseUrl:'/',now:200,pools:first.pools,fetchManifestImpl:manifest})
 assert.deepEqual(next.newIds,[fresh.sourceUrl])
 const refill=await refillCatalog({fetchImpl,baseUrl:'/',pools:next.pools,loaded,target:1,newsOnly:true,
  priorityIds:new Set(next.newIds)})
 assert.deepEqual(refill.items.map(s=>s.sourceUrl),[fresh.sourceUrl])
 assert.ok(loaded.has(old.sourceUrl)&&loaded.has(fresh.sourceUrl))
 assert.equal(requests.filter(r=>r.url.includes('catalog-index.json')).length,2)
 assert.ok(requests.filter(r=>r.url.includes('catalog-index.json')).every(r=>r.options.cache==='no-store'&&/\?t=\d+$/.test(r.url)))
 assert.equal(REFRESH_INTERVAL_MS,180000)
})

test('Commons illustrations require individual reusable license and author evidence',()=>{
 const page={title:'File:International Monetary Fund headquarters.jpg',imageinfo:[{mime:'image/jpeg',width:900,height:600,
  thumburl:'https://thumb.wikimedia.org/wikipedia/commons/thumb/a/a.jpg',
  descriptionurl:'https://commons.wikimedia.org/wiki/File:International_Monetary_Fund_headquarters.jpg',
  extmetadata:{LicenseUrl:{value:'https://creativecommons.org/licenses/by/4.0/'},LicenseShortName:{value:'CC BY 4.0'},Artist:{value:'Example photographer'}}}]}
 assert.ok(approvedCommonsPhoto(page,'International Monetary Fund headquarters'))
 const restricted=structuredClone(page)
 restricted.imageinfo[0].extmetadata.LicenseUrl.value='https://creativecommons.org/licenses/by-nc/4.0/'
 assert.equal(approvedCommonsPhoto(restricted,'International Monetary Fund headquarters'),null)
 const unattributed=structuredClone(page)
 unattributed.imageinfo[0].extmetadata.Artist.value=''
 assert.equal(approvedCommonsPhoto(unattributed,'International Monetary Fund headquarters'),null)
 assert.equal(approvedCommonsPhoto(page,'Ukraine market'),null)
})

test('Commons search can supply distinct, credited images for later pages',async()=>{
 const make=(id,licensed=true)=>({index:id,title:`File:International Monetary Fund headquarters ${id}.jpg`,imageinfo:[{
  mime:'image/jpeg',width:900,height:600,thumburl:`https://thumb.wikimedia.org/wikipedia/commons/thumb/${id}.jpg`,
  descriptionurl:`https://commons.wikimedia.org/wiki/File:International_Monetary_Fund_headquarters_${id}.jpg`,
  extmetadata:{LicenseUrl:{value:licensed?'https://creativecommons.org/licenses/by/4.0/':'https://creativecommons.org/licenses/by-nc/4.0/'},
   LicenseShortName:{value:licensed?'CC BY 4.0':'CC BY-NC 4.0'},Artist:{value:`Photographer ${id}`}}}]})
 const fetchImpl=async()=>({ok:true,json:async()=>({query:{pages:{one:make(1),two:make(2,false),three:make(3)}}})})
 const photos=await searchCommonsImages('IMF discusses global growth',{fetchImpl,limit:3,
  excludeUrls:['https://commons.wikimedia.org/wiki/File:International_Monetary_Fund_headquarters_1.jpg']})
 assert.deepEqual(photos.map(photo=>photo.provenance.credit),['Photographer 3 / Wikimedia Commons'])
})

test('country-only Commons photos must show a place, not an unrelated official or animal',async()=>{
 const page=(title,index)=>({index,title:`File:${title}.jpg`,imageinfo:[{
  mime:'image/jpeg',width:900,height:600,thumburl:`https://thumb.wikimedia.org/wikipedia/commons/thumb/${index}.jpg`,
  descriptionurl:`https://commons.wikimedia.org/wiki/File:${title.replaceAll(' ','_')}.jpg`,
  extmetadata:{LicenseUrl:{value:'https://creativecommons.org/licenses/by/4.0/'},
   LicenseShortName:{value:'CC BY 4.0'},Artist:{value:'Photographer'}}} ]})
 const entries={one:page('Mozambique army personnel',1),two:page('Maputo street in Mozambique',2),
  three:page('Mozambique eagle',3),four:page('Mozambique city centre',4)}
 assert.equal(approvedCommonsPhoto(entries.one,'Mozambique'),null)
 assert.equal(approvedCommonsPhoto(entries.three,'Mozambique'),null)
 const fetchImpl=async()=>({ok:true,json:async()=>({query:{pages:entries}})})
 const photos=await searchCommonsImages('Current affairs in Mozambique',{fetchImpl,limit:3})
 assert.equal(photos.length,1)
 assert.match(photos[0].caption,/Maputo street/)
 assert.deepEqual(await searchCommonsImages('Current affairs in Mozambique',{fetchImpl,
  excludeUrls:['https://commons.wikimedia.org/wiki/File:existing.jpg']}),[])
 assert.equal(commonsQueryFor('Rana Tharu women in Nepal'),'Tharu Nepal')
 assert.equal(commonsQueryFor('Women at Nampula protests'),'Nampula Mozambique')
 assert.equal(commonsQueryIsContextual('Nepal reflects on protests'),true)
})

test('subject illustrations require an image title matching the reported place or subject',()=>{
 const image=(title)=>({title:`File:${title}.jpg`,imageinfo:[{mime:'image/jpeg',width:900,height:600,
  thumburl:'https://thumb.wikimedia.org/wikipedia/commons/thumb/a/a.jpg',
  descriptionurl:`https://commons.wikimedia.org/wiki/File:${title.replaceAll(' ','_')}.jpg`,
  extmetadata:{LicenseUrl:{value:'https://creativecommons.org/licenses/by/4.0/'},LicenseShortName:{value:'CC BY 4.0'},Artist:{value:'Example photographer'}}}]})
 assert.equal(commonsQueryFor('Poisoned waters in Thailand’s Kok River'),'Kok River Thailand')
 assert.ok(approvedCommonsPhoto(image('Tha Ton, Kok River, Mae Ai, Thailand'),'Kok River Thailand'))
 assert.equal(approvedCommonsPhoto(image('Elephants, Kok River, Thailand'),'Kok River Thailand'),null)
 assert.equal(commonsQueryFor('Peregrine falcons in Australia'),'Australian peregrine falcon')
 assert.ok(approvedCommonsPhoto(image('Peregrine falcon in Botany Bay NSW'),'Australian peregrine falcon'))
 assert.equal(commonsQueryFor('Casablanca music scene'),'Casablanca musicians')
 assert.ok(approvedCommonsPhoto(image('Krav Boca sur les toits de Casablanca en 2019'),'Casablanca musicians'))
 assert.equal(commonsQueryFor('Cotton law affects Uyghur farmers'),'Xinjiang cotton field')
 assert.ok(approvedCommonsPhoto(image('Cotton harvest in Xinjiang'),'Xinjiang cotton field'))
 assert.equal(approvedCommonsPhoto(image('Cotton harvest in Texas'),'Xinjiang cotton field'),null)
})

test('Commons rate limiting stops photo discovery instead of spending Gemini quota',async()=>{
 await assert.rejects(searchCommonsImages('Current affairs in Mozambique',{
  fetchImpl:async()=>({ok:false,status:429})
 }),/Wikimedia Commons 429 rate limit/)
})

test('continued-page duplicate heading is hidden while toolbar title stays',()=>{
 const css=fs.readFileSync('src/App.css','utf8')
 const app=fs.readFileSync('src/App.jsx','utf8')
 assert.match(css,/\.lore-editorial-v5 \.reader-gesture \.article-heading-continued \{\s*display:block;\s*min-height:/)
 assert.match(css,/\.lore-editorial-v5 \.reader-gesture \.article-heading\.article-heading-continued \.deck \{display:none\}/)
 assert.match(app,/pageNumber > 0 \? displayHeadline\(item\) : readerSection\(item\)/)
 assert.ok(!app.includes('<div className="eyebrow">{readerSection(item)}</div>'))
})

test('visible photo descriptions stay short while full credits remain in article data',()=>{
 const page={image:'https://upload.wikimedia.org/wikipedia/commons/a/a.jpg',caption:'Illustrative image: Secretary of State Andrew Mitchell speaking to Bangladeshi migrant workers in Tunisia 5499005871',imageProvenance:{credit:'Original photographer',license:'CC BY 4.0'}}
 assert.ok(photoLabel(page).startsWith('Secretary of State'))
 assert.ok(photoLabel(page).length<=53)
 assert.ok(!/illustrat/i.test(photoLabel(page)))
 assert.ok(!photoLabel(page).includes('5499005871'))
 assert.match(page.caption,/Bangladeshi migrant workers/)
 assert.equal(page.imageProvenance.credit,'Original photographer')
 assert.equal(photoLabel({image:page.image,caption:'Illustrative image: Damage in Gaza Strip during the October 2023 - 29'}),'Damage in Gaza Strip, October 2023')
 assert.equal(photoLabel({image:page.image,caption:'Location of Cambodia and Bangladesh. Image via Wikipedia by TUBS.'}),
  'Location of Cambodia and Bangladesh.')
})

test('all published news has a short display headline while original source titles remain intact',()=>{
 const manifest=JSON.parse(fs.readFileSync('public/lore-reader/manifest.json','utf8'))
 const stories=Array.from({length:manifest.chunks},(_,i)=>JSON.parse(fs.readFileSync(`public/lore-reader/${String(i).padStart(4,'0')}.json`,'utf8'))).flat().filter(s=>s.contentType==='news')
 assert.equal(stories.length,manifest.total)
 for(const story of stories){
  assert.equal(validatedNewsHeadline(story.headline,story.sourceTitle),story.headline)
  assert.equal(displayHeadline(story),story.headline)
  assert.equal(story.sourceTitle,story.title)
  assert.ok(story.headline.length<=48)
 }
 const source={title:'World Bank and Japan announce first DRIVE energy project in Asia',text:'The World Bank and Japan announced the new project.'}
 assert.equal(validatedNewsHeadline('World Bank reports 999 new projects',source.title,source.text),'')
 assert.equal(validatedNewsHeadline('World Bank and Boeing announce Asia project',source.title,source.text),'')
 assert.equal(validatedNewsHeadline('World Bank and Japan announce a major new energy project across Asia',source.title),'')
 assert.match(buildThreeLevelRequest(source).systemInstruction.parts[0].text,/headline of 5–8 words and at most 48 characters/)
})
