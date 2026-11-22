/**
 * Deterministic CEFR Lexical Profiler & Flesch-Kincaid Grade Level (FKGL) engine.
 *
 * - Uses compact open CEFR wordlist (data/cefr_wordlist.json, CEFR-J v1.5 + Octanove C1-C2)
 *   combined with SAGA's local lemmatizer (public/dict/lemmas.json).
 * - Excludes mid-sentence capitalized proper nouns (e.g. "Warsaw", "Poland", "Pushkin"),
 *   all-caps acronyms, and numbers from lexical difficulty penalties.
 * - Evaluates calibrated 3-level CEFR thresholds for A1-A2, B1-B2, and C1-C2.
 */
import fs from 'node:fs'
import path from 'node:path'
import {fileURLToPath} from 'node:url'

const ROOT=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..','..')
const DEFAULT_WORDLIST_PATH=path.join(ROOT,'data','cefr_wordlist.json')
const DEFAULT_LEMMAS_PATH=path.join(ROOT,'public','dict','lemmas.json')

const BAND_RANK={A1:1,A2:2,B1:3,B2:4,C1:5,C2:6,unlisted:7}
const LEVELS=['A1-A2','B1-B2','C1-C2']

export const CEFR_THRESHOLDS={
 'A1-A2':{
  maxFkgl:6.8,
  minA1A2Pct:78,
  maxC1C2OrUnlistedPct:7
 },
 'B1-B2':{
  minFkgl:6.8,
  maxFkgl:10.8,
  minA1ToB2Pct:85,
  minFkglGapAboveA1:1.5
 },
 'C1-C2':{
  minFkgl:10.5,
  minFkglGapAboveB1:1.5
 }
}

const SYLLABLE_OVERRIDES={
 area:3,areas:3,ancient:2,being:2,business:2,businesses:3,
 create:2,created:3,creates:2,creating:3,creation:3,
 different:3,differently:4,every:2,everyday:3,everyone:3,everything:3,everywhere:3,
 family:3,families:3,fire:1,fires:1,giant:2,giants:2,
 hour:1,hours:1,idea:3,ideas:3,interesting:3,
 library:3,libraries:3,material:4,materials:4,museum:3,museums:3,
 natural:3,naturally:4,ocean:2,oceans:2,people:2,period:3,periods:3,
 poem:2,poems:2,poet:2,poets:2,poetry:3,quiet:2,quietly:3,
 radio:3,radios:3,real:1,really:2,science:2,sciences:3,scientist:3,scientists:3,
 several:3,society:4,societies:4,special:2,story:2,stories:2,
 theory:3,theories:3,various:3,video:3,videos:3,violent:3,violence:3
}

const ABBREVIATIONS_RE=/\b(?:Mr|Mrs|Ms|Dr|Prof|St|Sr|Jr|vs|etc|e\.g|i\.e|U\.S|U\.K|U\.N|B\.C|A\.D|a\.m|p\.m|No|Fig|Jan|Feb|Mar|Apr|Aug|Sept|Oct|Nov|Dec)\./gi
const ROMAN_NUMERAL_RE=/^(?:M{0,3})(?:CM|CD|D?C{0,3})(?:XC|XL|L?X{0,3})(?:IX|IV|V?I{0,3})$/
const ORDINAL_OR_NUM_RE=/^(?:\d[\d,.:/%-]*|\d+(?:st|nd|rd|th)|1\d{3}s|20\d{2}s)$/i

let cachedWordlist=null
let cachedLemmas=null

export function loadCEFRWordlist(filePath=DEFAULT_WORDLIST_PATH){
 if(filePath===DEFAULT_WORDLIST_PATH&&cachedWordlist)return cachedWordlist
 const data=JSON.parse(fs.readFileSync(filePath,'utf8'))
 if(filePath===DEFAULT_WORDLIST_PATH)cachedWordlist=data
 return data
}

export function loadLemmaMap(filePath=DEFAULT_LEMMAS_PATH){
 if(filePath===DEFAULT_LEMMAS_PATH&&cachedLemmas)return cachedLemmas
 const data=JSON.parse(fs.readFileSync(filePath,'utf8'))
 if(filePath===DEFAULT_LEMMAS_PATH)cachedLemmas=data
 return data
}

