/** V22-D1: broad global news DISCOVERY ONLY.
 * Publisher RSS feeds announce original stories; an RSS link NEVER grants
 * permission to republish its full body, image, or AI-derived substitute.
 * A failed feed is a diagnostic, not evidence that a publisher is broken.
 */
const source=(publisher,host,topic,feed,linkHosts=[host])=>({publisher,host,topic,feed,linkHosts,contentPolicy:'link-only'})
export const WORLD_TOPICS=Object.freeze(['World','Politics','Economy','Business','Technology','Science','Health','Environment','Society','Culture','Sports'])
export const WORLD_SOURCES=Object.freeze([
 source('BBC News','bbc.com','World','https://feeds.bbci.co.uk/news/world/rss.xml',['bbc.com','bbc.co.uk']),
 source('BBC News','bbc.com','Business','https://feeds.bbci.co.uk/news/business/rss.xml',['bbc.com','bbc.co.uk']),
 source('BBC News','bbc.com','Politics','https://feeds.bbci.co.uk/news/politics/rss.xml',['bbc.com','bbc.co.uk']),
 source('BBC News','bbc.com','Technology','https://feeds.bbci.co.uk/news/technology/rss.xml',['bbc.com','bbc.co.uk']),
 source('BBC News','bbc.com','Science','https://feeds.bbci.co.uk/news/science_and_environment/rss.xml',['bbc.com','bbc.co.uk']),
 source('The Guardian','theguardian.com','World','https://www.theguardian.com/world/rss'),
 source('The Guardian','theguardian.com','Politics','https://www.theguardian.com/politics/rss'),
 source('The Guardian','theguardian.com','Economy','https://www.theguardian.com/business/economics/rss'),
 source('The Guardian','theguardian.com','Business','https://www.theguardian.com/business/rss'),
 source('The Guardian','theguardian.com','Technology','https://www.theguardian.com/technology/rss'),
 source('The Guardian','theguardian.com','Environment','https://www.theguardian.com/environment/rss'),
 source('The Guardian','theguardian.com','Sports','https://www.theguardian.com/sport/rss'),
 source('Sky News','news.sky.com','World','https://feeds.skynews.com/feeds/rss/world.xml'),
 source('Sky News','news.sky.com','Politics','https://feeds.skynews.com/feeds/rss/politics.xml'),
 source('Sky News','news.sky.com','Business','https://feeds.skynews.com/feeds/rss/business.xml'),
 source('Sky News','news.sky.com','Technology','https://feeds.skynews.com/feeds/rss/technology.xml'),
 source('Al Jazeera English','aljazeera.com','World','https://www.aljazeera.com/xml/rss/all.xml'),
 source('NPR','npr.org','World','https://feeds.npr.org/1004/rss.xml'),
 source('NPR','npr.org','Economy','https://feeds.npr.org/1006/rss.xml'),
 source('NPR','npr.org','Health','https://feeds.npr.org/1128/rss.xml'),
 source('The New York Times','nytimes.com','World','https://rss.nytimes.com/services/xml/rss/nyt/World.xml'),
 source('The New York Times','nytimes.com','Business','https://rss.nytimes.com/services/xml/rss/nyt/Business.xml'),
 source('The New York Times','nytimes.com','Technology','https://rss.nytimes.com/services/xml/rss/nyt/Technology.xml'),
 source('Global Voices','globalvoices.org','Society','https://globalvoices.org/feed/'),
 source('The Conversation','theconversation.com','Society','https://theconversation.com/articles.atom'),
 source('TechCrunch','techcrunch.com','Technology','https://techcrunch.com/feed/'),
 source('UN News','news.un.org','World','https://news.un.org/feed/subscribe/en/news/all/rss.xml'),
])
export function safeWorldUrl(raw,allowedHosts){
 try{
  const u=new URL(String(raw||'').trim())
  if(u.protocol!=='https:'||u.username||u.password||u.port)return ''
  if(!allowedHosts.some(host=>u.hostname===host||u.hostname.endsWith('.'+host)))return ''
  u.hash='';u.pathname=u.pathname.replace(/\/{2,}/g,'/').replace(/\/$/,'')||'/'
  for(const key of [...u.searchParams.keys()])if(/^(utm_.+|fbclid|gclid|mc_cid|mc_eid)$/i.test(key))u.searchParams.delete(key)
  return u.href
 }catch{return ''}
}
