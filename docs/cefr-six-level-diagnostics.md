# Six-level CEFR diagnostics and C editorial policy

Research only; no change to main, catalog, publishing gates or API usage. Same CEFR-SP Wiki-Auto train/dev protocol as cefr-shadow-experiment.md (2631 training and 273 development sentences, consensus labels only, exact normalized duplicates removed). Existing seven features, five independently trained class-balanced logistic boundary models P(level > k), k=1..5. Fixed 0.5 decision, monotonically capped cumulative scores. Scores are not calibrated probabilities. Dev has already been examined; results are exploratory, not independent final validation.

Rows are actual A1,A2,B1,B2,C1,C2; columns predicted same order:
| actual | A1 | A2 | B1 | B2 | C1 | C2 |
|---|---:|---:|---:|---:|---:|---:|
| A1 | 5 | 1 | 0 | 0 | 0 | 0 |
| A2 | 5 | 1 | 1 | 0 | 0 | 0 |
| B1 | 12 | 18 | 36 | 10 | 1 | 1 |
| B2 | 9 | 6 | 19 | 44 | 28 | 13 |
| C1 | 0 | 0 | 0 | 8 | 9 | 35 |
| C2 | 0 | 0 | 0 | 0 | 0 | 11 |

Exact 106/273 (38.83%); A/B/C group 176/273 (64.47%); within one level 231/273 (84.62%). Underestimation of group 53/273; overestimation 44/273. C group precision 55/98, recall 55/63. C1 exact 9/52; C2 exact 11/11 but only 13 C2 training examples and 11 dev examples. 35 of 52 C1 sentences predicted C2; C2 precision 11/60. This is not sufficiently reliable for production or for claiming C2. The dataset is sentence-level; no above-C2 label exists and a C2 prediction does not detect unnatural prose. No automatic C2 certification or arbitrary FKGL upper ceiling.

## Editorial design proposal (not implemented)
Council of Europe CEFR reading descriptors distinguish fine-grained comprehension, implicit attitudes, style and complex texts rather than a numeric minimum for sentence length. C1 is the default editorial aim of SAGA's combined C band; C2-like nuance when appropriate, not compulsory obscurity. Keep the same source facts, uncertainty and paragraph alignment as A/B. Prefer precise natural idiomatic English, explicit logical links when needed, and controlled complexity. Allow short sentences, common words and direct verbs. Avoid unnecessary nominalizations, rare synonyms, nested clauses for their own sake, padding and artificial academic voice. Necessary specialist terms should be explained in context or glossary. Review high FKGL or uncommon vocabulary as diagnostics, not proof of level. Preserve existing production gate until a validated replacement is available; do not introduce hard thresholds from this dev sample.

References:
- Council of Europe, CEFR reading comprehension: https://www.coe.int/en/web/common-european-framework-reference-languages/reading-comprehension
- Arase et al. (2022): https://aclanthology.org/2022.emnlp-main.416/
- Uchida et al., Profiling English sentences based on CEFR levels: https://www.benjamins.com/catalog/itl.22018.uch — lexical difficulty alone does not significantly discriminate A1/A2 or C1/C2 in their analysis.
- Zhang & Lu (2025), passage-level expert labels: https://www.cambridge.org/core/journals/studies-in-second-language-acquisition/article/aligning-linguistic-complexity-with-the-difficulty-of-english-texts-for-l2-learners-based-on-cefr-levels/DB604DB02A205F0F172D6024137CBFE8 — raw data and license remain unverified here.

Next gate: licensed passage-level benchmark with all six levels, independent holdout, grammar/sense/discourse features, human assessment of naturalness and reading comprehension, comparison of both false acceptance and false rejection. 
