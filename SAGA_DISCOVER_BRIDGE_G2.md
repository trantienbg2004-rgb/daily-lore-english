# SAGA DISCOVER -> READER BRIDGE (G2)

- Integration basis: Reader V2, source/QA modules from exact commit `ea2dedf` of the existing Discover QA branch.
- This package does **not** merge to `main` or contact Gemini from the local workstation.
- Automatic publication is scheduled only after a separate, explicitly approved merge into `main` and a correctly configured repository secret `GEMINI_API_KEY`.
- Only explicitly licensed, source-attributed, fully formed 3-level drafts become immutable new Reader shards; other sources remain metadata-only.
- Every news level: 4–6 *source* pages at 40–75 words/page, with B1-B2 as default. Responsive pagination may split text to avoid viewport clipping on very small devices.
- Automated numeric grounding and structural QA are not substitutes for factual/editorial verification. The system does not guarantee 100% factual accuracy.
- VOA feed URLs still require independent freshness confirmation; no stale stories are represented as current.
- The lore collector and verifier are modified to preserve legally accepted news instead of deleting it on their scheduled run.
- Publisher writes newly numbered shards and manifest, then rebuilds the global recommendation index. Existing indexed legacy content is preserved.
- In production, when none passes QA or there is an API quota error, no new stories are published.
