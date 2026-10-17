# SAGA — English World News Reader

SAGA is a React/Vite reader for sourced world news at https://saga.id.vn/. It offers three English reading levels, adaptive pages, and vocabulary learning through Read, Words and Review. The current Reader is **news only**; historical DAILY LORE article files remain stored but are excluded from its index.

Read [project context](docs/SAGA_CONTEXT.md) for current architecture, verified status, open issues and release rules. Codex contributors should also read [AGENTS.md](AGENTS.md).

## Local development

```sh
npm ci
npm run dev
npm test
node scripts/lore-verify.mjs
npm run build
```

`public/lore-reader/` is the active news catalog. `scripts/discover-collect.mjs` stages RSS and rights checks; the Gemini-backed publisher uses `GEMINI_API_KEY` from GitHub Actions. Staging reports in `reports/saga-discover-local/` must not be committed. The scheduled workflow is `.github/workflows/saga-discover-publish.yml`; the old DAILY LORE workflow is disabled.

Never treat an RSS image URL as reuse permission. A news photo requires per-image license evidence and attribution. Do not manually rebuild or delete published shards, or expose browser vocabulary/history data or API secrets.
