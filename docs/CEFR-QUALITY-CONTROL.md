# SAGA CEFR Reading-Level Control

## Purpose

SAGA publishes three reading bands: A1–A2, B1–B2 and C1–C2. These are target reading bands for learner-facing articles, not a formal CEFR certification of an individual learner or text.

## Governing reference

The primary reference is the Council of Europe, *Common European Framework of Reference for Languages: Learning, Teaching, Assessment — Companion Volume* (2020), especially the overall reading comprehension descriptors (pp. 53–54 in the publication pagination):

- **A1:** very short, simple texts; familiar names, words and basic phrases; rereading may be needed.
- **A2:** short, simple texts on familiar, concrete matters using high-frequency everyday or job-related language.
- **B1:** straightforward factual texts on subjects related to the reader's interests, understood with satisfactory comprehension.
- **B2:** independent reading across different texts and purposes, supported by a broad active reading vocabulary; low-frequency idioms may still cause difficulty.
- **C1:** lengthy, complex texts, including specialised academic or professional publications, with the possibility of rereading difficult sections.
- **C2:** virtually all types of texts, including abstract and structurally complex writing, with subtle stylistic distinctions and implicit as well as explicit meaning.

The CEFR also describes vocabulary range, grammatical range, cohesion and pragmatic/discourse competence. It does not define text levels as fixed FKGL scores, sentence lengths or word-frequency percentages. Reading performance depends on the text, reader, context, purpose and task.

Official reference: https://rm.coe.int/cefr-companion-volume-with-new-descriptors-2020/16809ea0d4

## Production design

1. **One source revision and evidence set.** All three versions are grounded in the same retrieved Wikipedia revision and evidence passages.
2. **Shared visual map, independent reading plans.** Page count and image binding remain aligned, but A1–A2, B1–B2 and C1–C2 receive separate reader objectives, selected core facts and explanatory depth; each version may allocate those facts differently across pages. At least two central facts remain common; if the generator omits them from one level's selection, normalization reconciles the plans against the ordered source fact sheet before validation.
3. **Level-specific writing.**
   - A1–A2 selects essential concrete facts and explains unavoidable topic terms in simple language.
   - B1–B2 develops main points, context, chronology, cause/effect and relevant viewpoints in natural prose.
   - C1–C2 uses genuine conceptual depth, specialist precision, qualifications, nuance and complex relationships where the source warrants them.
4. **Deterministic safeguards.** Page/image structure, source evidence IDs, dates, quantities, uncertainty, safety caveats, complete sentences and editorial defects are checked before publication. A source-claim audit also blocks unsupported exclusivity/absence claims such as “no other inventors” or “the only person”; silence in a source is not evidence that no other person or explanation existed.
5. **Heuristics are diagnostics, not certification.** FKGL, syllable counts, sentence length and the internal CEFR-J/Octanove wordlist can flag likely problems. They are not used alone to assign CEFR. A word missing from a list is not automatically advanced; sense, context and technical-term explanation matter.
6. **Independent descriptor review.** A separate Gemini reviewer request (Gemini 3.6 Flash by default, configurable through `CEFR_REVIEW_MODEL` with model failover) assesses each complete version against the six dimensions of vocabulary, grammar/syntax, cohesion, abstraction, inference and specialist-term load. If the preferred reviewer routes are unavailable or under high demand, failover may use the generation model; the actual model used is logged. The system attaches a deterministic verbatim sentence from each final version as auditable evidence; the reviewer must give a concrete rationale tied to the text. Repairs contain only changed pages, and untouched pages are preserved before the complete article is rechecked. Initial and final band/dimension assessments are kept separate. If a version is out of band or uncertain, the reviewer may return one targeted repair pass containing only the pages that need changes; untouched pages are preserved, then the complete article is reassessed and deterministic checks run again.
7. **Fail closed.** A candidate is not published if any level lacks a confident in-band final review, a verbatim audit excerpt, valid source grounding or a passing deterministic check. Rejected candidates remain available for diagnosis/retry; they are not silently downgraded.

## Important limitation and calibration requirement

The descriptor reviewer is an automated quality-control layer, not an accredited CEFR examiner. A language model can still misjudge a text. The system should therefore be described as **CEFR-descriptor-controlled**, not as proven 100% accurate, until a benchmark of representative A1, A2, B1, B2, C1 and C2 texts has been independently rated by qualified English-language educators and used to measure reviewer agreement. Do not claim a measured accuracy rate without that benchmark.

## Sources

- Council of Europe (2020), *CEFR Companion Volume*: https://rm.coe.int/cefr-companion-volume-with-new-descriptors-2020/16809ea0d4
- Azemoto (2026), discussion of limitations and disagreement in CEFR word/phrase level assignment: https://doi.org/10.60303/jaecslex.8.0_43
