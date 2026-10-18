import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import {rssImageHints,articleImageHint,licensedArticleImage,licensedArticleImages,photoRelevanceScore,assignArticlePhotos} from '../discover/licensedMedia.mjs'
import {articleMediaBlocks} from '../discover/htmlArticle.mjs'
import {validateDraft,toReaderStory} from '../discover/bridge.mjs'
import {inspectStagedRelease} from '../discover-live-qa.mjs'
import {source as nasaEarth} from '../discover/sources/nasaEarth.mjs'
import {extractArticle} from '../discover/article.mjs'
import {rightsDecision} from '../discover/rights.mjs'
import {requireOriginalArticlePhotos} from '../discover-publish.mjs'

const app=fs.readFileSync('src/App.jsx','utf8'),css=fs.readFileSync('src/App.css','utf8')

test('reading level and read-aloud buttons share a non-overlapping semantic header',()=>{
 assert.match(app,/<header className="topbar lore-reader-topbar">/)
 assert.match(app,/saga-toolbar-story/)
 assert.match(app,/saga-toolbar-audio/)
 assert.match(css,/\.saga-toolbar-story\s*\{[^}]*min-width:0;[^}]*white-space:normal;[^}]*overflow-wrap:break-word;/s)
 assert.match(css,/\.saga-news-level\s*\{[\s\S]*?position:static!important/)
 assert.equal((app.match(/aria-label="Read aloud"/g)||[]).length,1)
 assert.ok(app.includes('Image license ↗'))
 assert.ok(app.includes('dailyLoreWords'))
})

test('RSS thumbnail and OpenGraph image are discovered but not licensed automatically',()=>{
 const rss='<item><media:thumbnail url="https://pics.example.org/photo.jpg" /><enclosure url="https://pics.example.org/other.jpg" /></item>'
 assert.deepEqual(rssImageHints(rss),['https://pics.example.org/photo.jpg','https://pics.example.org/other.jpg'])
 const html='<meta property="og:image" content="https://pics.example.org/cover.jpg">'
 assert.equal(articleImageHint(html),'https://pics.example.org/cover.jpg')
 assert.equal(licensedArticleImage(html,'https://news.example.org/article'),null)
})

test('article media finds editorial images but rejects unlicensed OG and author avatars',()=>{
 const url='https://globalvoices.org/2026/10/17/poetry-story/'
 const html='<meta property="og:image" content="https://globalvoices.org/book.jpg"><article><img src="https://globalvoices.org/avatar.jpg" alt="Author avatar"><figure><img src="https://globalvoices.org/book.jpg" alt="Chabacano poetry anthology" width="800" height="450"><figcaption>Book photo used with permission</figcaption></figure><img src="https://globalvoices.org/field.jpg" aria-describedby="credit-field" width="800" height="500"><p id="credit-field">Photo by Mira, <a href="https://creativecommons.org/licenses/by/4.0/">CC BY 4.0</a></p></article>'
 assert.equal(articleMediaBlocks(html).filter(x=>x.kind==='metadata').length,1)
 assert.equal(articleImageHint(html,url),'https://globalvoices.org/book.jpg')
 assert.deepEqual(licensedArticleImages(html,url).map(p=>p.url),['https://globalvoices.org/field.jpg'])
})

test('city-only scenery is irrelevant to a poetry book and later photos need page subject overlap',()=>{
 const title='Poetry book promotes Chabacano language in Zamboanga'
 for(const caption of ["Zamboanga City's Sunset",'Zamboanga City Hall','Barangay Cawit Zamboanga City Philippines'])assert.equal(photoRelevanceScore({caption},title,'Writers published poems in Chabacano.'),0)
 assert.equal(photoRelevanceScore({caption:'Jamaican police patrol'},'Trinidad and Tobago Special Operations Bill','The police patrols are part of security policy.'),0)
 assert.ok(photoRelevanceScore({caption:'Chabacano poetry anthology'},title,'Writers published poems.')>0)
 const levels=Object.fromEntries(['A1-A2','B1-B2','C1-C2'].map(level=>[level,{pages:[{text:'A poetry book uses Chabacano.'},{text:'The anthology includes many poems.'},{text:'Readers discuss the book.'},{text:'The language has a future.'}]}]))
 assert.deepEqual(assignArticlePhotos([{caption:'Chabacano poetry anthology',url:'https://example.org/book.jpg'}],title,levels).map(photo=>photo.pageIndex),[0])
 assert.deepEqual(assignArticlePhotos([{caption:'Zamboanga sunset',url:'https://example.org/sunset.jpg'}],title,levels),[])
})

