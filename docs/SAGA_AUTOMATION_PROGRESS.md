# SAGA overnight checkpoint

Updated: 2026-10-19 (Asia/Ho_Chi_Minh)

## Git and scope

- Working branch: fix/saga-cefr-headline-diagnostics-20261018.
- Latest fetched origin/main: 900047be3e90b4d5108ae960dccd5725bf88f367.
- Stage 1 commit: 4f0a1713476302c336d93e7a00f17d84076153a6.
- Stage 2 audit/credit commit: 90d1cb6d6a77cbd897d9630388cd3111235036c8.
- docs/SAGA_CONTEXT.md contains uncommitted project notes and must stay out of commits. No src/ file was edited. Only published shard 0035.json was changed to correct four copies of one image credit; no article text or image URL changed.

## Stage 1 — CEFR headlines

- Four NASA three-level prose drafts were read from ignored local artifact reports/saga-discover-local/headline-pending-39145503514/. Do not commit the artifact. All failed at the exact repaired-headline response-array shape guard. The artifact omits the raw model response, so the precise extra/missing/duplicate pattern is unavailable.
- Repair now requests only invalid levels. It ignores extra already-valid levels, preserves their headlines and all valid prose, and diagnoses missing/duplicate requested levels. Every repaired headline remains source-validated and all three must differ.
- Four observed NASA title/headline patterns have regression coverage. No Gemini call was made; live provider output is still unverified.

## Stage 2 — image audit partially complete; backfill blocked

- Active catalog before and after: 50 news, seven stories with a cover, 43 text-only, three publishers. No bulk restoration or article deletion.
- NASA image credit extraction now includes linked U.S. data providers. The published sea-ice chart credits Michala Garrison and the National Snow and Ice Data Center in all levels and root pages. Separately credited Texas field photos are excluded from NASA-created images. New lead photos must match page one in all three levels; a current event image leads before an older comparison image.
- Four pending NASA pages and the published sea-ice page returned HTTP 200, passed source-text rights checks, and yielded 2, 2, 2, 1, and 1 individually credited images. Four sampled Global Voices/Horizon pages returned HTTP 200 but yielded no individually licensed relevant image. Full 50-story dry run: eight source photos across seven stories, unchanged; 43 remain text-only.
- Commons pilot on five topics found a false positive: the first file titled Little Penguin did not visibly show a penguin. Two other candidates visibly showed a laboratory mouse and a historical satellite display; context still needs manual review. Filename and license metadata alone cannot safely drive automatic backfill. No Commons image was published.
- Stage 2 checks: npm test 132/132; lore-verify 50 news/0 lore; npm run build and git diff --check pass. Production has not been deployed from this branch.
- Next exact step: build and test a Commons review gate for visible subject, event context, time and chart data/period, alongside per-image rights and credit. Test accepted and rejected examples before a small legacy backfill. Stage 3 source expansion depends on that gate and has not begun.

## Limits

- PR #6 merged earlier. Workflow 39145503514 produced one NASA article and four pending drafts; workflow 39155116996 succeeded but did not advance origin/main. The branch has not been merged or deployed.
- Do not run publication workflow, merge, deploy, spend Gemini quota without a concrete need, or commit scraped text or the context document.
