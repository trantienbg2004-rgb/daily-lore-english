import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import {rssImageHints,articleImageHint,licensedArticleImage} from '../discover/licensedMedia.mjs'
import {validateDraft,toReaderStory} from '../discover/bridge.mjs'

const app=fs.readFileSync('src/App.jsx','utf8'),css=fs.readFileSync('src/App.css','utf8')

test('reading level and read-aloud buttons share a non-overlapping semantic header',()=>{
 assert.match(app,/<header className="topbar lore-reader-topbar">/)
 assert.match(app,/saga-toolbar-story/)
 assert.match(app,/saga-toolbar-audio/)
 assert.match(css,/\.saga-toolbar-story\s*\{[\s\S]*?min-width:0;[\s\S]*?text-overflow:ellipsis/)
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

test('publisher rejects unverified image, accepts a correctly credited first-page image',()=>{
 const licensedUrl='https://creativecommons.org/licenses/by/4.0/'
 const d={id:'a',title:'Verifiable source report',sourceId:'global-voices',sourceName:'Global Voices',sourceUrl:'https://globalvoices.org/2026/10/17/report/',rights:{textAllowed:true,mode:'gemini-eligible',licenseUrl:licensedUrl,license:'CC BY'},imageRightsVerified:true,imageUrl:'https://images.example.org/event.jpg',imageProvenance:{credit:'Photograph by Mira',license:'CC BY',licenseUrl:licensedUrl,sourceImageUrl:'https://globalvoices.org/2026/10/17/report/'},originalPublishedAt:'2026-10-17T00:00:00.000Z'}
 d.levelVariants=Object.fromEntries(['A1-A2','B1-B2','C1-C2'].map((lv,i)=>[lv,{pages:[{text:'Verified information '+lv+' helps readers understand the situation and public reports.',image:d.imageUrl,caption:'Event photograph',imageProvenance:d.imageProvenance}],keyVocabulary:[{word:'news',meaningVi:'tin'},{word:'report',meaningVi:'báo cáo'},{word:'event',meaningVi:'sự kiện'}],evidence:['Long source evidence example 1','Long source evidence example 2','Long source evidence example 3']}]))
 assert.deepEqual(validateDraft(d),[])
 const published=toReaderStory(d)
 assert.equal(published.levelVariants['B1-B2'].pages[0].image,d.imageUrl)
 assert.equal(published.levelVariants['B1-B2'].pages[0].imageProvenance.license,'CC BY')
 const unlicensed={...d,imageRightsVerified:false}
 assert.ok(validateDraft(unlicensed).includes('unverified-image'))
})
