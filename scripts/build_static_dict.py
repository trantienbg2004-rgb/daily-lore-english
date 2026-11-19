#!/usr/bin/env python3
"""
One-time builder for SAGA's Tier-2 static sharded learner dictionary ($0 runtime).

Downloads and parses:
1. Kaikki.org Simple English Wiktionary (Wiktextract JSONL.gz) — learner-friendly
   definitions comparable to Cambridge Learner's Dictionary.
2. Public English word frequency list (hermitdave/FrequencyWords en_50k.txt) to
   select the top 25,000 most common English words.

Outputs compact static JSON files into /public/dict/:
- /public/dict/lemmas.json   (inflected form -> base lemma map)
- /public/dict/<xx>.json     (2-letter prefix shards, max 3 definitions per POS)
- /public/dict/manifest.json (build stats & metadata)

Uses Python 3 standard library only (no pip dependencies).
"""

from __future__ import annotations

import argparse
import gzip
import json
import re
import shutil
import sys
import urllib.request
from collections import defaultdict
from pathlib import Path
from typing import Any

SIMPLE_WIKTIONARY_URL = (
    "https://kaikki.org/dictionary/downloads/simple/simple-extract.jsonl.gz"
)
FREQUENCY_LIST_URL = (
    "https://raw.githubusercontent.com/hermitdave/FrequencyWords/master/content/2018/en/en_50k.txt"
)
USER_AGENT = "SAGA-StaticDictBuilder/1.0 (https://saga.id.vn)"

EXCLUDED_TAGS = {
    "archaic",
    "obsolete",
    "rare",
    "dated",
    "offensive",
    "vulgar",
    "derogatory",
    "slur",
    "historical",
    "nonstandard",
}

POS_MAP = {
    "noun": "noun",
    "verb": "verb",
    "adj": "adj",
    "adjective": "adj",
    "adv": "adv",
    "adverb": "adv",
    "prep": "prep",
    "preposition": "prep",
    "conj": "conj",
    "conjunction": "conj",
    "pron": "pron",
    "pronoun": "pron",
    "det": "det",
    "determiner": "det",
    "intj": "intj",
    "interjection": "intj",
    "num": "num",
    "phrase": "phrase",
    "prep_phrase": "phrase",
    "name": "noun",
}

INFLECTION_GLOSS_RE = re.compile(
    r"^(?:the\s+)?(?:"
    r"plural|past\s+tense(?:\s+and\s+past\s+participle)?|"
    r"simple\s+past(?:\s+and\s+past\s+participle)?|"
    r"past\s+participle|present\s+participle|"
    r"third[- ]person\s+singular(?:\s+simple\s+present(?:\s+indicative)?)?|"
    r"comparative|superlative|inflection|gerund|alternative\s+(?:spelling|form)"
    r")(?:\s+form)?\s+of\s+([a-z][a-z'-]{0,30})\b",
    re.IGNORECASE,
)

SPELLING_STUB_RE = re.compile(
    r"^(?:another\s+way\s+to\s+spell|a\s+different\s+spelling\s+of|alternative\s+spelling\s+of|spelling\s+variant\s+of)\b",
    re.IGNORECASE,
)

CLEAN_WORD_RE = re.compile(r"^[a-z]+(?:[-'][a-z]+)*$")


def shard_key_for(word: str) -> str:
    letters = re.sub(r"[^a-z]", "", word.lower())
    if len(letters) >= 2:
        return letters[:2]
    if len(letters) == 1:
        return f"{letters}_"
    return "__"


def download_if_needed(url: str, dest: Path) -> Path:
    if dest.exists() and dest.stat().st_size > 0:
        return dest
    dest.parent.mkdir(parents=True, exist_ok=True)
    tmp = dest.with_suffix(dest.suffix + ".part")
    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    with urllib.request.urlopen(req, timeout=60) as resp, tmp.open("wb") as out:
        shutil.copyfileobj(resp, out)
    tmp.replace(dest)
    return dest


def load_frequency_ranks(path: Path, max_words: int) -> dict[str, int]:
    ranks: dict[str, int] = {}
    with path.open("r", encoding="utf-8", errors="ignore") as f:
        for line in f:
            parts = line.strip().split()
            if not parts:
                continue
            word = parts[0].lower()
            if not CLEAN_WORD_RE.match(word):
                continue
            if word not in ranks:
                ranks[word] = len(ranks) + 1
                if len(ranks) >= max_words:
                    break
    return ranks


