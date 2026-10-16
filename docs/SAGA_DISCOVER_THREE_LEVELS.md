# SAGA Discover — three CEFR bands per news story

## Contract

A **single story ID/source URL** owns three editorial variations, stored as
`levelVariants['A1-A2' | 'B1-B2' | 'C1-C2']`. Each contains `pages`,
`keyVocabulary`, `evidence`, `wordCount`. Do **not** split the three versions
into separate news stories or separate reading-history IDs.

The existing story's `pages` should initially refer to `levelVariants['A1-A2'].pages`
when publishing (or any one valid version); the frontend swaps based on the
reader's preference. Each page needs `{text, image: '', caption: ''}` and optional
`imageProvenance` **only for photos with independently verified rights**.
`buildLevelPages` converts the current Gemini output into that object; by default
no unverified photos are attached.

The DOM screen paginator still reflows paragraphs based on **actual iPhone viewport**.
Four to six Gemini source paragraphs is not a hard guarantee of four to six
screen pages. Final publishing should test screenshots on target phones and
reject underfilled/overlong versions, not hide or cut words.

## Preference behavior

- Default `A1-A2` when there is no saved setting.
- Native accessible selector sits above the arrows in the fixed bottom pager.
- Changing level stays on the same story and resets its horizontal page to 1;
  the next story opens at the previously selected level automatically.
- Preference persists in `localStorage.sagaDiscoverReadingLevelV1` only.
- `dailyLoreWords` and IndexedDB `dailyNewsReadHistoryV1` are untouched.
- Legacy stories without all three variants render normally (no fake selector).

## Gemini pipeline

`scripts/discover-collect.mjs --gemini` now calls `generateThreeLevels` **once**
per eligible source and accepts the result only when *all three* bands pass the
schema and textual integrity gate. Three variants must differ and must not
introduce new numeric facts. This is **not semantic fact-checking**; legal,
editorial and source-photo review remain necessary. Drafts stay under
`reports/saga-discover-local/`, never `public/`.

`GEMINI_API_KEY` must be held in GitHub Actions Secrets. The key is not committed
or used by the reader. The existing Google API connectivity has not yet been
live-tested by this patch. Free quota is not guaranteed by application code.

## Deployment safety

This feature release is pushed to a **new feature branch**, never directly to
`main`. It does not delete 203 legacy encyclopedia stories or modify the hourly
workflow. Future cutover should happen only after lawful source content,
real API calls, and four-to-six-screen-page acceptance tests are confirmed.
