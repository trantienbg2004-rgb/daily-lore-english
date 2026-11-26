# SAGA Fix 04 — CEFR research baseline (2026-11-26)

Status: exploratory / read-only. No production thresholds changed, no Gemini calls, no catalog writes.
SAGA snapshot: d13ef1f0c4c150d93a7fd579dcb930c33ebd0528. Catalog: 28 stories, 84 variants. Existing cefrProfiler.mjs executed with repository data (8,803 lexical entries; 78,240 lemma entries). No new CEFR labels assigned.

## References and permitted use
- Council of Europe CEFR Companion Volume (2020), reading comprehension descriptors: https://www.coe.int/en/web/common-european-framework-reference-languages/reading-comprehension and https://book.coe.int/en/education-and-modern-languages/8152-common-european-framework-of-reference-for-languages-learning-teaching-assessment-companion-volume.html
- Cambridge English Vocabulary Profile and Grammar Profile: https://englishprofile.org/?menu=english-vocabulary-profile and https://englishprofile.org/?menu=english-grammar-profile — reference, not assumed redistribution rights.
- CEFR-J v1.5 / Octanove C1/C2: https://github.com/openlanguageprofiles/olp-en-cefrj — CEFR-J permits research/commercial use with attribution; Octanove CC BY-SA 4.0.
- Vajjala & Lucic (2018), OneStopEnglish Corpus, https://aclanthology.org/W18-0535/ — CC BY-SA 4.0, three editorial levels, NOT six CEFR labels.
- Arase, Uchida & Kajiwara (2022), CEFR-SP, https://aclanthology.org/2022.emnlp-main.416 ; https://github.com/yukiar/CEFR-SP/tree/main/CEFR-SP — Wiki-Auto CC BY-SA 3.0, sentence-level independent ratings; SCoRE NC and Newsela restricted, not imported.
- Zhang & Lu (2025), https://doi.org/10.1017/S0272263125101125 — 1,181 expert-rated passages; 62.6% exact-six-level and 82.6% three-band model accuracy reported. Raw data linked at OSF https://osf.io/bnh3p/?view_only=877f0181e2264e7d909e8447e7c14858 but could not retrieve in this session; license of data itself not verified.
- Cambridge English Readability Dataset https://researchdatasets.cambridge.org/cambridge-english-readability-dataset — do not import; restrictions on use, redistribution and derived products/statistics.

## Catalog baseline
10/28 pass existing evaluateArticleCEFR; 18 fail (all legacy; 8 latest published pass). FKGL min / median / max:
A 1.50 / 4.73 / 11.98; B 8.53 / 12.41 / 15.89; C 14.85 / 17.83 / 22.46.
A1-A2 token coverage min/median/max in A: 68.8/91.95/99.1; B1-B2 cumulative coverage in B: 80.7/92.25/100. These are wordlist membership measures, not known-word coverage or certified CEFR.
Mean sentence length per article median: A 10.54, B 15.41, C 19.22. 13 C variants have FKGL >18 (exploratory count, NOT a proposed gate).
Existing gate pushes strict FKGL gaps, monotonic mean sentence length, and advanced lexical ratios with unlisted words included; lexical profiler lacks sense-specific classification and excludes many capitalized tokens. Do not conflate difficult words with unknown wordlist entries.

## Parallel reference sample (exploratory)
OneStopEnglish repository https://github.com/nishkalavallabhi/OneStopEnglishCorpus ; tree 37f8db3945cd2f3cc0caafe45674147b224349be. Sorted 189 CSV paths under Texts-Together-OneCSVperFile; selected 12 evenly spaced mid-bin paths, concatenated each column's paragraphs and ran SAGA profileTextCEFR with repository dictionaries. Source names: Bolivia, Gangs, Meteorite, Skydiver, WNL are you a bad boyfriend, WNL Criminal Links, WNL Goodbye fish and chips, WNL Lego movie, WNL Noise pollution , WNL SeaWorld, WNL The Greek island, WNL Why are people so wrong.
Elementary FKGL min/median/max 5.76/8.19/11.01; Intermediate 5.92/10.45/12.23; Advanced 6.94/12.11/15.70. Strict FKGL and sentence length order held for 12/12 triplets in this sample. 3/12 Advanced versions FKGL <10.5, 5/12 Intermediate >10.8. These editorial levels cannot be treated as CEFR A/B/C ground truth; metrics show variation only.

## Sentence benchmark (exploratory)
CEFR-SP Wiki-Auto test split, commit 2ba4a5005fbff68ab0f863891cf977c50fdcda29, CEFR-SP/Wiki-Auto/CEFR-SP_Wikiauto_test.txt. 762 valid rows, 278 exact rater agreement rows. Only consensus rows summarized. Counts A1/A2/B1/B2/C1/C2 = 4/9/86/122/48/9. Median words per sentence 6/9/13/17/17.5/20. Strong imbalance and sentence granularity preclude setting passage-level cutoffs. Do not tune to held-out test; next stage use train/dev to select metrics and reserve independent passage validation.

## Next acceptance criteria
- Select licensed expert-labelled passage benchmark, ensure all six levels represented, topic/author grouping and held-out evaluation, especially A1/A2 and B1/B2.
- Compare existing gates and alternatives; report confusion matrix and high-difficulty false accept rate, not only accuracy or throughput. Separate out-of-list, proper names, essential terms; assess sense, phrase, grammar and coherence limitations.
- Use lower-end band preference as editorial policy (A1/A2 accessible, B1/B2 accessible, C1/C2 natural), not arbitrary numerical proportions. No compulsory complexity inflation, but do not remove existing protections until replacement is independently validated.
- Keep factual, caveat, license, paragraph and publishing gates intact. Shadow-mode first. No requeue or deletion of legacy catalog, no live API before review. Human rating required to claim reliable CEFR alignment; no automatic certification.
