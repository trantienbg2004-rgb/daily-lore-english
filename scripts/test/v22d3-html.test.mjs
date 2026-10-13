import test from 'node:test'
import assert from 'node:assert/strict'
import {readingParagraphs,extractGlobalVoicesAuthor,htmlReadingDiagnostics} from '../lib/v22d3-html.mjs'
import {parseLicensedGlobalVoices} from '../lib/v22d2-licensed.mjs'
const now=new Date('2026-10-13T12:00:00Z')
const story={publisher:'Global Voices',sourceUrl:'https://globalvoices.org/2026/10/12/young-people-study-civic-participation/',title:'Young people study civic participation and public institutions',publishedAt:'2026-10-12T10:00:00Z'}
const paragraph=n=>`Residents and local educators in the community described the public discussion during the week of the conference. The civic group published a detailed timeline for the neighborhood project and explained what happened before and after the public meeting numbered ${n}. Organizers said the next meeting would include more independent observers and students.`
const paragraphs=Array.from({length:10},(_,i)=>`<p>${paragraph(i)}</p>`).join('')
const license='<footer>This site is licensed as Creative Commons Attribution 3.0 https://creativecommons.org/licenses/by/3.0/</footer>'
const layout=({bodyTag='div',bodyClass='entry-content',author='<div class="byline">Written by <a rel="author">Mong Palatino</a></div>',body=paragraphs}={})=>`<!doctype html><html><head><title>World stories</title></head><body>
<header><p>${paragraph(40)}</p></header><nav><p>${paragraph(41)}</p></nav>
<div class="layout"><div class="sidebar"><p>${paragraph(42)}</p></div>
<h1>Young people study civic participation</h1>${author}
<${bodyTag} class="${bodyClass}"><p>${paragraph(0)}</p><div class="share"><p>${paragraph(43)}</p></div>${body}<aside><p>${paragraph(44)}</p></aside><div class="related-articles"><p>${paragraph(45)}</p></div></${bodyTag}>
<section class="more-stories"><p>${paragraph(46)}</p></section></div>
${license}</body></html>`
test('realistic Global Voices entry-content div is accepted with visible byline',()=>{
 const html=layout()
 assert.equal(extractGlobalVoicesAuthor(html),'Mong Palatino')
 const result=parseLicensedGlobalVoices(html,story,{now})
 assert.ok(result.article,result.reason)
 assert.equal(result.article.author,'Mong Palatino')
 assert.equal(result.article.image,'')
 assert.ok(result.article.sourceWords>=240)
 assert.ok(!result.article.pages.map(p=>p.text).join(' ').includes('numbered 45'))
 assert.ok(result.article.pages.length>=2)
})
test('articleBody JSON-LD author + section body works',()=>{
 const data=JSON.stringify({'@context':'https://schema.org','@type':'NewsArticle',author:{'@type':'Person',name:'Nadia Reporter'},headline:story.title})
 const html=layout({bodyTag:'section',bodyClass:'article-body',author:`<script type="application/ld+json">${data}</script>`})
 assert.equal(extractGlobalVoicesAuthor(html),'Nadia Reporter')
 assert.ok(parseLicensedGlobalVoices(html,story,{now}).article)
})
test('main without article tag can still contain editorial paragraphs',()=>{
 const html=layout({bodyTag:'main',bodyClass:'body'})
 assert.ok(readingParagraphs(html).length>=10)
})
test('no article or main or named article body never crawls an arbitrary page',()=>{
 const html=layout({bodyTag:'div',bodyClass:'layout-wrapper'})
 assert.deepEqual(readingParagraphs(html),[])
 assert.equal(parseLicensedGlobalVoices(html,story,{now}).reason,'main-text-not-found')
})
test('blocks footer, long related stories and sidebar even inside <main>',()=>{
 const html=`<main><div class="post-content">${paragraphs}<div class="newsletter">${paragraphs}</div><div class="related-posts">${paragraphs}</div></div></main>${license}`
 assert.equal(readingParagraphs(html).length,10)
})
test('generic staff byline does not impersonate a credited author',()=>{
 const html=layout({author:'<meta name="author" content="Global Voices"/><div class="byline">Written by <a rel="author">Guest Contributor</a></div>'})
 assert.equal(extractGlobalVoicesAuthor(html),'')
 assert.equal(parseLicensedGlobalVoices(html,story,{now}).reason,'author-unverified')
})
test('diagnostics report markup shape but never include paragraph text',()=>{
 const result=htmlReadingDiagnostics(layout())
 assert.ok(result.paragraphs>=10)
 assert.ok(result.articleParagraphs>=10)
 assert.equal(result.authorFound,true)
 assert.equal(JSON.stringify(result).includes('Residents'),false)
})
test('license check remains mandatory with new HTML body parser',()=>{
 const html=layout().replace(license,'')
 assert.equal(parseLicensedGlobalVoices(html,story,{now}).reason,'license-not-confirmed')
})
