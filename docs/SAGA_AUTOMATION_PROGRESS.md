# SAGA overnight checkpoint

Updated: 2026-10-19 (Asia/Ho_Chi_Minh)

## Git

- Working branch: fix/saga-cefr-headline-diagnostics-20261018.
- Latest fetched origin/main: 900047be3e90b4d5108ae960dccd5725bf88f367. No merge or production deployment.
- Stage commits: 4f0a171 (CEFR repair), 90d1cb6 (NASA rights/credits), adc2097 (recover four preserved NASA drafts).
- Draft PR #7: https://github.com/trantienbg2004-rgb/daily-lore-english/pull/7. Push the newest branch commit and update the PR description after this checkpoint commit.
- docs/SAGA_CONTEXT.md is modified locally, excluded from all commits. No src/ file was edited. Do not commit files under reports/saga-discover-local/.

## Stage 1 — CEFR headline failure resolved locally

- Read four pending NASA drafts from ignored local workflow artifact reports/saga-discover-local/headline-pending-39145503514/. The exact failing guard was the strict repaired-headline response array. The raw model response was not saved, so the exact extra/missing/duplicate pattern cannot be determined.
- The repair request now targets only invalid levels. The parser ignores extra already-valid levels, preserves valid prose/headlines, and reports missing/duplicate requested levels. Repaired headlines still pass source/number/name and three-level distinctness checks.
- Re-fetched all four original NASA pages; rights and prose validation passed. Manually reviewed source-backed headlines and NASA images. The saved three-level prose was used unchanged; no Gemini call. All four drafts passed staging QA and catalog gates before being appended to branch shard 0036.json. Each has 4–6 pages per level and a current-event licensed NASA lead photo. Four articles have seven distinct NASA images across their B1 pages.
- Live Gemini behavior for future repair responses remains unverified until an authorized main workflow runs.

## Stage 2 — source image improvements complete; Commons backfill pending

- Active branch catalog before: 50 news, seven with a verified cover, 43 text-only, three publishers. After: 54 news, eleven with a verified cover, 43 text-only, three publishers (Global Voices 37, Horizon Magazine 12, NASA Earth Observatory 5). No old article was deleted; retired Rhinoceros stories remain excluded from Reader.
- NASA credit parsing now includes linked U.S. data providers. The published sea-ice chart in shard 0035.json now credits Michala Garrison and the National Snow and Ice Data Center in all three levels and root pages. Separately credited Texas field photos are excluded from NASA-created imagery.
- New lead photos must fit page one at all CEFR levels. Dated same-area NASA comparisons prefer the current image; improved word normalization places the hurricane gravity-wave image on the page discussing waves. The two Thailand comparison captions explicitly distinguish October 2025 from 2 October 2026, based on the original NASA article.
- Source audit: four pending NASA pages and the published NASA page returned HTTP 200, passed source rights, and had individually credited images. Four sampled Global Voices/Horizon pages returned HTTP 200 but had no individually licensed relevant image. A full 50-story dry run before recovery found eight source photos across seven stories, unchanged.
- Commons pilot on five topics exposed a visual false positive: a file titled Little Penguin did not visibly show a penguin. No Commons image was published. Filename and license metadata alone are insufficient; automatic legacy backfill remains blocked pending visible-subject, context, time and chart review.
- After latest catalog change: npm test 134/134 pass; lore-verify 54 news/0 lore; npm run build and git diff --check pass. No UI code changed.

## Next exact steps

1. Confirm the branch and checkpoint are pushed; keep draft PR #7 accurate at 54 branch news and 11 with cover.
2. Build a Commons visual/context review gate; test accepted and rejected examples before a small legacy backfill. Do not run automatic Commons backfill yet.
3. After the image gate is proven, evaluate additional independent sources one at a time, including History & Geography and Sports. Stage 3 is not started; stage 4 production integration and scheduled workflow observation are pending.
4. Preserve the ignored artifact and local context notes. Do not merge, run the production publication workflow, deploy, or spend paid quota.
