const MEMORY_CACHE = new Map()
const SESSION_PREFIX = 'saga_full_article_v2:'

export const FULL_ARTICLE_MAX_WORDS = 2200
export const FULL_ARTICLE_TARGET_MIN_WORDS = 1800
export const FULL_ARTICLE_WPM = 220

export const BOILERPLATE_HEADINGS = new Set([
  'see also',
  'notes',
  'references',
  'further reading',
  'external links',
  'bibliography',
  'sources',
  'citations',
  'gallery',
  'notes and references',
  'explanatory notes',
  'footnotes',
])

export function isBoilerplateHeading(heading) {
  const normalized = String(heading || '')
    .trim()
    .replace(/\s+/g, ' ')
    .toLowerCase()
  return BOILERPLATE_HEADINGS.has(normalized)
}

export function countWords(text) {
  const trimmed = String(text || '').trim()
  if (!trimmed) return 0
  return trimmed.split(/\s+/).filter(Boolean).length
}

export function slugifySectionId(title, index) {
  const slug = String(title || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
  return `full-sec-${index}-${slug || 'section'}`
}

function splitParagraphs(lines) {
  return String(Array.isArray(lines) ? lines.join('\n') : lines || '')
    .split(/\r?\n+/)
    .map(line => line.trim().replace(/\s{2,}/g, ' '))
    .filter(Boolean)
}

function chunkWordCount(chunk) {
  return chunk.reduce(
    (sum, sec) => sum + sec.paragraphs.reduce((pSum, p) => pSum + countWords(p), 0),
    0
  )
}

/**
 * Parse Wikipedia plain-text (`explaintext=1`) into structured sections,
 * stripping trailing boilerplate/appendix sections and applying a smart
 * top-level section-boundary cap for comfortable mobile reading.
 */
export function parseWikipediaExtract(
  extractText,
  {
    title = '',
    description = '',
    maxWords = FULL_ARTICLE_MAX_WORDS,
    targetMinWords = FULL_ARTICLE_TARGET_MIN_WORDS,
  } = {}
) {
  const raw = String(extractText || '').replace(/\r\n?/g, '\n')
  const lines = raw.split('\n')

  const rawSections = []
  let current = {
    title: 'Introduction',
    level: 1,
    isIntro: true,
    lines: [],
  }

  const headingPattern = /^(={2,5})\s*(.+?)\s*\1\s*$/

  for (const line of lines) {
    const match = line.match(headingPattern)
    if (match) {
      const headingTitle = match[2].trim()
      if (isBoilerplateHeading(headingTitle)) {
        break
      }
      rawSections.push(current)
      const markerDepth = match[1].length
      current = {
        title: headingTitle,
        level: markerDepth <= 2 ? 2 : 3,
        isIntro: false,
        lines: [],
      }
    } else {
      current.lines.push(line)
    }
  }
  rawSections.push(current)

  // Build sections with parsed paragraphs; keep an empty level-2 heading only if
  // it introduces non-empty level-3 subsections immediately below it.
  const materialized = rawSections.map(sec => ({
    title: sec.title,
    level: sec.level,
    isIntro: sec.isIntro,
    paragraphs: splitParagraphs(sec.lines),
  }))

  const cleaned = []
  for (let i = 0; i < materialized.length; i += 1) {
    const sec = materialized[i]
    if (sec.paragraphs.length > 0) {
      cleaned.push(sec)
      continue
    }
    if (!sec.isIntro && sec.level === 2) {
      let hasChildContent = false
      for (let j = i + 1; j < materialized.length; j += 1) {
        if (materialized[j].level <= 2) break
        if (materialized[j].paragraphs.length > 0) {
          hasChildContent = true
          break
        }
      }
      if (hasChildContent) cleaned.push(sec)
    }
  }

  // Group into top-level chunks (intro or level 2 + its level 3 subsections)
  const topChunks = []
  for (const sec of cleaned) {
    if (topChunks.length === 0 || sec.level <= 2) {
      topChunks.push([sec])
    } else {
      topChunks[topChunks.length - 1].push(sec)
    }
  }

  const totalSourceWords = topChunks.reduce((sum, chunk) => sum + chunkWordCount(chunk), 0)

  let keptChunks = topChunks
  let isExcerpt = false

  if (totalSourceWords > maxWords && topChunks.length > 1) {
    isExcerpt = true
    const selected = []
    let wordsSoFar = 0

    for (let i = 0; i < topChunks.length; i += 1) {
      const chunk = topChunks[i]
      const cWords = chunkWordCount(chunk)

      if (i === 0) {
        selected.push(chunk)
        wordsSoFar += cWords
        continue
      }

      if (wordsSoFar + cWords <= maxWords) {
        selected.push(chunk)
        wordsSoFar += cWords
        continue
      }

      if (wordsSoFar >= targetMinWords) {
        break
      }

      // Between 0 and targetMinWords: include this full top-level section only if
      // doing so lands closer to [targetMinWords, maxWords] without wildly overshooting,
      // or if the intro alone is very short (< 350 words).
      const underBy = targetMinWords - wordsSoFar
      const overBy = wordsSoFar + cWords - maxWords
      if ((wordsSoFar < 350 && selected.length === 1) || (overBy <= underBy && overBy <= 450)) {
        selected.push(chunk)
        wordsSoFar += cWords
      }
      break
    }

    keptChunks = selected
  }

  const sections = keptChunks.flat().map((sec, idx) => ({
    id: slugifySectionId(sec.isIntro ? 'intro' : sec.title, idx),
    title: sec.title,
    level: sec.level,
    isIntro: Boolean(sec.isIntro),
    paragraphs: sec.paragraphs,
  }))

  const wordCount = sections.reduce(
    (sum, sec) => sum + sec.paragraphs.reduce((pSum, p) => pSum + countWords(p), 0),
    0
  )
  const readMinutes = Math.max(1, Math.round(wordCount / FULL_ARTICLE_WPM))
  const cleanDescription = String(description || '').trim()

  return {
    title: String(title || '').trim(),
    description: cleanDescription,
    sections,
    wordCount,
    readMinutes,
    isExcerpt,
    totalSourceWords,
  }
}

/**
 * Cap right-edge minimap ticks cleanly to at most `maxTicks` rendered sections
 * (Intro plus all level-2 and level-3 headings), always preserving first and last.
 */
export function selectMinimapSections(sections, maxTicks = 16) {
  const eligible = (Array.isArray(sections) ? sections : []).filter(
    sec => sec && (sec.isIntro || sec.level === 2 || sec.level === 3)
  )
  if (eligible.length <= maxTicks) return eligible
  const result = []
  const lastIndex = eligible.length - 1
  for (let i = 0; i < maxTicks; i += 1) {
    const pick = Math.round((i * lastIndex) / (maxTicks - 1))
    result.push(eligible[pick])
  }
  return result
}

export function buildWikipediaApiUrl({ sourceTitle, sourcePageId } = {}) {
  const cleanTitle = String(sourceTitle || '').trim()
  const base =
    'https://en.wikipedia.org/w/api.php?action=query&prop=extracts|description&explaintext=1&redirects=1&format=json&formatversion=2&origin=*'
  if (cleanTitle) {
    return `${base}&titles=${encodeURIComponent(cleanTitle)}`
  }
  const numericId = Number(sourcePageId)
  if (Number.isFinite(numericId) && numericId > 0) {
    return `${base}&pageids=${encodeURIComponent(String(Math.trunc(numericId)))}`
  }
  return ''
}

function makeCacheKey({ sourceTitle, sourcePageId } = {}) {
  const cleanTitle = String(sourceTitle || '').trim()
  if (cleanTitle) return `title:${cleanTitle.toLowerCase()}`
  const numericId = Number(sourcePageId)
  if (Number.isFinite(numericId) && numericId > 0) return `pageid:${Math.trunc(numericId)}`
  return ''
}

function readSessionCache(cacheKey) {
  if (!cacheKey || typeof sessionStorage === 'undefined') return null
  try {
    const raw = sessionStorage.getItem(SESSION_PREFIX + cacheKey)
    if (!raw) return null
    const parsed = JSON.parse(raw)
    if (parsed && Array.isArray(parsed.sections) && parsed.sections.length > 0) {
      return parsed
    }
  } catch {
    // Ignore storage unavailability or quota errors
  }
  return null
}

function writeSessionCache(cacheKey, value) {
  if (!cacheKey || typeof sessionStorage === 'undefined') return
  try {
    sessionStorage.setItem(SESSION_PREFIX + cacheKey, JSON.stringify(value))
  } catch {
    // Ignore storage unavailability or quota errors
  }
}

export function clearFullArticleCache() {
  MEMORY_CACHE.clear()
  if (typeof sessionStorage !== 'undefined') {
    try {
      const keysToRemove = []
      for (let i = 0; i < sessionStorage.length; i += 1) {
        const key = sessionStorage.key(i)
        if (key && key.startsWith(SESSION_PREFIX)) keysToRemove.push(key)
      }
      keysToRemove.forEach(k => sessionStorage.removeItem(k))
    } catch {
      // Ignore
    }
  }
}

export async function fetchFullArticle({ sourceTitle, sourcePageId, title = '', signal } = {}) {
  const cacheKey = makeCacheKey({ sourceTitle, sourcePageId })
  if (cacheKey && MEMORY_CACHE.has(cacheKey)) {
    return MEMORY_CACHE.get(cacheKey)
  }
  const sessionHit = readSessionCache(cacheKey)
  if (sessionHit) {
    MEMORY_CACHE.set(cacheKey, sessionHit)
    return sessionHit
  }

  const url = buildWikipediaApiUrl({ sourceTitle, sourcePageId })
  if (!url) {
    throw new Error('Missing Wikipedia source identifier')
  }

  // IMPORTANT: Do NOT set custom headers (no User-Agent / Api-User-Agent)
  // so browsers perform a simple CORS request without preflight failure.
  const response = await fetch(url, { signal })
  if (!response.ok) {
    throw new Error(`Wikipedia request failed (${response.status})`)
  }

  const data = await response.json()
  const page = data?.query?.pages?.[0]
  if (!page || page.missing || !String(page.extract || '').trim()) {
    throw new Error('Full Wikipedia article text unavailable')
  }

  const parsed = parseWikipediaExtract(page.extract, {
    title: page.title || title || sourceTitle || '',
    description: page.description || '',
  })

  if (!parsed.sections.length) {
    throw new Error('Parsed article has no readable sections')
  }

  if (cacheKey) {
    MEMORY_CACHE.set(cacheKey, parsed)
    writeSessionCache(cacheKey, parsed)
  }

  return parsed
}