const hasOwn=(obj,key)=>Boolean(obj&&Object.prototype.hasOwnProperty.call(obj,key))

/**
 * Accurate English syllable counter for Flesch-Kincaid Grade Level.
 */
export function countSyllables(rawWord){
 const clean=String(rawWord||'').toLowerCase().replace(/[^a-z]/g,'')
 if(!clean)return 0
 if(hasOwn(SYLLABLE_OVERRIDES,clean))return SYLLABLE_OVERRIDES[clean]
 if(clean.length<=3)return 1

 let w=clean
 // Trailing -ed is silent unless preceded by t or d (or consonant+l as in "settled")
 if(w.endsWith('ed')&&w.length>4&&!/[td]ed$/.test(w)&&!/[^aeiouy]led$/.test(w)){
  w=w.slice(0,-2)
 }
 // Trailing -es is silent unless preceded by s, x, z, ch, sh, ce, ge, or consonant+i ("cities")
 if(w.endsWith('es')&&w.length>4&&!/(?:[sxz]|ch|sh|ce|ge|[^aeiouy]i)es$/.test(w)){
  w=w.slice(0,-2)
 }
 // Silent trailing -e unless consonant + le ("table", "simple", "people")
 if(w.endsWith('e')&&w.length>3&&!/[^aeiouy]le$/.test(w)&&!/(?:ee|oe|ye)$/.test(w)){
  w=w.slice(0,-1)
 }

 const groups=w.match(/[aeiouy]+/g)
 let count=groups?groups.length:1

 // Hiatuses that normally span two syllables (excluding -tion/-sion/-cious/-tious/-eous)
 const hiatusClean=w.replace(/(?:[sc]ion|tion|cious|tious|gious|eous)/g,'x')
 const hiatusMatches=hiatusClean.match(/(?:ia|io|iu|eo|ua|uo|ii|ao|ea(?=[rl]$))/g)
 if(hiatusMatches)count+=hiatusMatches.length

 // -ism ("tourism", "socialism") adds a syllable after consonant
 if(/[^aeiouy]ism$/.test(clean))count+=1
 // -mc / -ian / -ial adjustments already handled by hiatus

 return Math.max(1,count)
}

/**
 * Split English prose into sentences while respecting common abbreviations and decimals.
 */