test('NASA Earth Observatory requires a first-party story and credits its own matching photos',()=>{
 const url='https://science.nasa.gov/earth/earth-observatory/amazon-fires/'
 const text=Array.from({length:16},(_,i)=>`<p>The Amazon fires have spread during the drought, and NASA scientists measured smoke above the rainforest with satellite instruments during observation ${i}.</p>`).join('')
 const image='<figure class="hds-media-inner"><img width="1200" height="800" src="https://assets.science.nasa.gov/dynamicimage/assets/science/esd/eo/images/iotd/2026/amazon-fires/fire.jpg?w=1200" alt="Amazon fires and smoke over the rainforest"></figure>'
 const thirdParty='<figure class="hds-media-inner"><img width="1200" height="800" src="https://assets.science.nasa.gov/dynamicimage/assets/science/esd/eo/images/iotd/2026/another-story/forest.jpg?w=1200" alt="Amazon forest"></figure>'
 const html=`<article>${image}${thirdParty}${text}<p>NASA Earth Observatory images by Lauren Dauphin, using NASA satellite data.</p></article>`
 const article=extractArticle(html,nasaEarth.id)
 assert.equal(rightsDecision(nasaEarth,article).textAllowed,true)
 const photos=licensedArticleImages(html,url,{articleTitle:'Amazon Fires Spread',articleText:article.text,limit:5})
 assert.equal(photos.length,1)
 assert.equal(photos[0].provenance.originType,'nasa-earth-observatory')
 assert.equal(rightsDecision(nasaEarth,extractArticle(html.replace('NASA Earth Observatory images by Lauren Dauphin','Getty Images by Lauren Dauphin'),nasaEarth.id)).textAllowed,false)
})

test('publication rejects Commons photos even if they have a valid CC license',()=>{
 const sourceUrl='https://globalvoices.org/2026/10/17/story/'
 assert.throws(()=>requireOriginalArticlePhotos([{sourceUrl,images:[{url:'https://upload.wikimedia.org/a.jpg',provenance:{sourceImageUrl:'https://commons.wikimedia.org/wiki/File:City.jpg',originType:'wikimedia-commons'}}]}]),/Non-original photo/)
 assert.doesNotThrow(()=>requireOriginalArticlePhotos([{sourceUrl,images:[]}]))
})

test('only per-figure CC image credits permit optional image publication',()=>{
 const source='https://globalvoices.org/2026/10/17/story/'
 const html='<figure><img src="https://images.example.org/event.jpg" alt="Photo of the event"><figcaption>Photo by Mira, <a href="https://creativecommons.org/licenses/by/4.0/">CC BY 4.0</a></figcaption></figure>'
 const image=licensedArticleImage(html,source)
 assert.ok(image)
 assert.equal(image.provenance.license,'CC BY')
 assert.equal(image.provenance.sourceImageUrl,source)
 const denied=html.replace('CC BY 4.0','Getty Images, all rights reserved')
 assert.equal(licensedArticleImage(denied,source),null)
})