def pick_ipa(sounds: list[dict[str, Any]] | None) -> str:
    if not sounds:
        return ""
    preferred: list[tuple[int, str]] = []
    for s in sounds:
        ipa = (s.get("ipa") or "").strip()
        if not ipa:
            continue
        tags = {str(t).lower() for t in (s.get("tags") or [])}
        if "us" in tags or "general american" in tags:
            prio = 0
        elif "uk" in tags or "rp" in tags:
            prio = 1
        elif not tags:
            prio = 2
        else:
            prio = 3
        preferred.append((prio, ipa))
    if not preferred:
        return ""
    preferred.sort(key=lambda item: item[0])
    return preferred[0][1]


def sense_is_excluded(sense: dict[str, Any]) -> bool:
    tags = {str(t).lower() for t in (sense.get("tags") or [])}
    raw_tags = {str(t).lower() for t in (sense.get("raw_tags") or [])}
    all_tags = tags | raw_tags
    for bad in EXCLUDED_TAGS:
        if any(bad in t for t in all_tags):
            return True
    return False


def shorten_definition(gloss: str, max_chars: int = 160) -> str:
    text = re.sub(r"\s+", " ", gloss).strip()
    if len(text) <= max_chars:
        return text
    # Prefer the first complete sentence (including quoted sentence endings).
    m = re.search(r"[.!?][\"'”’]?(?=\s|$)", text)
    if m and 18 <= m.end() <= max_chars:
        return text[: m.end()].strip()
    # Otherwise cut cleanly at the last word boundary (never mid-word).
    clipped = text[: max_chars - 1]
    if " " in clipped:
        clipped = clipped.rsplit(" ", 1)[0]
    return clipped.rstrip(" ,;:-") + "…"


def pick_example(sense: dict[str, Any], max_chars: int = 130) -> str:
    for ex in sense.get("examples") or []:
        text = re.sub(r"\s+", " ", str(ex.get("text") or "")).strip()
        if 12 <= len(text) <= max_chars and " " in text:
            return text
    return ""


def normalize_form_text(raw: str) -> str:
    text = re.sub(r"\s+", " ", str(raw or "")).strip().lower()
    # Skip multi-word analytic forms like "more happy", "most happy"
    if " " in text:
        return ""
    if not CLEAN_WORD_RE.match(text):
        return ""
    return text


