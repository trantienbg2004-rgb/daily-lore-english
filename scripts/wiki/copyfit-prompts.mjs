// Gemini prompt blocks and schemas for Page Contract v1 (copyfit by lines).
// The model never counts characters: it gets word targets derived from line
// budgets, and the meter sends back concrete "+N words / -N words" requests.
import {PAGE_CONTRACT, LEVELS, wordBudgets} from '../../src/lib/pageContract.js'

export const FOCUS_ITEM_SCHEMA = {
  type: 'object',
  properties: {
    surface: {type: 'string'},
    ipa: {type: 'string'},
    vi: {type: 'string'},
  },
  required: ['surface', 'ipa', 'vi'],
}

/** Add `focus` to the page schema used by buildBatchPrompt's response schema. */
export function withFocus(pageSchema) {
  return {
    ...pageSchema,
    properties: {...pageSchema.properties, focus: {type: 'array', items: FOCUS_ITEM_SCHEMA}},
    required: [...new Set([...(pageSchema.required || []), 'focus'])],
  }
}

/**
 * Replaces ADAPTIVE_MAP_GUIDANCE + EDITORIAL_CARD_GUIDANCE/measuredGuidance in
 * buildBatchPrompt when the article is generated for Page Contract v1.
 */
export function copyfitGenerationRules() {
  const wb = wordBudgets()
  const c = PAGE_CONTRACT
  const perLevel = LEVELS.map(level => {
    const {cover, inner} = wb[level]
    return `  * ${level}: page 1 body ${cover.target} words (${cover.min}–${cover.max}); every other page ${inner.target} words (${inner.min}–${inner.max}).`
  }).join('\n')
  return [
    'PAGE PLAN (shared by all three versions)',
    `- First plan ${c.pages.newArticles.join(' or ')} "beats" for the whole story. Each beat is one page. All three versions use the SAME number of pages and cover the SAME beat on the SAME page, each at its own depth.`,
    '- The same imageId (or null) sits at the same page index in all three versions. Page 1 always has the verified lead photo. Use a body photo only if it shows the subject of that exact beat.',
    '- A page without a photo is NOT a text-only page: it shows a vocabulary card in the photo slot, so its text is exactly as long as a photo page.',
    '',
    'COPYFIT (text length is a layout constraint, not a CEFR rule)',
    '- Every page body is written to a word target. Targets per version:',
    perLevel,
    '- Write exactly 2 short paragraphs per page, separated by a blank line. Each paragraph ends with a complete sentence.',
    '- If a beat has more facts than fit, keep the most important ones; never squeeze by removing articles or punctuation. If it has fewer, explain a cited fact more concretely; never add filler or repeat earlier pages.',
    '- Do NOT count characters. A layout meter measures every page afterwards and will ask for "add about N words" or "cut about N words" where needed.',
    `- Headline: at most ${c.titleFont.hintMaxChars} characters including spaces (it must fit 2 lines). Caption: one noun phrase of at most ${c.caption.maxChars} characters, no full stop. Pages without a photo use an empty caption.`,
    '',
    'FOCUS WORDS (shown on the vocabulary card)',
    `- On EVERY page add "focus": exactly ${c.focus.count} words or short phrases copied verbatim from that page's text, useful for this level.`,
    `- Each item: {"surface": exact text as it appears (≤ ${c.focus.maxSurfaceChars} characters), "ipa": "/…/" (≤ ${c.focus.maxIpaChars} characters), "vi": short Vietnamese meaning that fits this sentence (≤ ${c.focus.maxViChars} characters)}.`,
  ].join('\n')
}

/** Response schema for a copyfit rewrite: only the named pages/fields. */
export const COPYFIT_REWRITE_SCHEMA = {
  type: 'object',
  properties: {
    edits: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          level: {type: 'string', enum: LEVELS},
          page: {type: 'integer'},
          field: {type: 'string', enum: ['text', 'caption', 'headline', 'focus']},
          value: {type: 'string'},
          evidenceIds: {type: 'array', items: {type: 'string'}},
          focus: {type: 'array', items: FOCUS_ITEM_SCHEMA},
        },
        required: ['level', 'page', 'field'],
      },
    },
  },
  required: ['edits'],
}

/**
 * Targeted rewrite prompt built from meter.audit() output.
 * `audit` is the array returned by meter.audit (strings) with .rewrites.
 */
