// DAILY NEWS V19: the compact visible caption is a photo NAME, never a license
// URL. Retain the original caption in full for the accessible credit disclosure.
const GENERIC = /^(wikipedia\s*\/\s*wikimedia commons|image from|photo (by|credit)|credits?|wikimedia commons|see original)/i

function decodedFileName(source) {
  if (!source) return ''
  try {
    const u = new URL(source)
    const path = decodeURIComponent(u.pathname.split('/').pop() || '')
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
    if (url.hostname === 'upload.wikimedia.org') {
      const file = decodeURIComponent(url.pathname.split('/').pop() || '')
      if (file) return `https://commons.wikimedia.org/wiki/File:${encodeURIComponent(file).replace(/%2F/g, '/')}`
    }
  } catch { /* no trusted source URL */ }
  return ''
}