export function splitSentences(text){
 const normalized=String(text||'')
  .replace(/[\u2018\u2019]/g,"'")
  .replace(/[\u201C\u201D]/g,'"')
  .replace(/\s+/g,' ')
  .trim()
 if(!normalized)return []

 const protectedText=normalized
  .replace(ABBREVIATIONS_RE,m=>m.replace(/\./g,'<DOT>'))
  .replace(/(\d)\.(\d)/g,'$1<DOT>$2')

 return protectedText
  .split(/(?<=[.!?])["')\]\s]+|(?<=[.!?])$/)
  .map(s=>s.replace(/<DOT>/g,'.').trim())
  .filter(s=>(s.match(/[A-Za-z]+(?:['-][A-Za-z]+)*/g)||[]).length>=1)
}

function stripPossessive(token){
 return token.replace(/(?:'s|s')$/i,m=>m.toLowerCase()==="s'"?'s':'')
}

function lookupSingleWordBand(rawLower,wordlist,lemmaMap){
 const w=rawLower.replace(/^'+|'+$/g,'')
 if(!w)return null
 if(hasOwn(wordlist,w))return wordlist[w]

 // 1. Use SAGA's public/dict/lemmas.json (78k+ entries)
 if(lemmaMap&&hasOwn(lemmaMap,w)){
  const lem=String(lemmaMap[w]||'').toLowerCase()
  if(lem&&hasOwn(wordlist,lem))return wordlist[lem]
  if(lem&&hasOwn(lemmaMap,lem)){
   const lem2=String(lemmaMap[lem]||'').toLowerCase()
   if(lem2&&hasOwn(wordlist,lem2))return wordlist[lem2]
  }
 }

 // 2. Conservative inflectional suffix fallback (plurals / -ed / -ing only)
 const candidates=[]
 if(w.endsWith('ies')&&w.length>4)candidates.push(`${w.slice(0,-3)}y`)
 if(w.endsWith('es')&&w.length>4){candidates.push(w.slice(0,-2));candidates.push(w.slice(0,-1))}
 if(w.endsWith('s')&&w.length>3&&!w.endsWith('ss'))candidates.push(w.slice(0,-1))
 if(w.endsWith('ied')&&w.length>4)candidates.push(`${w.slice(0,-3)}y`)
 if(w.endsWith('ed')&&w.length>4){
  const stem=w.slice(0,-2)
  candidates.push(stem,w.slice(0,-1))
  if(stem.length>=3&&stem[stem.length-1]===stem[stem.length-2])candidates.push(stem.slice(0,-1))
 }
 if(w.endsWith('ing')&&w.length>5){
  const stem=w.slice(0,-3)
  candidates.push(stem,`${stem}e`)
  if(stem.length>=3&&stem[stem.length-1]===stem[stem.length-2])candidates.push(stem.slice(0,-1))
 }
 for(const cand of candidates){
  if(hasOwn(wordlist,cand))return wordlist[cand]
  if(lemmaMap&&hasOwn(lemmaMap,cand)){
   const lem=String(lemmaMap[cand]||'').toLowerCase()
   if(lem&&hasOwn(wordlist,lem))return wordlist[lem]
  }
 }
 return null
}

/**
 * Look up a lowercase word (including hyphenated compounds) in the CEFR wordlist.
 */
export function lookupWordCEFR(word,wordlist,lemmaMap){
 const lower=stripPossessive(String(word||'').toLowerCase().replace(/[\u2018\u2019]/g,"'"))
 if(!lower||!/[a-z]/.test(lower))return null

 const direct=lookupSingleWordBand(lower,wordlist,lemmaMap)
 if(direct)return direct

 // Hyphenated compounds (e.g. "well-known", "nineteenth-century", "short-term")
 if(lower.includes('-')){
  const parts=lower.split('-').filter(Boolean)
  if(parts.length>=2){
   let worstBand='A1'
   let allKnown=true
   for(const part of parts){
    if(ORDINAL_OR_NUM_RE.test(part))continue
    const partBand=lookupSingleWordBand(part,wordlist,lemmaMap)
    if(!partBand){allKnown=false;break}
    if(BAND_RANK[partBand]>BAND_RANK[worstBand])worstBand=partBand
   }
   if(allKnown)return worstBand
  }
 }

 return 'unlisted'
}

function isAcronymOrRoman(raw){
 const alpha=raw.replace(/[^A-Za-z]/g,'')
 if(!alpha)return true
 if(alpha==='I')return false
 // All-caps acronym of 2+ letters (NATO, UNESCO, ADHD, DNA, GDP, EU)
 if(alpha.length>=2&&alpha===alpha.toUpperCase())return true
 // Roman numeral II, III, IV, VI, XVI...
 if(alpha.length>=2&&alpha===alpha.toUpperCase()&&ROMAN_NUMERAL_RE.test(alpha))return true
 return false
}

function extractTitleProperNouns(sourceTitle){
 const set=new Set()
 const tokens=String(sourceTitle||'').match(/[A-Za-z]+(?:['’-][A-Za-z]+)*/g)||[]
 for(const tok of tokens){
  const clean=stripPossessive(tok.replace(/[\u2018\u2019]/g,"'"))
  if(/^[A-Z][a-z]/.test(clean))set.add(clean.toLowerCase())
 }
 return set
}

/**
 * Profile English text for Flesch-Kincaid Grade Level (FKGL), sentence length,
 * CEFR lexical band breakdown, and deduplicated over-level words.
 *
 * @param {string} text
 * @param {object} [options]
 * @param {'A1-A2'|'B1-B2'|'C1-C2'} [options.targetLevel='A1-A2']
 * @param {string} [options.sourceTitle='']
 * @param {Record<string,string>} [options.wordlist]
 * @param {Record<string,string>} [options.lemmaMap]
 */
export function profileTextCEFR(text,{
 targetLevel='A1-A2',
 sourceTitle='',
 wordlist=null,
 lemmaMap=null
}={}){
 const dict=wordlist||loadCEFRWordlist()
 const lemmas=lemmaMap||loadLemmaMap()
 const sentences=splitSentences(text)
 const titleProperSet=extractTitleProperNouns(sourceTitle)

 // Pass 1: collect words appearing capitalized mid-sentence so sentence-initial
 // occurrences of the same proper noun (e.g. "Warsaw...", "...in Warsaw.") are also excluded.
 const midSentenceCapWords=new Set()
 const sentenceTokenLists=[]
 for(const sentence of sentences){
  const rawTokens=sentence.match(/[A-Za-z0-9]+(?:['’-][A-Za-z0-9]+)*/g)||[]
  sentenceTokenLists.push(rawTokens)
  rawTokens.forEach((tok,idx)=>{
   if(idx===0)return
   const clean=stripPossessive(tok.replace(/[\u2018\u2019]/g,"'"))
   if(/^[A-Z][a-z]+/.test(clean)){
    midSentenceCapWords.add(clean.toLowerCase())
   }
  })
 }

 let totalWords=0
 let totalSyllables=0
 let profiledWordCount=0
 const bandCounts={A1:0,A2:0,B1:0,B2:0,C1:0,C2:0,unlisted:0}
 const overLevelSet=new Set()
 const overLevelWords=[]
 const b2WordSet=new Set()
 const b2Words=[]
 const excludedProperNouns=new Set()

 for(const rawTokens of sentenceTokenLists){
  rawTokens.forEach((rawTok,idx)=>{
   const tok=rawTok.replace(/[\u2018\u2019]/g,"'")
   const hasLetters=/[A-Za-z]/.test(tok)

   // FKGL counts all standard words (alphabetic + numeric tokens with digits/letters)
   if(hasLetters){
    totalWords++
    totalSyllables+=countSyllables(tok)
   }else if(/^\d/.test(tok)){
    totalWords++
    totalSyllables+=1
    return
   }else{
    return
   }

   // Exclude numbers/ordinals (e.g., 1920s, 21st)
   if(ORDINAL_OR_NUM_RE.test(tok)||/\d/.test(tok))return

   const baseToken=stripPossessive(tok)
   const lower=baseToken.toLowerCase()

   // Exclude all-caps acronyms (ADHD, NATO, DNA, UN)
   if(isAcronymOrRoman(baseToken)){
    excludedProperNouns.add(baseToken)
    return
   }

   // Exclude mid-sentence capitalized proper nouns (Warsaw, Poland, Pushkin, etc.)
   const isCapitalized=/^[A-Z]/.test(baseToken)
   if(idx>0&&isCapitalized&&baseToken!=='I'&&!/^I'(?:m|ve|ll|d)$/i.test(baseToken)){
    excludedProperNouns.add(baseToken)
    return
   }

   // Look up CEFR band
   const band=lookupWordCEFR(baseToken,dict,lemmas)
   if(!band)return

   // Sentence-initial proper noun check: if capitalized at idx===0, unlisted in CEFR wordlist,
   // AND either appeared capitalized mid-sentence in this text or in sourceTitle proper nouns -> exclude
   if(idx===0&&isCapitalized&&band==='unlisted'&&(midSentenceCapWords.has(lower)||titleProperSet.has(lower))){
    excludedProperNouns.add(baseToken)
    return
   }

   profiledWordCount++
   bandCounts[band]=(bandCounts[band]||0)+1

   if(band==='B2'&&!b2WordSet.has(lower)){
    b2WordSet.add(lower)
    b2Words.push(lower)
   }

   // Over-level word tracking per target CEFR level
   const exceeds=
    (targetLevel==='A1-A2'&&(band==='C1'||band==='C2'||band==='unlisted'))||
    (targetLevel==='B1-B2'&&(band==='C1'||band==='C2'||band==='unlisted'))

   if(exceeds&&!overLevelSet.has(lower)){
    overLevelSet.add(lower)
    overLevelWords.push(lower)
   }
  })
 }

 const sentenceCount=Math.max(1,sentences.length)
 const avgSentenceLength=totalWords?Number((totalWords/sentenceCount).toFixed(2)):0
 const avgSyllablesPerWord=totalWords?totalSyllables/totalWords:0
 const rawFkgl=totalWords?0.39*(totalWords/sentenceCount)+11.8*avgSyllablesPerWord-15.59:0
 const fkgl=Number(Math.max(0,rawFkgl).toFixed(2))

 const pct=n=>profiledWordCount?Number(((n/profiledWordCount)*100).toFixed(1)):0
 const a1Pct=pct(bandCounts.A1)
 const a2Pct=pct(bandCounts.A2)
 const b1Pct=pct(bandCounts.B1)
 const b2Pct=pct(bandCounts.B2)
 const c1Pct=pct(bandCounts.C1)
 const c2Pct=pct(bandCounts.C2)
 const unlistedPct=pct(bandCounts.unlisted)

 const a1a2Pct=pct(bandCounts.A1+bandCounts.A2)
 const b1b2Pct=pct(bandCounts.B1+bandCounts.B2)
 const c1c2OrUnlistedPct=pct(bandCounts.C1+bandCounts.C2+bandCounts.unlisted)
 const a1ToB2Pct=pct(bandCounts.A1+bandCounts.A2+bandCounts.B1+bandCounts.B2)
 const b2PlusC1C2OrUnlistedPct=pct(bandCounts.B2+bandCounts.C1+bandCounts.C2+bandCounts.unlisted)

 return {
  fkgl,
  avgSentenceLength,
  wordCount:totalWords,
  sentenceCount,
  syllableCount:totalSyllables,
  profiledWordCount,
  lexicalProfile:{
   a1Pct,
   a2Pct,
   b1Pct,
   b2Pct,
   c1Pct,
   c2Pct,
   unlistedPct,
   a1a2Pct,
   b1b2Pct,
   a1ToB2Pct,
   c1c2OrUnlistedPct,
   b2PlusC1C2OrUnlistedPct
  },
  overLevelWords,
  b2Words,
  excludedProperNouns:[...excludedProperNouns]
 }
}

function joinVariantPages(variant){
 return (variant?.pages||[]).map(p=>String(p?.text||'').trim()).filter(Boolean).join(' ')
}

/**
 * Evaluate all 3 CEFR level variants of an article against objective FKGL + Lexical thresholds.
 * Returns pass/fail, detailed errors (including exact overLevelWords for targeted Gemini retry),
 * per-level profiles, and a continuous compliance penalty score (0 = perfect pass).
 */
export function evaluateArticleCEFR(variants,{
 sourceTitle='',
 thresholds=CEFR_THRESHOLDS,
 wordlist=null,
 lemmaMap=null
}={}){
 const profiles={}
 const errors=[]
 let penalty=0

 for(const level of LEVELS){
  const text=joinVariantPages(variants?.[level])
  profiles[level]=profileTextCEFR(text,{targetLevel:level,sourceTitle,wordlist,lemmaMap})
 }

 const a=profiles['A1-A2']
 const b=profiles['B1-B2']
 const c=profiles['C1-C2']

 // 1. A1-A2 objective gates
 const tA=thresholds['A1-A2']
 if(a.fkgl>tA.maxFkgl){
  const diff=Number((a.fkgl-tA.maxFkgl).toFixed(2))
  penalty+=diff*4
  errors.push(`A1-A2 CEFR gate failed: FKGL ${a.fkgl} exceeds max ${tA.maxFkgl} (avg sentence ${a.avgSentenceLength}w; shorten sentences and use simpler everyday A1-A2 words)`)
 }
 if(a.lexicalProfile.a1a2Pct<tA.minA1A2Pct){
  const diff=Number((tA.minA1A2Pct-a.lexicalProfile.a1a2Pct).toFixed(1))
  penalty+=diff*0.8
  const hardSamples=[...a.overLevelWords,...a.b2Words].slice(0,12)
  const wordHint=hardSamples.length?` — replace harder words such as [${hardSamples.join(', ')}] with simple A1-A2 equivalents`:''
  errors.push(`A1-A2 CEFR lexical gate failed: a1a2Pct ${a.lexicalProfile.a1a2Pct}% is below min ${tA.minA1A2Pct}%${wordHint}`)
 }
 if(a.lexicalProfile.c1c2OrUnlistedPct>tA.maxC1C2OrUnlistedPct){
  const diff=Number((a.lexicalProfile.c1c2OrUnlistedPct-tA.maxC1C2OrUnlistedPct).toFixed(1))
  penalty+=diff*1.5
  const overList=a.overLevelWords.slice(0,15)
  errors.push(`A1-A2 CEFR over-level vocabulary gate failed: c1c2OrUnlistedPct ${a.lexicalProfile.c1c2OrUnlistedPct}% exceeds max ${tA.maxC1C2OrUnlistedPct}%. Replace these exact over-level words in A1-A2 with simple A1-A2 words: [${overList.join(', ')}]`)
 }

 // 2. B1-B2 objective gates
 const tB=thresholds['B1-B2']
 if(b.fkgl<tB.minFkgl||b.fkgl>tB.maxFkgl){
  const diff=b.fkgl<tB.minFkgl?tB.minFkgl-b.fkgl:b.fkgl-tB.maxFkgl
  penalty+=diff*3
  errors.push(`B1-B2 CEFR gate failed: FKGL ${b.fkgl} outside target band ${tB.minFkgl}-${tB.maxFkgl} (avg sentence ${b.avgSentenceLength}w)`)
 }
 if(b.lexicalProfile.a1ToB2Pct<tB.minA1ToB2Pct){
  const diff=Number((tB.minA1ToB2Pct-b.lexicalProfile.a1ToB2Pct).toFixed(1))
  penalty+=diff*0.9
  const overList=b.overLevelWords.slice(0,12)
  const hint=overList.length?` — simplify rare/C1-C2 words: [${overList.join(', ')}]`:''
  errors.push(`B1-B2 CEFR lexical gate failed: (a1a2Pct + b1b2Pct) = ${b.lexicalProfile.a1ToB2Pct}% is below min ${tB.minA1ToB2Pct}%${hint}`)
 }
 const gapBA=Number((b.fkgl-a.fkgl).toFixed(2))
 if(gapBA<tB.minFkglGapAboveA1){
  const diff=tB.minFkglGapAboveA1-gapBA
  penalty+=diff*4
  errors.push(`CEFR FKGL separation failed: fkgl(B1-B2) ${b.fkgl} - fkgl(A1-A2) ${a.fkgl} = ${gapBA} (must be >= ${tB.minFkglGapAboveA1})`)
 }

 // 3. C1-C2 objective gates
 const tC=thresholds['C1-C2']
 if(c.fkgl<tC.minFkgl){
  const diff=Number((tC.minFkgl-c.fkgl).toFixed(2))
  penalty+=diff*3.5
  errors.push(`C1-C2 CEFR gate failed: FKGL ${c.fkgl} is below min ${tC.minFkgl} (avg sentence ${c.avgSentenceLength}w; use richer academic syntax and advanced C1-C2 vocabulary)`)
 }
 if(!(c.lexicalProfile.b2PlusC1C2OrUnlistedPct>b.lexicalProfile.b2PlusC1C2OrUnlistedPct)){
  const diff=Math.max(0.5,b.lexicalProfile.b2PlusC1C2OrUnlistedPct-c.lexicalProfile.b2PlusC1C2OrUnlistedPct+0.5)
  penalty+=diff*1.2
  errors.push(`C1-C2 CEFR lexical progression failed: C1-C2 advanced ratio (B2+C1+C2+unlisted = ${c.lexicalProfile.b2PlusC1C2OrUnlistedPct}%) must exceed B1-B2 (${b.lexicalProfile.b2PlusC1C2OrUnlistedPct}%)`)
 }
 const gapCB=Number((c.fkgl-b.fkgl).toFixed(2))
 if(gapCB<tC.minFkglGapAboveB1){
  const diff=tC.minFkglGapAboveB1-gapCB
  penalty+=diff*4
  errors.push(`CEFR FKGL separation failed: fkgl(C1-C2) ${c.fkgl} - fkgl(B1-B2) ${b.fkgl} = ${gapCB} (must be >= ${tC.minFkglGapAboveB1})`)
 }

 return {
  ok:errors.length===0,
  errors,
  profiles,
  gaps:{
   bMinusA:gapBA,
   cMinusB:gapCB
  },
  penalty:Number(penalty.toFixed(2))
 }
}
