/** SAGA Discover: three language versions of ONE news item.
 * The source URL/ID and reading history are shared by all versions.
 * No version gets a fabricated source image, attribution or reading marker.
 */
export const READING_LEVELS = Object.freeze(['A1-A2','B1-B2','C1-C2'])
export const READING_LEVEL_KEY = 'sagaDiscoverReadingLevelV1'
export const DEFAULT_READING_LEVEL = 'A1-A2'
export const isReadingLevel = value => READING_LEVELS.includes(value)
export function savedReadingLevel(storage) {
  try { const value=storage?.getItem(READING_LEVEL_KEY);return isReadingLevel(value)?value:DEFAULT_READING_LEVEL }
  catch { return DEFAULT_READING_LEVEL }
}
export function saveReadingLevel(storage,level) {
  if (!isReadingLevel(level))return false
  try {storage?.setItem(READING_LEVEL_KEY,level);return true} catch {return false}
}
export function hasLevelVariants(article) {
  return !!article?.levelVariants && READING_LEVELS.every(level => {
    const pages=article.levelVariants[level]?.pages
    return Array.isArray(pages)&&pages.length>=4&&pages.length<=6&&pages.every(p=>typeof p?.text==='string'&&p.text.trim().length>0)
  })
}
export function selectReadingLevel(article,level) {
  if(!article||!hasLevelVariants(article))return article
  const actual=isReadingLevel(level)?level:DEFAULT_READING_LEVEL
  const version=article.levelVariants[actual]
  // A measured (screen-paginated) version takes precedence over source paragraphs.
  const pages=article._levelPageCache?.[actual] || version.pages
  return {...article,
    title:article.title, // Preserve a stable source title for all three levels.
    pages, _sourcePages:version.pages,
    _selectedReadingLevel:actual, cefrLevel:actual,
  }
}
export function switchReadingLevel(article,level) {
  if(!hasLevelVariants(article)||!isReadingLevel(level))return article
  // Always keep the unmodified original versions in levelVariants.
  return selectReadingLevel(article,level)
}
export function cacheMeasuredLevelPages(article,level,pages) {
  if(!hasLevelVariants(article)||!isReadingLevel(level))return article
  return {...article,_levelPageCache:{...article._levelPageCache,[level]:pages}}
}
