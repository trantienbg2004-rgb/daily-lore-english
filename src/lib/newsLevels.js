/** Stable, optional 3-level adaptation. Lore articles remain unchanged. */
export const NEWS_LEVELS=['A1-A2','B1-B2','C1-C2']
export const NEWS_LEVEL_KEY='saga-reading-level'
export function isNewsLevel(value){return NEWS_LEVELS.includes(value)}
export function loadNewsLevel(storage){try{const value=storage?.getItem(NEWS_LEVEL_KEY);return isNewsLevel(value)?value:'B1-B2'}catch{return 'B1-B2'}}
export function applyNewsLevel(item,level){const pages=item?.levelVariants?.[level]?.pages;return Array.isArray(pages)&&pages.length>=1?{...item,readingLevel:level,pages:pages.map(p=>({...p}))}:item}
