// DAILY NEWS V19: the compact visible caption is a photo NAME, never a license
// URL. Retain the original caption in full for the accessible credit disclosure.
const GENERIC = /^(wikipedia\s*\/\s*wikimedia commons|image from|photo (by|credit)|credits?|wikimedia commons|see original)/i

function decodedFileName(source) {
  if (!source) return ''
  try {
    const u = new URL(source)
    const path = decodeURIComponent(u.pathname.split('/').pop() || '').replace(/^\d+px-/, '')
    return path.replace(/\.(jpe?g|png|gif|webp|svg|tiff?|avif)$/i, '')
  } catch { return '' }
}

export function photoLabel(page) {
  if (!page?.image) return ''
  const original = String(page.caption || '').trim()
  const first = original.split(/\s[·|]\s/)[0].replace(/^File:/i, '').trim()
  const usable = first && !GENERIC.test(first) && !/^https?:\/\//.test(first)
  const filename = decodedFileName(page.image)
  const candidate = (usable ? first.replace(/\.(jpe?g|png|webp|gif|svg)$/i, '') : filename) || 'Article photograph'
  return candidate.replace(/_/g, ' ').replace(/\s+/g, ' ').slice(0, 150)
}

export function photoSourceLink(page) {
  if (!page?.image) return ''
  const credits = String(page.caption || '')
  const credited = credits.match(/Credits:\s*(https?:\/\/[^\s]+)/i)?.[1]
  if (credited) {
    try { const url = new URL(credited); if (url.protocol === 'https:' || url.protocol === 'http:') return url.href } catch { /* ignore */ }
  }
  try {
    const url = new URL(page.image)
    if (url.hostname === 'upload.wikimedia.org' || url.hostname === 'thumb.wikimedia.org') {
      const file = decodeURIComponent(url.pathname.split('/').pop() || '').replace(/^\d+px-/, '')
      if (file) return `https://commons.wikimedia.org/wiki/File:${encodeURIComponent(file).replace(/%2F/g, '/')}`
    }
  } catch { /* no trusted source URL */ }
  return ''
}


// Wikimedia moved thumbnails to thumb.wikimedia.org during 2026. Some
// networks or older URLs still work only on upload.wikimedia.org. Attempt
// both hosts for thumbnail URLs; never retry arbitrary third-party hosts.
export function photoCandidates(image) {
  if (!image) return []
  // Only our own shipped neutral source card may use a relative URL. Other
  // remote paths are rejected, preserving the V20 image security behavior.
  if (image === '/news-feed/source-card.svg') return [image]
  try {
    const original = new URL(image)
    if (original.protocol !== 'https:') return []
    const host = original.hostname
    const urls = [original.href]
    // Wikimedia Commons' supported redirect provides a filename-based
    // fallback independent of changing thumbnail domains or sizes.
    if (['thumb.wikimedia.org','upload.wikimedia.org'].includes(host)) {
      const match = original.pathname.match(/^\/wikipedia\/commons\/(?:thumb\/)?([0-9a-f])\/([0-9a-f]{2})\/([^/]+)(?:\/[^/]+)?$/i)
      if (match) {
        const [,one,two,file] = match
        const normalizedFile = decodeURIComponent(file)
        if (/\.(?:jpe?g|png|webp|gif)$/i.test(normalizedFile)) {
          const cleanName = encodeURIComponent(normalizedFile.replace(/ /g,'_'))
          urls.push(`https://commons.wikimedia.org/wiki/Special:Redirect/file/${cleanName}?width=960`)
          urls.push(`https://upload.wikimedia.org/wikipedia/commons/${one}/${two}/${file}`)
        }
        if (original.pathname.includes('/thumb/')) {
          const other = new URL(original.href)
          other.hostname = host === 'thumb.wikimedia.org' ? 'upload.wikimedia.org' : 'thumb.wikimedia.org'
          urls.splice(1,0,other.href)
        }
      }
    }
    return [...new Set(urls)].map(url => {
      const result = new URL(url)
      for(const key of [...result.searchParams.keys()]) if(/^utm_/i.test(key)) result.searchParams.delete(key)
      return result.href
    })
  } catch { return [] }
}