export function buildCopyfitRewritePrompt({source, evidence, draft, audit}) {
  const rewrites = audit?.rewrites || []
  const titleOrCaption = [...(audit || [])].filter(e => /headline:|caption:/.test(e))
  const tasks = []
  for (const r of rewrites) {
    const page = draft.variants[r.level].pages[r.index]
    tasks.push({
      level: r.level,
      page: r.index + 1,
      field: 'text',
      instruction: r.message,
      targetWords: r.targetWords,
      currentText: page.text,
      evidenceIds: page.evidenceIds,
    })
  }
  for (const e of [...(audit || [])].filter(x => / focus/.test(x))) {
    const m = e.match(/^(A1-A2|B1-B2|C1-C2) page (\d+) focus/)
    if (!m || tasks.some(t => t.level === m[1] && t.page === Number(m[2]) && t.field === 'focus')) continue
    const page = draft.variants[m[1]].pages[Number(m[2]) - 1]
    tasks.push({
      level: m[1],
      page: Number(m[2]),
      field: 'focus',
      instruction: `Give exactly ${PAGE_CONTRACT.focus.count} focus items copied verbatim from this page's text (the final text if you also edit it).`,
      currentText: page.text,
    })
  }
  for (const e of titleOrCaption) {
    const m = e.match(/^(A1-A2|B1-B2|C1-C2)(?: page (\d+))? (headline|caption):/)
    if (!m) continue
    const [, level, pageNo, field] = m
    const v = draft.variants[level]
    tasks.push({
      level,
      page: pageNo ? Number(pageNo) : 1,
      field,
      instruction: e,
      currentText: field === 'headline' ? v.headline : v.pages[Number(pageNo) - 1].caption,
    })
  }
  return [
    'You are copyfitting an English-learning article to a fixed page layout. Return JSON only.',
    'Apply ONLY the tasks below. Each task names one field of one page. Do not touch anything else.',
    'Rules:',
    '- Reach the target by editing, not by rewriting from scratch: add or remove a clause, a short sentence or a concrete detail.',
    '- Keep the version\'s CEFR level, its 2-paragraph shape and every fact that stays. Never add a fact that is not in the cited passages below; never drop a caveat or a date that the page relies on.',
    '- When adding words, prefer explaining an already cited fact more concretely. When cutting, remove the least important clause first.',
    '- Headline and caption tasks: shorten to the stated character limit and keep the meaning.',
    `- Focus tasks: return "focus": exactly ${PAGE_CONTRACT.focus.count} items {"surface": words exactly as written in the page (≤ ${PAGE_CONTRACT.focus.maxSurfaceChars} characters), "ipa": "/…/" (≤ ${PAGE_CONTRACT.focus.maxIpaChars}), "vi": short Vietnamese meaning in this sentence (≤ ${PAGE_CONTRACT.focus.maxViChars})}.`,
    '- Return {"edits":[{"level":"B1-B2","page":3,"field":"text","value":"…","evidenceIds":["P2"]},{"level":"B1-B2","page":3,"field":"focus","focus":[…]}]}. Keep evidenceIds for text edits.',
    '',
    `Title: ${source.sourceTitle}; revision: ${source.sourceRevisionId}`,
    'TASKS:',
    JSON.stringify(tasks, null, 1),
    '',
    'CITED PASSAGES:',
    evidence.map(row => `${row.id} [${row.heading}] ${row.text}`).join('\n\n'),
  ].join('\n')
}

/** Apply the model's edits to a draft (pure). Unknown edits are ignored. */
export function applyCopyfitRewrite(draft, patch) {
  const next = structuredClone(draft)
  for (const e of patch?.edits || []) {
    const v = next.variants?.[e.level]
    if (!v) continue
    const page = v.pages?.[e.page - 1]
    if (e.field === 'focus') {
      if (page && Array.isArray(e.focus)) {
        page.focus = e.focus.slice(0, PAGE_CONTRACT.focus.count).map(f => ({
          surface: String(f?.surface || '').trim(), ipa: String(f?.ipa || '').trim(), vi: String(f?.vi || '').trim(),
        }))
      }
      continue
    }
    if (typeof e.value !== 'string' || !e.value.trim()) continue
    if (e.field === 'headline') { v.headline = e.value.trim(); continue }
    if (!page) continue
    if (e.field === 'caption') page.caption = e.value.trim()
    if (e.field === 'text') {
      page.text = e.value.trim()
      if (Array.isArray(e.evidenceIds) && e.evidenceIds.length) page.evidenceIds = e.evidenceIds
    }
  }
  return next
}

/**
 * The full loop, independent of the batch runner so it can be unit-tested:
 *   measure -> lossless paragraph fixes -> targeted rewrite (≤ maxRounds) -> verdict
 * callGemini(prompt, schema) must return the parsed JSON result.
 */
export async function copyfitLoop({draft, meter, source, evidence, callGemini, maxRounds = 2}) {
  let current = draft
  let audit = await meter.audit(current.variants)
  for (let round = 0; ; round++) {
    if (audit.fixes?.length) {
      current = {...current, variants: meter.applyFixes(current.variants, audit.fixes)}
      audit = await meter.audit(current.variants)
    }
    if (!audit.length) return {draft: current, ok: true, rounds: round, audit}
    if (round >= maxRounds || !callGemini) return {draft: current, ok: false, rounds: round, audit}
    const prompt = buildCopyfitRewritePrompt({source, evidence, draft: current, audit})
    const patch = await callGemini(prompt, COPYFIT_REWRITE_SCHEMA)
    current = applyCopyfitRewrite(current, patch)
    audit = await meter.audit(current.variants)
  }
}