def build_dictionary(
    jsonl_gz_path: Path,
    freq_ranks: dict[str, int],
    out_dir: Path,
    max_per_pos: int = 3,
    max_words: int = 25000,
) -> dict[str, Any]:
    # word -> {"ipa": str, "by_pos": {pos: [sense_dict, ...]}}
    entries: dict[str, dict[str, Any]] = {}
    # inflected_form -> set of candidate base lemmas
    raw_lemmas: dict[str, list[str]] = defaultdict(list)

    lines_read = 0
    with gzip.open(jsonl_gz_path, "rt", encoding="utf-8", errors="ignore") as gz:
        for raw_line in gz:
            lines_read += 1
            try:
                obj = json.loads(raw_line)
            except json.JSONDecodeError:
                continue
            if obj.get("lang_code") != "en":
                continue

            raw_word = str(obj.get("word") or "").strip()
            word = raw_word.lower()
            if not word or not CLEAN_WORD_RE.match(word):
                continue

            pos_raw = str(obj.get("pos") or "").lower()
            pos = POS_MAP.get(pos_raw)
            if not pos:
                continue

            forms = obj.get("forms") or []
            senses = obj.get("senses") or []

            # 1. Collect inflection -> lemma links from headword's forms table.
            canonical_targets: list[str] = []
            for f in forms:
                f_val = normalize_form_text(f.get("form") or "")
                if not f_val or f_val == word:
                    continue
                f_tags = {str(t).lower() for t in (f.get("tags") or [])}
                f_raw = {str(t).lower() for t in (f.get("raw_tags") or [])}
                all_f_tags = f_tags | f_raw
                if (
                    "canonical" in all_f_tags
                    or "positive" in all_f_tags
                    or "singular" in all_f_tags
                    or "infinitive" in all_f_tags
                ):
                    canonical_targets.append(f_val)
                elif all_f_tags & {
                    "plural",
                    "past",
                    "participle",
                    "present",
                    "third-person",
                    "comparative",
                    "superlative",
                }:
                    raw_lemmas[f_val].append(word)

            for base in canonical_targets:
                raw_lemmas[word].append(base)

            # 2. Extract learner-friendly senses & form_of references.
            clean_senses: list[dict[str, str]] = []
            for sense in senses:
                if sense_is_excluded(sense):
                    continue
                for ref in sense.get("form_of") or []:
                    ref_w = normalize_form_text(ref.get("word") or "")
                    if ref_w and ref_w != word:
                        raw_lemmas[word].append(ref_w)

                glosses = sense.get("glosses") or []
                if not glosses:
                    continue
                gloss = str(glosses[0]).strip()
                if not gloss:
                    continue

                infl_match = INFLECTION_GLOSS_RE.match(gloss)
                if infl_match:
                    target = normalize_form_text(infl_match.group(1))
                    if target and target != word:
                        raw_lemmas[word].append(target)
                    # Skip pure inflection stub definitions so inflections
                    # resolve cleanly to their base lemma's rich definition.
                    continue

                if SPELLING_STUB_RE.match(gloss):
                    continue

                short_def = shorten_definition(gloss)
                if not short_def:
                    continue
                example = pick_example(sense)
                sense_obj: dict[str, str] = {"p": pos, "d": short_def}
                if example:
                    sense_obj["e"] = example
                clean_senses.append(sense_obj)

            if not clean_senses:
                continue

            rec = entries.setdefault(word, {"ipa": "", "by_pos": defaultdict(list)})
            if not rec["ipa"]:
                rec["ipa"] = pick_ipa(obj.get("sounds"))

            bucket = rec["by_pos"][pos]
            existing_defs = {item["d"].lower() for item in bucket}
            for item in clean_senses:
                if len(bucket) >= max_per_pos:
                    break
                if item["d"].lower() in existing_defs:
                    continue
                existing_defs.add(item["d"].lower())
                bucket.append(item)

    # Filter down to the top `max_words` words prioritized by frequency rank,
    # also retaining any base lemma referenced by a high-frequency inflection.
    lemma_targets_for_top: set[str] = set()
    for form, candidates in raw_lemmas.items():
        if form in freq_ranks:
            for c in candidates:
                if c in entries:
                    lemma_targets_for_top.add(c)

    def sort_key(w: str) -> tuple[int, int, str]:
        if w in freq_ranks:
            return (0, freq_ranks[w], w)
        if w in lemma_targets_for_top:
            return (1, 0, w)
        return (2, 0, w)

    selected_words = [
        w
        for w in sorted(entries.keys(), key=sort_key)
        if w in freq_ranks or w in lemma_targets_for_top
    ][:max_words]
    selected_set = set(selected_words)

    # Build final compact lemmas map pointing only into selected_set.
    final_lemmas: dict[str, str] = {}
    for form, candidates in raw_lemmas.items():
        valid = [c for c in candidates if c in selected_set and c != form]
        if not valid:
            continue
        # Prefer highest-frequency lemma candidate.
        valid.sort(key=lambda c: (freq_ranks.get(c, 999999), len(c), c))
        final_lemmas[form] = valid[0]

    # Ensure core irregular English mappings are always present when their lemma exists.
    core_irregulars = {
        "went": "go",
        "gone": "go",
        "better": "good",
        "best": "good",
        "worse": "bad",
        "worst": "bad",
        "saw": "see",
        "seen": "see",
        "ran": "run",
        "running": "run",
        "children": "child",
        "men": "man",
        "women": "woman",
        "people": "person",
        "feet": "foot",
        "teeth": "tooth",
        "mice": "mouse",
        "took": "take",
        "taken": "take",
        "gave": "give",
        "given": "give",
        "wrote": "write",
        "written": "write",
        "spoke": "speak",
        "spoken": "speak",
        "broke": "break",
        "broken": "break",
        "began": "begin",
        "begun": "begin",
        "bought": "buy",
        "brought": "bring",
        "thought": "think",
        "taught": "teach",
        "caught": "catch",
        "fought": "fight",
        "found": "find",
        "held": "hold",
        "kept": "keep",
        "left": "leave",
        "lost": "lose",
        "made": "make",
        "meant": "mean",
        "met": "meet",
        "paid": "pay",
        "said": "say",
        "sent": "send",
        "spent": "spend",
        "stood": "stand",
        "told": "tell",
        "understood": "understand",
        "won": "win",
        "was": "be",
        "were": "be",
        "been": "be",
        "had": "have",
        "did": "do",
        "done": "do",
        "knew": "know",
        "known": "know",
        "grew": "grow",
        "grown": "grow",
        "drew": "draw",
        "drawn": "draw",
        "flew": "fly",
        "flown": "fly",
        "drove": "drive",
        "driven": "drive",
        "chose": "choose",
        "chosen": "choose",
        "fell": "fall",
        "fallen": "fall",
        "felt": "feel",
        "heard": "hear",
        "built": "build",
        "became": "become",
        "came": "come",
    }
    for form, base in core_irregulars.items():
        if base in selected_set:
            final_lemmas[form] = base

    # Group selected entries into 2-letter prefix shards.
    shards: dict[str, dict[str, Any]] = defaultdict(dict)
    total_senses = 0
    for word in selected_words:
        rec = entries[word]
        meanings: list[dict[str, str]] = []
        # Stable POS ordering: noun, verb, adj, adv, then others.
        pos_order = ["noun", "verb", "adj", "adv", "prep", "conj", "pron", "det", "intj", "num", "phrase"]
        for pos in pos_order:
            if pos in rec["by_pos"]:
                meanings.extend(rec["by_pos"][pos])
        if not meanings:
            continue
        total_senses += len(meanings)
        compact: dict[str, Any] = {"m": meanings}
        if rec["ipa"]:
            compact["ipa"] = rec["ipa"]
        shards[shard_key_for(word)][word] = compact

    out_dir.mkdir(parents=True, exist_ok=True)
    # Clean any stale shard json files in out_dir before writing.
    for old_file in out_dir.glob("*.json"):
        old_file.unlink()

    total_bytes = 0
    for key, payload in sorted(shards.items()):
        shard_path = out_dir / f"{key}.json"
        raw = json.dumps(payload, ensure_ascii=False, separators=(",", ":"))
        shard_path.write_text(raw, encoding="utf-8")
        total_bytes += shard_path.stat().st_size

    lemmas_path = out_dir / "lemmas.json"
    lemmas_raw = json.dumps(
        dict(sorted(final_lemmas.items())), ensure_ascii=False, separators=(",", ":")
    )
    lemmas_path.write_text(lemmas_raw, encoding="utf-8")
    total_bytes += lemmas_path.stat().st_size

    stats = {
        "source": "Kaikki.org Simple English Wiktionary (CC BY-SA 4.0)",
        "sourceUrl": SIMPLE_WIKTIONARY_URL,
        "frequencySource": FREQUENCY_LIST_URL,
        "linesRead": lines_read,
        "words": len(selected_words),
        "senses": total_senses,
        "lemmas": len(final_lemmas),
        "shards": len(shards),
        "totalBytes": total_bytes,
    }
    manifest_path = out_dir / "manifest.json"
    manifest_path.write_text(
        json.dumps(stats, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )
    return stats


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Build static sharded English learner dictionary from Kaikki.org Simple English Wiktionary."
    )
    parser.add_argument(
        "--out",
        type=Path,
        default=Path("public/dict"),
        help="Output directory for static JSON shards (default: public/dict)",
    )
    parser.add_argument(
        "--cache-dir",
        type=Path,
        default=Path(".cache/dict-build"),
        help="Cache directory for downloaded source files",
    )
    parser.add_argument(
        "--max-words",
        type=int,
        default=25000,
        help="Maximum top common English words to keep (default: 25000)",
    )
    parser.add_argument(
        "--max-per-pos",
        type=int,
        default=3,
        help="Maximum definitions per part of speech (default: 3)",
    )
    args = parser.parse_args()

    print(f"[1/3] Downloading frequency list -> {args.cache_dir / 'en_50k.txt'}")
    freq_path = download_if_needed(FREQUENCY_LIST_URL, args.cache_dir / "en_50k.txt")
    freq_ranks = load_frequency_ranks(freq_path, args.max_words)
    print(f"      Loaded {len(freq_ranks):,} frequency-ranked English words.")

    print(
        f"[2/3] Downloading Simple English Wiktionary -> {args.cache_dir / 'simple-extract.jsonl.gz'}"
    )
    wikt_path = download_if_needed(
        SIMPLE_WIKTIONARY_URL, args.cache_dir / "simple-extract.jsonl.gz"
    )

    print(f"[3/3] Parsing and writing shards -> {args.out}")
    stats = build_dictionary(
        jsonl_gz_path=wikt_path,
        freq_ranks=freq_ranks,
        out_dir=args.out,
        max_per_pos=args.max_per_pos,
        max_words=args.max_words,
    )
    print(
        f"Done! {stats['words']:,} words, {stats['senses']:,} senses, "
        f"{stats['lemmas']:,} lemma mappings across {stats['shards']} shards "
        f"({stats['totalBytes'] / (1024 * 1024):.2f} MB)."
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
