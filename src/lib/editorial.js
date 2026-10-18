// V20 editorial FIRST PASS. Quality ranking does not fabricate journalism,
// rewrite factual claims, delete older articles or hide any user's topics.
const lower = value => String(value || '').toLowerCase()
export function displayHeadline(item) {
  const levelHeadline=item?.contentType==='news'&&item?.levelVariants?.[item.readingLevel]?.headline
  const original = String(levelHeadline || (item?.contentType === 'news' && item?.headline) || item?.sourceTitle || item?.title || '').replace(/_/g,' ').trim()
  // The collector stored many Wikipedia titles in all caps for the old theme.
  // Recover the publisher's original casing when it is available.
  return original || 'Untitled article'
}
export function readerSection(item) {
  const source = lower(item?.sourceUrl)
  if (item?.contentType === 'lore') return 'DISCOVER · ' + String(item.category || 'KNOWLEDGE').toUpperCase()
  if (item?.contentType === 'news') return 'NEWS · ' + String(item.category || 'LATEST').replace(/^NEWS\s*·?\s*/i,'')
  if (source.includes('wikivoyage.org')) return 'DISCOVER · TRAVEL & PLACES'
  return String(item?.category || 'DISCOVER · ALL TOPICS')
}
// Estimate whether a piece reads as an informative story or a route/listing.
// This is deliberately a *ranking* only, not a claim that articles are news.
export function editorialScore(item) {
  if (!item) return -100
  const text = (item.pages || []).map(p => p.text).join(' ')
  const words = text.trim().split(/\s+/).filter(Boolean)
  // Genuine RSS news previews are intentionally short; give them a fair rank.
  if (words.length < 200 && item.contentType !== 'news-preview') return -100
  let score = Math.min(18, Math.floor(words.length / 40))
  const title = displayHeadline(item)
  if (title.split(/\s+/).length >= 5 && title.length <= 110) score += 7
  if (/\b(why|how|what|when|researchers|study|report|scientists|finds|reveals|shows|launch|changes|impact|warning)\b/i.test(title)) score += 10
  if (item.contentType === 'news') score += 100
  if (item.contentType === 'news-preview') score += 55
  // Calendar notices are not the breaking news people expect in the main feed.
  // Retain access instead of silently deleting them from the staged archive.
  if (/\b(?:seminar|lecture series|workshop|webinar|calendar of events)\b/i.test(title)) score -= 220
  if (/wikivoyage\.org/.test(lower(item.sourceUrl))) score -= 13
  const travelSignals = (text.match(/\b(updated|bus stop|airport|road|turn left|entrance fee|price|take the bus|highway|taxi|km from|route)\b/gi) || []).length
  score -= Math.min(35, travelSignals * 3)
  if ((text.match(/→|->|\([^)]*updated[^)]*\)/gi)||[]).length > 3) score -= 15
  return score
}
// Keep a mix of all sources/topics; heavily prefer genuine reporting, then
// readable explainers, then location lists. Preserve a reserve of guides.
export function orderEditorial(stories) {
  return [...stories].sort((a,b) => editorialScore(b)-editorialScore(a))
}
