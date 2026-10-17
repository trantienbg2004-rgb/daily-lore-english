// UN News may supply discovery metadata. Its article text and photographs
// require separate permission, so this source never enters Gemini staging.
export const source = Object.freeze({
 id:'un-news',name:'UN News',feedUrls:['https://news.un.org/feed/subscribe/en/news/all/rss.xml'],
 hosts:['news.un.org'],fetchFullText:false,rightsPolicy:'metadata-only-permission-required',
 policyUrl:'https://www.un.org/en/about-us/copyright/'
})
