# CEFR shadow experiment — 2026-11-26
No production changes. This is a binary sentence-warning experiment, NOT a passage CEFR classifier. CEFR-SP Wiki-Auto (Arase et al., EMNLP 2022), CC BY-SA 3.0; pinned source commit 2ba4a5005fbff68ab0f863891cf977c50fdcda29. Only exact two-rater agreement rows; normalized duplicates removed within splits and train/dev overlap excluded. Class-balanced logistic regression trained only on official train; fixed 0.5 threshold tested on official dev, not used to fit. Baseline is only existing upper FKGL cutoffs (6.8 / 10.8), not full article gate. Features: FKGL, average sentence length, syllables/word, two lexical coverage rates, known C1/C2 share, unlisted share. No semantic, sense-specific, grammar-parser or discourse measurements. No raw dataset copied; no model deployed. Results:

```json
{
  "train": 2631,
  "dev": 273,
  "trainCounts": [
    41,
    230,
    1064,
    947,
    336,
    13
  ],
  "devCounts": [
    6,
    7,
    78,
    119,
    52,
    11
  ],
  "results": [
    {
      "ceiling": 2,
      "baseline": {
        "tp": 223,
        "fp": 1,
        "tn": 12,
        "fn": 37,
        "missedHardRate": 0.1423076923076923,
        "falseWarningRate": 0.07692307692307693,
        "balancedAccuracy": 0.8903846153846153
      },
      "model": {
        "tp": 216,
        "fp": 1,
        "tn": 12,
        "fn": 44,
        "missedHardRate": 0.16923076923076924,
        "falseWarningRate": 0.07692307692307693,
        "balancedAccuracy": 0.8769230769230769
      }
    },
    {
      "ceiling": 4,
      "baseline": {
        "tp": 51,
        "fp": 67,
        "tn": 143,
        "fn": 12,
        "missedHardRate": 0.19047619047619047,
        "falseWarningRate": 0.319047619047619,
        "balancedAccuracy": 0.7452380952380953
      },
      "model": {
        "tp": 55,
        "fp": 43,
        "tn": 167,
        "fn": 8,
        "missedHardRate": 0.12698412698412698,
        "falseWarningRate": 0.20476190476190476,
        "balancedAccuracy": 0.834126984126984
      }
    }
  ]
}
```

The test split was explored in the earlier baseline; do not claim independent final validation on it. The dev results are exploratory, not suitable for selecting production thresholds or assessing reader-level passage difficulty. The Zhang & Lu OSF raw dataset remains inaccessible; Google Ace-CEFR labels productive conversational difficulty and cannot substitute for receptive reading. Next: obtain licensed passage-level labels, validate on unseen passages and experts, and only then consider integrating warnings. Preserve all current publishing gates.
