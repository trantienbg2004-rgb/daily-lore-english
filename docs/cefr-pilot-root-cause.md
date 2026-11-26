# Fix 04 root-cause investigation, 2026-11-26

Status: PR #32 paused after Pilot #6 and #7 produced 0/3. No production changes. No Gemini calls in this investigation.

## Evidence
Pilot #7: https://github.com/trantienbg2004-rgb/daily-lore-english/actions/runs/45854143899 (commit 095d31d).
9 candidates, 2 no suitable lead image, 7 quality rejects, 0 published. Among 7 generated drafts, initial -> final counts: A FKGL >6.8 6->4; B FKGL >10.8 7->6; C FKGL >18 7->7 (diagnostic only); uncertainty/caveat flags 7->4. Neither a longer prompt nor one patch solved the issue. No raw rejected drafts persisted, so no independent semantic review is possible retrospectively. QA success only verifies software behavior.

Production #17: https://github.com/trantienbg2004-rgb/daily-lore-english/actions/runs/45839085907.
8/15 candidates with cover images passed; 8 published used gemini-3.1-flash-lite (actual model in checkpoint logs); pilot #7 succeeded with gemini-3.5-flash-lite even after transient 503. Different subjects, prompt/validator versions, and candidate budgets confound comparison; this does not establish a model effect.

## Independent syllable cross-check
Local CMUdict 1.1.3, vowel stress markers count syllables (https://github.com/cmusphinx/cmudict ; https://www.nltk.org/api/nltk.corpus.reader.cmudict.html).
Reproduced existing countSyllables rules locally and compared 115894 alphabetic dictionary entries having a single positive syllable count across pronunciations. 104421 exact, 4405 overcounts, 7068 undercounts, mean signed error -0.025 syllables per dictionary entry. Unweighted word types, including names and rare words: not learner text frequency. Examples: used 2 vs 1, specialized 4 vs 3, scientific 3 vs 4. No evidence of uniform upward bias from this test.
Two published stories at snapshot 1da3f0fd7b09b40fc3f60a161ecd5265ba62c54f; same token and sentence segmentation; unknown pronunciation falls back to legacy; CMU min/max across pronunciations. Legacy values reproduced locally.
| Story | Band | Legacy FKGL | CMU range |
|---|---|---:|---:|
| Assisted migration | A | 4.10 | 3.93–4.10 |
| Assisted migration | B | 9.90 | 9.79–9.96 |
| Assisted migration | C | 17.30 | 16.98–17.24 |
| American football | A | 2.52 | 2.52–2.63 |
| American football | B | 9.92 | 9.78–10.02 |
| American football | C | 17.25 | 17.25–17.35 |

This does not certify CEFR or validate the rejected drafts. Published sample only. C is demonstrably dense, but readability is not equivalent to CEFR. No change to FKGL thresholds. New offline CI script audits all variants in the checked-out research snapshot with exact parity checks, no Gemini and no production writes.

## Controlled experiment design (not executed)
Before another generation experiment, collect immutable source passage/outline/image fixtures from the same topics and revisions; use a fixed candidate list containing easy and difficult topics and a known accepted positive control. Compare legacy prompt vs natural prompt with the SAME model first, then compare models using the SAME prompt; preserve identical temperature, source, schema, quality gates and maximum one repair. Log actual model per call, initial and repaired drafts (including rejects), both gate outcomes, readability metrics, fact/caveat errors. A fallback or changed revision invalidates that matched comparison, do not mix conditions. Keep outputs isolated, never push catalog, do not request repeated user workflow runs. Predeclare budget and do not spend more API quota until offline review completed. No claim of model superiority from previous runs. Human passage-level review remains required (A, B and C); current sentence classifier is inadequate. A single three-story pilot cannot establish accuracy. Reject any policy that trades grounding or beginner accessibility for throughput.

## Next decision
Use full offline audit to assess whether metric implementation is a material contributor before editing the production profiler. Inspect actual rejected text in any future controlled experiment, not just gate errors. If no reliable licensed passage-level benchmark is available, retain uncertainty rather than publish a CEFR accuracy claim.
