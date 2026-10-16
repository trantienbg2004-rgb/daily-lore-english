# SAGA Discover — real-source + Gemini 2.5 Flash staging QA

## What this changes

Adds a GitHub Actions workflow to the new **feature branch**. A push to that
branch automatically runs all existing reader tests, source/Gemini contract tests,
a production Vite build (without deployment), then a **single article** live
Gemini attempt using the repository's `GEMINI_API_KEY` secret. The workflow
fetches metadata from all five configured news sources. BBC, NPR and The
Conversation are still metadata-only under current rights policy.

**No data is published.** Nothing under `public/` is modified. The old lore
library, production `main`, Cloudflare site, Read/Words/Review and user history
remain unchanged. A complete three-level draft is only a staging result and
requires independent factual, legal and image review before publication.

## Read results

GitHub > daily-lore-english > Actions >
`SAGA Discover - live five-source and Gemini QA` > latest run > Summary.

The run reports candidate count, rights-eligible article count, Gemini calls,
complete three-level drafts and rejection reasons. A red run with no eligible
articles is a **useful diagnosis**, not permission to bypass source rights or
invent content. An Actions artifact `saga-discover-live-qa` is kept for three
days, with source diagnostics and staging drafts, not raw publisher articles.

## Cost / privacy

Only GitHub Actions accesses `GEMINI_API_KEY`, never browser JS. The live run
attempts **at most one article** with the configured Gemini 2.5 Flash model;
429/503 may cause limited retries. A free API quota and zero billing **cannot
be guaranteed** by code. Confirm Google AI Studio project billing settings.
Do not paste the API key into chat, terminal screenshots or the repository.

## Acceptance / limitations

QA validates 3 variants per article, reader page schema, length, rights flags,
no unverified images, stable IDs and zero publication. It does **not** verify
actual iPhone screen pagination, independent factual accuracy, licenses of
third-party materials, or that Gemini CEFR labels are pedagogically correct.
Those are mandatory gates before replacing the old article library.
