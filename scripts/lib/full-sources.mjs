/** V22-C.4: trusted English-language publishers and clear reuse policies.
 * Links are publisher endpoints; runtime must still validate
 * publisher attribution, actual rights, reachability and article length.
 * RSS is discovery only — RSS summaries are NEVER a reading article.
 */
const government=(id,feed,host,category,license,extra={})=>({id,feed,host,category,license,mode:'government-original',...extra})
// V22-C.4: Favor accessible editorial archives rather than repeatedly querying
// known blocked/obsolete endpoints. Distinct sites do not always mean distinct publishers.
export const FULL_SOURCES=Object.freeze([
 government('NASA','https://www.nasa.gov/news-release/feed/','nasa.gov','SCIENCE & SPACE','https://www.nasa.gov/nasa-brand-center/images-and-media/'),
 government('NASA Earth Observatory','https://science.nasa.gov/earth/earth-observatory/image-of-the-day/','nasa.gov','ENVIRONMENT','https://science.nasa.gov/blogs/earth-matters/2012/04/10/share-and-share-alike/',{publisher:'NASA',mode:'listing',archiveFeeds:['https://science.nasa.gov/earth/earth-observatory/search/'],articlePath:/^\/earth\/earth-observatory\/(?!image-of-the-day\/?$|subscribe\/?$|search\/?$)[a-z0-9-]+\/?$/i}),
 government('U.S. Department of Energy','https://www.energy.gov/listings/energy-news','energy.gov','ENERGY & TECHNOLOGY','https://www.energy.gov/web-policies'),
 government('NOAA','https://www.noaa.gov/news-features','noaa.gov','ENVIRONMENT','https://library.noaa.gov/blogs/news-research-highlights',{mode:'listing',articlePath:/^\/(?:stories|news-release|features|news-features)\/[a-z0-9-]+\/?$/i}),
 government('FDA','https://www.fda.gov/news-events/fda-newsroom/press-announcements','fda.gov','HEALTH & SCIENCE','https://www.fda.gov/about-fda/website-policies',{fallbackFeed:'https://www.fda.gov/news-events',mode:'listing',archiveFeeds:[1,2,3].map(page=>`https://www.fda.gov/news-events/fda-newsroom/press-announcements?page=${page}`),articlePath:/^\/news-events\/press-announcements\/[a-z0-9-]+\/?$/i}),
 government('CDC','https://www.cdc.gov/media/releases/index.html','cdc.gov','HEALTH','https://www.cdc.gov/other/agencymaterials.html',{mode:'listing',articlePath:/^\/media\/releases\/20\d\d\/[^/]+\.html$/i}),
 {id:'Global Voices',publisher:'Global Voices',feed:'https://globalvoices.org/feed/',fallbackFeed:'https://globalvoices.org/',host:'globalvoices.org',category:'WORLD & CULTURE',license:'https://creativecommons.org/licenses/by/3.0/',mode:'rss',licenseKind:'cc-by-3',articlePath:/^\/20\d\d\/\d\d\/\d\d\/[^/]+\/?$/i},
])
// Legacy sources remain available for diagnosis; none may be claimed as working
// solely because an endpoint was configured. Explicit opt-in only.
export const LEGACY_SOURCES=Object.freeze([
 government('NOAA','https://oceanservice.noaa.gov/rss/nosnews.xml','noaa.gov','ENVIRONMENT','https://www.noaa.gov/office-education/outreach-communication/faq',{hosts:['oceanservice.noaa.gov']}),
 government('USGS','https://www.usgs.gov/news/national-news-release/feed','usgs.gov','EARTH & SCIENCE','https://www.usgs.gov/information-policies-and-instructions/copyrights-and-credits'),
 government('NIH News in Health','https://newsinhealth.nih.gov/','newsinhealth.nih.gov','HEALTH','https://newsinhealth.nih.gov/about-us',{mode:'nih-archive'}),
 government('NSF','https://www.nsf.gov/rss/rss_www_news.xml','nsf.gov','SCIENCE & EDUCATION','https://www.nsf.gov/rss'),
 government('NIST','https://www.nist.gov/news-events/news/rss.xml','nist.gov','TECHNOLOGY','https://www.nist.gov/coo/nist-rss-feeds'),
 government('EIA','https://www.eia.gov/rss/todayinenergy.xml','eia.gov','BUSINESS & ENERGY','https://www.eia.gov/about/copyrights_reuse.php'),
 government('EPA','https://www.epa.gov/newsreleases/search/rss','epa.gov','ENVIRONMENT','https://www.epa.gov/newsroom'),
 government('USDA','https://www.nass.usda.gov/rss/news.xml','usda.gov','BUSINESS & AGRICULTURE','https://www.nass.usda.gov/Newsroom/Syndication/News/index.php',{hosts:['nass.usda.gov','data.nass.usda.gov']}),
])
// Candidate syndication sites requiring separate legal review (not active).
export const LICENSE_REVIEW_SOURCES=Object.freeze([
 {id:'Mongabay',site:'https://news.mongabay.com/',policy:'https://news.mongabay.com/copyright/creative-commons/',reason:'CC BY-ND: preserve article hyperlinks, original text, credits, and check per-photo rights'},
])
export function safePublisherLink(link,source){
 try{const u=new URL(String(link||'').trim());const allow=[source.host,...(source.hosts||[])];if(u.protocol!=='https:'||u.username||u.password||u.port||!allow.some(h=>u.hostname===h||u.hostname.endsWith('.'+h)))return '';u.hash='';for(const k of [...u.searchParams.keys()])if(/^utm_|^fbclid$|^gclid$/i.test(k))u.searchParams.delete(k);return u.href}catch{return ''}
}
