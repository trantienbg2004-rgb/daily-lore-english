import test from 'node:test'
import assert from 'node:assert/strict'
import {source} from '../discover/sources/publicDomainReview.mjs'
import {parseFeed} from '../discover/rss.mjs'
import {isFocusedNews} from '../discover/newsFocus.mjs'
import {extractArticle} from '../discover/article.mjs'
import {rightsDecision} from '../discover/rights.mjs'
import {licensedArticleImages} from '../discover/licensedMedia.mjs'

const essayUrl='https://publicdomainreview.org/essay/example-history'
const collectionUrl='https://publicdomainreview.org/collection/example-object'
const words=Array.from({length:80},(_,i)=>`historical${i}`).join(' ')
const license='<div class="essay-license essay__content"><p>The text of this essay is published under a <a href="https://creativecommons.org/licenses/by-sa/4.0/">CC BY-SA</a> license.</p></div>'
const photo='<figure><img src="https://publicdomainreview.org/example.jpg" alt="Historic example"><figcaption>Historic example. <a href="https://creativecommons.org/licenses/by/4.0/">CC BY</a></figcaption></figure>'
const html=(notice=license)=>`<h1>Example history</h1><p class="byline">By <a>Researcher Name</a></p><div class="essay-body"><p>${words} first</p>${photo}<p>${words} second</p><p>${words} third</p></div><div class="essay-footer"><p>Notes that must not be extracted</p></div>${notice}`

test('only recent essay entries enter the history discovery queue',()=>{
 const xml=`<rss><channel><item><title>History of an event and its consequences</title><link>${essayUrl}</link><pubDate>Wed, 14 Oct 2026 11:56:00 GMT</pubDate></item><item><title>Historical object collection</title><link>${collectionUrl}</link><pubDate>Tue, 13 Oct 2026 11:56:00 GMT</pubDate></item></channel></rss>`
 const rows=parseFeed(xml,source,{now:new Date('2026-10-19'),maxItems:5})
 assert.equal(rows.length,2)
 assert.equal(isFocusedNews(rows[0]),true)
 assert.equal(isFocusedNews(rows[1]),false)
})

test('an individually licensed essay has extractable, attributed text but no automatically licensed photos',()=>{
 const article=extractArticle(html(),source.id)
 assert.equal(article.author,'Researcher Name')
 assert.equal(article.paragraphCount,3)
 assert.equal(article.text.includes('Notes that must not be extracted'),false)
 assert.equal(rightsDecision(source,article).license,'CC BY-SA 4.0')
 assert.deepEqual(licensedArticleImages(html(),essayUrl),[])
})

test('missing or restricted essay licence fails closed',()=>{
 assert.equal(rightsDecision(source,extractArticle(html(''),source.id)).textAllowed,false)
 assert.equal(rightsDecision(source,extractArticle(html(license.replace('/by-sa/4.0/','/by-nc/4.0/')),source.id)).textAllowed,false)
 assert.equal(rightsDecision(source,extractArticle(html().replace('Researcher Name',''),source.id)).textAllowed,false)
})
