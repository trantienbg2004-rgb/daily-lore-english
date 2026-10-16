# SAGA Recommendation V1 — experimental branch only

## What changed
- `src/lib/recommendationEngine.js`: on-device ranking of fetched, unread stories by freshness of news, locally learned category affinity, and diversity of topic/publisher.
- `src/App.jsx`: rank each incoming batch before appending; record lightweight local category counts when a story is first seen.
- `scripts/test/saga-recommendation-v1.test.mjs`: four unit tests.

## Privacy and limitations
- Preference statistics remain in localStorage on the same browser; previously saved vocabulary and IndexedDB reading history remain unchanged.
- The engine does not generate articles, retrieve additional sources, synchronize devices, or guarantee 300 unique unread articles daily.
- It reorders items *within each fetched batch*; global cross-chunk recommendation ranking is not implemented yet.
- Marking an article as read when opened is not proof it was fully read; deeper engagement signals are not implemented yet.
- This change does not include SAGA Discover and does not deploy anything.

## Run checks
- `node --test scripts/test/saga-recommendation-v1.test.mjs`
- `npm ci && npm test && npm run build`

Keep this code on a feature branch until it has passed full build/tests and real browser QA.