test('each source photograph needs its own licence before appearing on later pages',()=>{
 const source='https://globalvoices.org/2026/10/17/story/'
 const first='<figure><img src="https://images.example.org/one.jpg"><figcaption>Photo by Mira, <a href="https://creativecommons.org/licenses/by/4.0/">CC BY 4.0</a></figcaption></figure>'
 const second='<figure><img src="https://images.example.org/two.jpg"><figcaption>Photo by Lan, <a href="https://creativecommons.org/licenses/by-sa/4.0/">CC BY-SA 4.0</a></figcaption></figure>'
 assert.equal(licensedArticleImages(first+second,source).length,2)
 assert.equal(licensedArticleImages(first+second.replace('by-sa/4.0/','by-nc/4.0/'),source).length,1)
})

test('Global Voices caption must prove the individual photo license',()=>{
 const source='https://globalvoices.org/2026/10/17/story/'
 const caption='<div class="wp-caption aligncenter"><a href="https://commons.wikimedia.org/wiki/File:Myanmar.jpg"><img src="https://globalvoices.org/wp-content/uploads/myanmar.webp" alt="Myanmar Telenor"></a><p class="wp-caption-text">Photo by Bjoertvedt. <a href="https://creativecommons.org/licenses/by-sa/4.0/deed.en">CC BY-SA 4.0</a></p></div>'
 const image=licensedArticleImage(caption,source)
 assert.equal(image?.provenance.license,'CC BY-SA')
 assert.match(image?.provenance.credit||'',/Photo by Bjoertvedt/)
 assert.equal(image?.provenance.imagePageUrl,'https://commons.wikimedia.org/wiki/File:Myanmar.jpg')
 assert.equal(licensedArticleImage(caption.replace('href="https://creativecommons.org/licenses/by-sa/4.0/deed.en"','href=" https://creativecommons.org/licenses/by-sa/4.0/deed.en"'),source)?.provenance.license,'CC BY-SA')
 assert.equal(licensedArticleImage(caption.replace('Photo by Bjoertvedt','Getty Images, fair use'),source),null)
 assert.equal(licensedArticleImage(caption.replace('https://creativecommons.org/licenses/by-sa/4.0/deed.en','https://creativecommons.org/licenses/by-nc/4.0/'),source),null)
 assert.equal(licensedArticleImage(caption.replace('https://creativecommons.org/licenses/by-sa/4.0/deed.en','https://creativecommons.org/licenses/by-sa/4.0/extra'),source),null)
})

test('publisher rejects unverified image, accepts a correctly credited first-page image',()=>{
 const licensedUrl='https://creativecommons.org/licenses/by/4.0/'
 const d={id:'a',title:'Verifiable source report',sourceId:'global-voices',sourceName:'Global Voices',sourceUrl:'https://globalvoices.org/2026/10/17/report/',rights:{textAllowed:true,mode:'gemini-eligible',licenseUrl:licensedUrl,license:'CC BY'},imageRightsVerified:true,imageUrl:'https://images.example.org/event.jpg',imageProvenance:{credit:'Photograph by Mira',license:'CC BY',licenseUrl:licensedUrl,sourceImageUrl:'https://globalvoices.org/2026/10/17/report/'},originalPublishedAt:'2026-10-17T00:00:00.000Z'}
 d.levelVariants=Object.fromEntries(['A1-A2','B1-B2','C1-C2'].map((lv,i)=>[lv,{pages:Array.from({length:4},(_,page)=>({text:`Verified information at ${lv} helps readers understand the situation and public reports in this carefully explained article section ${page}.`,image:page===0?d.imageUrl:'',caption:page===0?'Event photograph':'',...(page===0?{imageProvenance:d.imageProvenance}:{})})),keyVocabulary:[{word:'news',meaningVi:'tin'},{word:'report',meaningVi:'báo cáo'},{word:'event',meaningVi:'sự kiện'}],evidence:['Long source evidence example 1','Long source evidence example 2','Long source evidence example 3']}]))
 assert.deepEqual(validateDraft(d),[])
 const published=toReaderStory(d)
 assert.equal(published.levelVariants['B1-B2'].pages[0].image,d.imageUrl)
 assert.equal(published.levelVariants['B1-B2'].pages[0].imageProvenance.license,'CC BY')
 const unlicensed={...d,imageRightsVerified:false}
 assert.ok(validateDraft(unlicensed).includes('unverified-image'))
 const missingCredit=structuredClone(d)
 delete missingCredit.levelVariants['A1-A2'].pages[0].imageProvenance
 assert.ok(validateDraft(missingCredit).includes('photo-credit:A1-A2'))
 const qa=inspectStagedRelease({mode:'gemini-staging',publishEnabled:false,publicFilesChanged:false,completeThreeLevelDrafts:1},[missingCredit])
 assert.equal(qa.status,'BLOCKED')
 assert.ok(qa.issues.some(issue=>issue.includes('missing or mismatched image attribution')))
 const commons=structuredClone(d)
 commons.imageUrl='https://thumb.wikimedia.org/wikipedia/commons/thumb/a/ab/example.jpg/800px-example.jpg'
 commons.imageProvenance={credit:'Mira / Wikimedia Commons',license:'CC BY 4.0',licenseUrl:licensedUrl,
  sourceImageUrl:'https://commons.wikimedia.org/wiki/File:Example.jpg',imagePageUrl:'https://commons.wikimedia.org/wiki/File:Example.jpg',originType:'wikimedia-commons'}
 for(const variant of Object.values(commons.levelVariants))Object.assign(variant.pages[0],{image:commons.imageUrl,
  caption:'Illustrative image: Example',imageProvenance:commons.imageProvenance})
 assert.deepEqual(validateDraft(commons),[])
 assert.equal(inspectStagedRelease({mode:'gemini-staging',publishEnabled:false,publicFilesChanged:false,completeThreeLevelDrafts:1},[commons]).status,'PASS')
})

