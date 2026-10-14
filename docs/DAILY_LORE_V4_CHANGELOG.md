# DAILY LORE V4 — Scheduled supply and legacy workflow archive

Changes verified in this revision:

1. The curated encyclopedia pipeline runs **hourly, at minute 17** through GitHub Actions (`17 * * * *`), processing up to **80 vetted topic candidates** per run, sequentially with the existing Wikimedia pacing and rate-limit handling. An hourly *attempt* is not a promise of fresh articles or exact execution time. GitHub may delay scheduled runs.
2. The reader's **30-unread threshold** remains unchanged; while low on stories, it checks published manifests **every 60 seconds**. No GitHub token or scraping credentials are exposed to browser users.
3. Exactly three obsolete news workflow definitions moved from `.github/workflows/` to `.github/legacy-workflows/`. They no longer run on a schedule or manual dispatch. Their contents are preserved in Git for rollback. **No old scripts, tests, public news archives, local histories, photos, or saved vocabulary were deleted.**
4. The story ending contains **one source-credit line above “Read the original article”**, which opens the existing attribution dialog. Text-license and individual-image-license links remain accessible. There is no separate “Sources & credits” line below the main button.
5. Regression tests cover reader stock policy, hourly configuration, old workflow archiving, and source attribution.

## Scope and limitations

- At the time of the change there were **118 published stories** (based on the user's Cloudflare screenshot), but that number is not regenerated or altered by this patch. Verify the current count after publication.
- **697 preselected topics are a finite discovery catalogue.** Making batches more frequent does not make the catalogue infinite. To grow indefinitely, future work should add more vetted topics or an explicitly moderated topic-discovery source. Do not relax content quality or license gates merely to increase quantity.
- GitHub scheduled workflows are not real-time. There can still be a waiting screen if a reader exhausts every approved article before a new release is ready.
- No deletion of legacy code or archives until static imports, build output, deployment dependencies, and rollback behavior are separately verified against the current GitHub state.

## Recovery

- The installer creates a branch named `backup-before-lore-v4-YYYYMMDD-HHmmss` before modifying any file.
- The archived workflow definitions can be moved back to `.github/workflows/` if their old news pipelines become necessary again; do not re-enable the old 30-minute news workflow without planning conflicts with the curated library.

## V4.1 installer safety adjustment
The installer accepts independently updated legacy workflow YAML definitions only after confirming they are clean, tracked workflow files, and archives their exact current bytes prior to deactivating them. Application source hashes and regression checks remain strict. No application code or cron settings were changed from V4.
