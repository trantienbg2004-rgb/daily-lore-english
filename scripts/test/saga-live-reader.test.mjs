import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import {approvedCommonsPhoto,searchCommonsImages,commonsQueryFor,commonsQueryIsContextual} from '../discover/commonsMedia.mjs'
import {photoLabel} from '../../src/lib/photoPresentation.js'

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
 const alternative=await searchCommonsImages('Current affairs in Mozambique',{fetchImpl,
  excludeUrls:['https://commons.wikimedia.org/wiki/File:Maputo_street_in_Mozambique.jpg']})
 assert.equal(alternative.length,1)
 assert.match(alternative[0].caption,/Mozambique city centre/)
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

test('toolbar keeps the section label while every news page shows its complete headline',()=>{
 const css=fs.readFileSync('src/App.css','utf8')
 const app=fs.readFileSync('src/App.jsx','utf8')
 assert.match(css,/\.lore-editorial-v5 \.reader-gesture \.article-heading-continued \{\s*display:block;\s*min-height:/)
 assert.match(css,/\.lore-editorial-v5 \.reader-gesture \.article-heading\.article-heading-continued \.deck \{display:none\}/)
 assert.match(app,/className="saga-toolbar-story" title=\{readerSection\(item\)\}>\{readerSection\(item\)\}/)
 assert.match(app,/pageNumber > 0 && item\.contentType !== 'news' \? 'article-heading-continued' : ''/)
 assert.ok(!app.includes('<div className="eyebrow">{readerSection(item)}</div>'))
})

test('visible photo descriptions stay concise while the full caption and credits remain available',()=>{
 const page={image:'https://upload.wikimedia.org/wikipedia/commons/a/a.jpg',caption:'Illustrative image: Secretary of State Andrew Mitchell speaking to Bangladeshi migrant workers in Tunisia while visiting a refugee support center in the southern region of the country 5499005871',imageProvenance:{credit:'Original photographer',license:'CC BY 4.0'}}
 assert.ok(photoLabel(page).startsWith('Secretary of State'))
 assert.ok(photoLabel(page).length<=88)
 assert.ok(photoLabel(page).endsWith('…'))
 assert.ok(!/illustrat/i.test(photoLabel(page)))
 assert.ok(!photoLabel(page).includes('5499005871'))
 assert.match(page.caption,/Bangladeshi migrant workers/)
 assert.equal(page.imageProvenance.credit,'Original photographer')
 assert.equal(photoLabel({image:page.image,caption:'Illustrative image: Damage in Gaza Strip during the October 2023 - 29'}),'Damage in Gaza Strip, October 2023')
 assert.equal(photoLabel({image:page.image,caption:'Location of Cambodia and Bangladesh. Image via Wikipedia by TUBS.'}),
  'Location of Cambodia and Bangladesh.')
 const css=fs.readFileSync('src/App.css','utf8')
 const app=fs.readFileSync('src/App.jsx','utf8')
 assert.match(css,/lore-photo-caption\s*\{[^}]*max-height:2\.65em;\s*overflow:hidden;/s)
 assert.match(app,/mediaBounds\.bottom <= pagerBounds\.top - 8/)
})