test('publisher preserves verified photographs on pages two and three',()=>{
 const source='https://globalvoices.org/2026/10/17/report/'
 const licenseUrl='https://creativecommons.org/licenses/by/4.0/'
 const photos=[0,1,2].map((index)=>({url:`https://images.example.org/photo-${index}.jpg`,verified:true,
  caption:`Illustrative image ${index}`,provenance:{credit:`Photographer ${index}`,license:'CC BY 4.0',licenseUrl,sourceImageUrl:source}}))
 const draft={id:'multi',title:'Verifiable source report',sourceId:'global-voices',sourceName:'Global Voices',sourceUrl:source,
  rights:{textAllowed:true,mode:'gemini-eligible',licenseUrl,license:'CC BY'},images:photos,
  imageUrl:photos[0].url,imageRightsVerified:true,imageProvenance:photos[0].provenance,
  levelVariants:Object.fromEntries(['A1-A2','B1-B2','C1-C2'].map(level=>[level,{
   pages:[...photos.map((photo,index)=>({text:`Verified ${level} report section ${index} explains the public event carefully with reliable context for readers.`,image:photo.url,
    caption:photo.caption,imageProvenance:photo.provenance})),{text:`Verified ${level} report section adds further factual context for readers of this public event.`,image:'',caption:''}],
   keyVocabulary:[{word:'news',meaningVi:'tin'},{word:'report',meaningVi:'báo cáo'},{word:'event',meaningVi:'sự kiện'}],
   evidence:['Long source evidence example 1','Long source evidence example 2','Long source evidence example 3']}]))}
 assert.deepEqual(validateDraft(draft),[])
 assert.equal(inspectStagedRelease({mode:'gemini-staging',publishEnabled:false,publicFilesChanged:false,completeThreeLevelDrafts:1},[draft]).status,'PASS')
 const published=toReaderStory(draft)
 assert.deepEqual(published.pages.map(page=>page.image),[...photos.map(photo=>photo.url),''])
 const tampered=structuredClone(draft)
 tampered.levelVariants['A1-A2'].pages[2].imageProvenance={...tampered.levelVariants['A1-A2'].pages[2].imageProvenance,
  licenseUrl:'https://creativecommons.org/licenses/by-nc/4.0/'}
 assert.ok(validateDraft(tampered).includes('photo-credit:A1-A2'))
})
