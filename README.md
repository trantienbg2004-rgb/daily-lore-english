# DAILY LORE — English Knowledge Reader

A React/Vite reader for curated English-language knowledge stories from Wikipedia/Wikimedia Commons. Swipe horizontally through article pages, vertically between articles, and save vocabulary with Read / Words / Review.

## Development

```sh
npm ci
npm run dev
npm run test
npm run build
```

## Active publishing pipeline

- `.github/workflows/daily-lore-library.yml` runs hourly at minute 17 and on selected source changes.
- `scripts/lore-collect.mjs` discovers and quality-checks curated topics using `scripts/lore/`.
- `scripts/lore-verify.mjs` validates the approved publication.
- `public/lore-reader/` is the **only active article feed**. `reports/DAILY_LORE_SOURCE_STATE.json` tracks discovery progress. **Do not delete or regenerate these files manually.**
- The website loads the feed from `/lore-reader/manifest.json` and reads the chunk JSON files.

## Reader and user data

`src/App.jsx`, `src/App.css`, `src/lib/` and `src/index.css` are application code; do not remove them just because some module names mention 'news'. User vocabulary/history is stored in browser localStorage/IndexedDB and is not part of this repository.

## Old workflows and archive

Historical news workflows are kept under `.github/legacy-workflows/` and are not scheduled. Removed V22 news-data/script/test artifacts can be recovered from the pre-cleanup Git branch or `DAILY_LORE_CLEANUP_REMOVED_FILES.zip` in the cleanup kit. Do not re-enable old workflows unless explicitly restoring the news product.

## Important limits

New stories are published only when source articles meet editorial/rights checks; the hourly job cannot guarantee fresh stories each run. The Read client fetches a new manifest when unread supply is low but cannot initiate server-side scraping instantly.
