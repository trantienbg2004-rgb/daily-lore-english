# SAGA DISCOVER — STAGES 0, 1 & 2 — SAFE STAGING RELEASE

**This release does not change Read, Words, Review, CSS, existing library, Cloudflare, or published website.** It implements the five-source ingestion and Gemini 2.5 Flash editor in a separate staging pipeline. User requested removal of the old 203 stories *later*, only when the replacement passes quality and publishing tests. No public content is removed by this package.

## Inputs and limitations

- `scripts/discover/sources/{voa,globalVoices,theConversation,bbc,npr}.mjs` are five adapters.
- VOA Learning English: three official RSS endpoints, first-party article text only, never inferred image rights.
- Global Voices: only process full article text when page contains a specific CC BY `rel=license` statement and no third-party issue. Otherwise metadata-only.
- The Conversation: metadata-only because its standard CC BY-ND policy restricts adapted republication.
- BBC & NPR: metadata-only until explicit written republication rights are secured. Never feed copyrighted article bodies, images or publisher snippets to AI.
- The rights checker is deliberately **conservative**. Lack of usable text is reported, never replaced with fabricated news.
- Article HTML may change; such failures must remain rejects. They are not a reason to bypass gates.

## Commands (Node 22+, no new packages required)

```powershell
node --test scripts/test/saga-discover-ingestion.test.mjs scripts/test/saga-discover-gemini.test.mjs
node scripts/discover-collect.mjs --max=8
```

The collector fetches real publisher feeds and (when allowed) article text, then writes only:
- `reports/saga-discover-local/source-report.json`
- `reports/saga-discover-local/discovered-metadata.json`
- `reports/saga-discover-local/gemini-drafts.json`

This local directory is excluded by `.gitignore`. **Do not commit scraped source text or API keys.** Staging does not publish to `public/`.

To test live Gemini 2.5 Flash after confirming a Free Tier project in Google AI Studio:

```powershell
$env:GEMINI_API_KEY="YOUR_KEY_IN_YOUR_PRIVATE_TERMINAL"
node scripts/discover-collect.mjs --gemini --max=8 --max-ai=3
Remove-Item Env:GEMINI_API_KEY
```

**Never post API keys into chat or commit them.** A Google account with billing enabled may incur charges; the script restricts request count but cannot enforce Google's billing tier. The model may not be available to new accounts; a 403/404 will be reported, not bypassed. No fallback to paid models is implemented.

## Acceptance status

- All five RSS adapters and safe URL checks are tested using offline fixtures.
- Gemini request shape and rejection paths are tested with a fake response; real inference requires user's key and provider access.
- Site's existing user-facing functionality is untouched.
- New output is **editorial staging, not production**. Its draft fact checks catch ungrounded numbers and require direct evidence excerpts but do not guarantee factual accuracy. Manual review remains required.
- Even when Gemini generates 4–6 text paragraphs, mobile 4–6 pages cannot be guaranteed until phase 3 connects and visually tests real Safari pagination.

## Next major phase (not included)

News publication schema, independent `discover-reader` shards, legal photo sourcing, 4–6 **actual viewport pages**, compatibility with `src/lib/continuousReader.js`, final cutover and removal of `public/lore-reader/`, old workflow disable, full regression and rollback plan. Do not remove the 203-story library before these pass.

## Important terms

- VOA reuse policy: https://learningenglish.voanews.com/p/6861.html
- Official VOA feeds: https://learningenglish.voanews.com/rssfeeds
- The Conversation republishing: https://theconversation.com/us/republishing-guidelines
- BBC RSS terms: https://www.bbc.co.uk/usingthebbc/terms/
- Gemini docs: https://ai.google.dev/gemini-api/docs/models/gemini-2.5-flash
