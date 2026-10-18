import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import {rssImageHints,articleImageHint,licensedArticleImage,licensedArticleImages} from '../discover/licensedMedia.mjs'
import {validateDraft,toReaderStory} from '../discover/bridge.mjs'
import {inspectStagedRelease} from '../discover-live-qa.mjs'

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
