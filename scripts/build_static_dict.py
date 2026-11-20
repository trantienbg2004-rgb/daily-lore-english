#!/usr/bin/env python3
"""
One-time builder for SAGA's Tier-2 static sharded learner dictionary + Tier-1.5
static multi-word phrase dictionary ($0 runtime).

Combines two Kaikki.org (Wiktextract) sources for 55,000–65,000 headwords
with build-time commonality ranking (sense score + real-world POS ordering):

1. Source 1 (Priority for simplicity):
   Kaikki.org Simple English Wiktionary (`simple-extract.jsonl.gz`) —
   Cambridge-style simple learner definitions for everyday words (+45 boost).
2. Source 2 (Coverage for news, history, science, C1–C2, proper nouns & acronyms):
   Kaikki.org full English Wiktionary (`kaikki.org-dictionary-English.jsonl.gz`) —
   fills remaining headwords up to ~60,000, adds notable proper nouns (countries,
   US states, regions, empires, peoples) & common acronyms, harvests full
   inflection -> lemma mappings, scores senses by everyday commonality, orders
   POS dynamically by real-world commonality, and extracts ~2,600 high-frequency
   phrasal verbs, multi-word expressions, and idioms into phrases.json.
3. Public English frequency list (`hermitdave/FrequencyWords en_full.txt`) —
   ranks words by real-world English frequency.

Outputs compact static JSON files into /public/dict/:
- /public/dict/lemmas.json   (inflected form -> base lemma map)
- /public/dict/phrases.json  (static phrasal verbs, multi-word expressions & idioms)
- /public/dict/<xx>.json     (2-letter prefix shards, commonality-ordered glosses)
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
import time
import urllib.request
from collections import defaultdict
from pathlib import Path
from typing import Any

SIMPLE_WIKTIONARY_URL = (
    "https://kaikki.org/dictionary/downloads/simple/simple-extract.jsonl.gz"
)
ENGLISH_WIKTIONARY_URL = (
    "https://kaikki.org/dictionary/English/kaikki.org-dictionary-English.jsonl.gz"
)
FREQUENCY_LIST_URL = (
    "https://raw.githubusercontent.com/hermitdave/FrequencyWords/master/content/2018/en/en_full.txt"
)
USER_AGENT = "SAGA-StaticDictBuilder/4.0 (https://saga.id.vn)"

# Always dropped (unsafe, non-word, or pure redirect tags)
HARD_EXCLUDED_TAGS = {
    "offensive",
    "vulgar",
    "derogatory",
    "slur",
    "misspelling",
    "eye-dialect",
    "alt-of",
    "form-of",
}

# Heavily penalized & dropped if 3+ modern senses exist
OBSOLETE_LIKE_TAGS = {
    "archaic",
    "obsolete",
    "rare",
    "dated",
}

# Penalized register/style tags (pushed below everyday standard senses)
LOW_COMMONALITY_TAGS = {
    "dialectal",
    "slang",
    "colloquial",
    "informal",
    "nonstandard",
    "humorous",
    "jocular",
    "historical",
    "poetic",
    "literary",
    "regional",
    "proscribed",
    "euphemistic",
    "pejorative",
    "childish",
    "internet",
    "texting",
}

# Narrow niche domains penalized strongly so everyday meanings appear first
NICHE_DOMAINS = {
    "heraldry", "botany", "mineralogy", "nautical", "chess", "cricket",
    "metallurgy", "foundry", "alchemy", "astrology", "falconry", "fencing",
    "knitting", "sewing", "weaving", "printing", "typography", "mining",
    "forestry", "entomology", "ornithology", "ichthyology", "mycology",
    "bryology", "paleontology", "geology", "crystallography", "petrology",
    "pharmacology", "biochemistry", "cytology", "taxonomy", "zoology",
    "phonetics", "phonology", "prosody", "rhetoric", "theology", "ecclesiastical",
    "canon law", "feudalism", "numismatics", "philately", "archery", "bowling",
    "billiards", "snooker", "golf", "baseball", "poker", "bridge", "mahjong",
    "horology", "hunting", "fishing", "equestrianism", "carpentry", "masonry",
    "plumbing", "brewing", "viticulture", "firearms", "video games", "gaming",
    "roleplaying games", "rail transport", "tarot", "astrology", "occult",
    "wrestling", "boxing", "tennis", "rugby", "hockey", "football", "soccer",
    "cricket", "skiing", "sailing", "rowing", "surfing", "skateboarding",
    "organic chemistry", "inorganic chemistry", "quantum mechanics", "topology",
    "set theory", "graph theory", "category theory", "veterinary medicine",
}

# Broader technical domains penalized mildly relative to general everyday usage
SPECIALIZED_DOMAINS = {
    "law", "legal", "medicine", "surgery", "anatomy", "pathology", "dentistry",
    "computing", "programming", "software", "electronics", "telecommunications",
    "mathematics", "geometry", "algebra", "calculus", "statistics", "logic",
    "physics", "chemistry", "biology", "astronomy", "optics", "acoustics",
    "music", "opera", "ballet", "sports", "military", "aviation", "architecture",
    "linguistics", "grammar", "finance", "accounting", "economics", "politics",
    "religion", "biblical", "judaism", "islam", "christianity", "hinduism",
    "buddhism", "mythology", "philosophy", "sociology", "anthropology",
    "archaeology", "agriculture", "horticulture", "cooking", "gastronomy",
    "fashion", "photography", "film", "theater", "theatre",
}

# Core English function words that must NEVER be filtered out
CORE_FUNCTION_WORDS = {
    "a", "an", "the", "of", "in", "to", "for", "with", "on", "at", "from", "by",
    "about", "as", "into", "like", "through", "after", "over", "between", "out",
    "against", "during", "without", "before", "under", "around", "among", "upon",
    "within", "across", "behind", "beyond", "toward", "towards", "near", "off",
    "up", "down", "above", "below", "along", "until", "till", "since", "while",
    "and", "or", "but", "nor", "yet", "so", "if", "than", "because", "although",
    "though", "unless", "whether", "whereas", "that", "this", "these", "those",
    "it", "its", "itself", "i", "me", "my", "mine", "myself", "we", "us", "our",
    "ours", "ourselves", "you", "your", "yours", "yourself", "yourselves", "he",
    "him", "his", "himself", "she", "her", "hers", "herself", "they", "them",
    "their", "theirs", "themselves", "who", "whom", "whose", "which", "what",
    "where", "when", "why", "how", "is", "am", "are", "was", "were", "be", "been",
    "being", "have", "has", "had", "do", "does", "did", "will", "would", "shall",
    "should", "can", "could", "may", "might", "must", "not", "no", "yes", "all",
    "any", "some", "each", "every", "both", "few", "more", "most", "other", "such",
    "only", "own", "same", "too", "very", "just", "also", "then", "now", "here",
    "there", "still", "even", "ever", "never", "always", "often", "already",
    "again", "once", "twice", "many", "much", "little", "less", "least", "enough",
    "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten",
    "well", "run",
}

MUST_INCLUDE_ACRONYMS = {
    "unesco", "nato", "bbc", "hiv", "gdp", "imf", "osce", "fisu", "eu", "un",
    "usa", "uk", "us", "ai", "dna", "rna", "ceo", "cfo", "ngo", "wto", "who",
    "nasa", "fbi", "cia", "cdc", "fda", "epa", "sec", "fed", "opec", "brics",
    "asean", "apec", "oecd", "cfc", "hfc", "hcfc", "cms", "fm", "am", "tv",
    "pc", "os", "cpu", "gpu", "api", "url", "http", "html", "pdf", "gps", "led",
    "lcd", "usb", "wifi", "sim", "sms", "vat", "ipo", "etf", "esg", "gnp", "cpi",
    "apr", "roi", "kpi", "saas", "iot", "vr", "ar", "ml", "llm", "ev", "aids",
    "sars", "mri", "ct", "icu", "phd", "md", "mba", "rca", "circa", "cpec",
    "cointelpro", "excomm", "teac", "unicef", "unhcr", "icj", "icc", "iaea",
    "ecb", "boeing", "cop", "stem", "lgbt", "ussr", "uae",
}

MUST_INCLUDE_PROPER_NOUNS = {
    "california", "mediterranean", "britain", "africa", "asia", "inca", "athens",
    "america", "austria", "baltic", "australia", "byzantine", "ottoman", "venetian",
    "geneva", "olympia", "albania", "balkan", "algeria", "manhattan", "europe",
    "antarctica", "arctic", "atlantic", "pacific", "indian", "olympic", "roman",
    "greek", "persian", "egyptian", "chinese", "japanese", "korean", "french",
    "german", "british", "english", "spanish", "italian", "russian", "turkish",
    "arab", "islamic", "christian", "jewish", "hindu", "buddhist", "soviet",
    "nazi", "sparta", "spartan", "athenian", "carthage", "mesopotamia", "babylon",
    "anatolia", "levant", "siberia", "scandinavia", "iberia", "sahara", "amazon",
    "nile", "danube", "rhine", "alps", "andes", "himalayas", "sardinia", "antwerp",
    "timbuktu", "eurasia", "bern", "lausanne", "chania", "manchukuo", "palatinate",
    "peloponnesian", "panhellenic", "thucydides", "alcibiades", "marx", "korea",
    "philippine", "philippines", "canada", "canadian", "switzerland", "swiss",
    "france", "paris", "london", "tokyo", "beijing", "moscow", "berlin", "rome",
    "madrid", "vienna", "cairo", "istanbul", "jerusalem", "baghdad", "damascus",
    "delhi", "mumbai", "shanghai", "seoul", "sydney", "melbourne", "toronto",
    "washington", "texas", "florida", "york", "chicago", "boston", "seattle",
    "hollywood", "silicon", "ukraine", "poland", "hungary", "greece", "turkey",
    "china", "august", "march", "may", "iran", "iraq", "israel", "palestine",
    "syria", "lebanon", "jordan", "egypt", "morocco", "tunisia", "libya",
    "ethiopia", "kenya", "nigeria", "ghana", "brazil", "argentina", "mexico",
    "peru", "chile", "colombia", "cuba", "vietnam", "thailand", "indonesia",
    "malaysia", "singapore", "taiwan", "pakistan", "bangladesh", "afghanistan",
    "kazakhstan", "mongolia", "norway", "sweden", "finland", "denmark", "iceland",
    "ireland", "scotland", "wales", "netherlands", "belgium", "portugal", "czech",
    "slovakia", "romania", "bulgaria", "serbia", "croatia", "bosnia", "slovenia",
    "estonia", "latvia", "lithuania", "belarus", "georgia", "armenia", "azerbaijan",
    "cyprus", "malta",
}

COMMON_COMPOUND_PREFIXES = {
    "anti", "auto", "bio", "co", "counter", "cross", "cyber", "eco", "euro",
    "ex", "extra", "far", "first", "full", "geo", "half", "high", "inter",
    "intra", "large", "left", "long", "low", "macro", "meta", "micro", "mid",
    "middle", "mini", "multi", "neo", "new", "non", "off", "old", "one", "open",
    "out", "over", "pan", "part", "post", "pre", "pro", "proto", "pseudo",
    "quasi", "re", "real", "right", "second", "self", "semi", "short", "single",
    "small", "state", "sub", "super", "third", "three", "time", "top", "trans",
    "two", "ultra", "un", "under", "up", "well", "wide", "world", "zero",
    "eighteenth", "nineteenth", "twentieth", "seventeenth", "sixteenth",
    "twenty", "thirty", "forty", "fifty", "sixty", "seventy", "eighty", "ninety",
    "german", "english", "french", "spanish", "arabic", "chinese", "russian",
}

SIMPLE_POS_MAP = {
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
    "article": "det",
    "particle": "adv",
    "postp": "prep",
    "intj": "intj",
    "interjection": "intj",
    "num": "num",
    "phrase": "phrase",
    "prep_phrase": "phrase",
    "contraction": "contraction",
    "name": "proper noun",
}

EN_POS_MAP = dict(SIMPLE_POS_MAP)

PHRASE_PARTICLES = {
    "up", "down", "out", "in", "on", "off", "over", "away", "back", "through",
    "into", "for", "from", "to", "with", "about", "around", "by", "after",
    "along", "apart", "aside", "forward", "together", "upon", "of", "at",
    "ahead", "behind", "across", "against", "under",
}

PHRASE_STOP_LIST = {
    "go to", "be to", "get to", "try to", "need to", "like to", "love to",
    "want to", "have to", "come to", "seem to", "start to", "begin to",
    "make it", "take it", "do it", "get it", "see it", "know it", "say it",
    "for the", "in the", "of the", "on the", "to the", "at the", "by the",
    "with the", "from the", "as a", "in a", "on a", "at a", "of a", "to a",
    "for a", "is a", "was a", "are a", "were a", "be a", "as to", "of all",
    "to be", "or not", "if not", "is not", "do not", "did not", "will not",
    "can not", "cannot be", "all of", "one of", "some of", "most of", "many of",
    "part of", "kind of", "sort of", "type of", "number of", "lot of",
    "there is", "there are", "it is", "this is", "that is", "he is", "she is",
    "they are", "we are", "you are", "i am", "a lot", "a bit", "a few",
    "the same", "each other", "one another", "as if", "so that", "in that",
    "by then", "until then", "since then", "from then", "and so", "or so",
    "too much", "very much", "so much", "how much", "how many", "not only",
    "as much", "as many", "more than", "less than", "other than",
}

CURATED_PHRASES: dict[str, tuple[str, str]] = {
    "such as": ("phrase", "For example; of the kind or types mentioned."),
    "rather than": ("phrase", "Instead of; in preference to."),
    "prior to": ("phrase", "Before a particular time or event."),
    "out of": ("phrase", "From inside something; because of or using a source; no longer having."),
    "instead of": ("phrase", "In place of someone or something else."),
    "over time": ("phrase", "Gradually, across a period of time."),
    "according to": ("phrase", "As stated or reported by a person, source, or rule."),
    "due to": ("phrase", "Caused by or resulting from something."),
    "even though": ("phrase", "Despite the fact that; although."),
    "side by side": ("phrase", "Next to each other; working or existing together at the same time."),
    "in favor of": ("phrase", "Supporting or preferring one person, idea, or option over another."),
    "in favour of": ("phrase", "Supporting or preferring one person, idea, or option over another."),
    "far from": ("phrase", "At a great distance from; not at all."),
    "at least": ("phrase", "Not less than a certain amount; if nothing else."),
    "in terms of": ("phrase", "With regard to a particular aspect, measure, or subject."),
    "as a result": ("phrase", "Consequently; because of what just happened."),
    "on the other hand": ("phrase", "Used to introduce a contrasting point or opposite perspective."),
    "as well as": ("phrase", "In addition to; and also."),
    "as long as": ("phrase", "Provided that; for the entire time that."),
    "as opposed to": ("phrase", "In contrast with; rather than."),
    "as soon as": ("phrase", "Immediately at or after the moment something happens."),
    "at first": ("phrase", "At the beginning, before things changed."),
    "at risk": ("phrase", "Exposed to danger, harm, or possible loss."),
    "at stake": ("phrase", "At risk of being won, lost, or damaged depending on an outcome."),
    "at the same time": ("phrase", "Happening together; however, considering another point."),
    "because of": ("phrase", "By reason of; as a result of."),
    "by contrast": ("phrase", "Used to highlight a clear difference from what was just mentioned."),
    "by means of": ("phrase", "With the help of; using a particular method or tool."),
    "contrary to": ("phrase", "Opposite to or conflicting with something."),
    "for example": ("phrase", "Used to introduce an illustration of what was just said."),
    "for instance": ("phrase", "As an example."),
    "hand in hand": ("phrase", "Closely connected and happening together; holding hands."),
    "in addition": ("phrase", "Furthermore; as an extra point or item."),
    "in addition to": ("phrase", "Besides; as well as."),
    "in charge of": ("phrase", "Having control, authority, or responsibility over something."),
    "in contrast": ("phrase", "Used to show a clear difference between two things."),
    "in contrast to": ("phrase", "Unlike; showing a clear difference from."),
    "in effect": ("phrase", "In practice or reality; officially active as a law or rule."),
    "in fact": ("phrase", "In reality; used to emphasize or clarify the truth."),
    "in general": ("phrase", "Usually; considering most cases overall."),
    "in light of": ("phrase", "Considering or taking into account new facts or circumstances."),
    "in order to": ("phrase", "With the purpose of doing something."),
    "in particular": ("phrase", "Especially; specifically."),
    "in place": ("phrase", "Established and ready to operate; in the proper position."),
    "in practice": ("phrase", "In actual use or reality, as opposed to theory."),
    "in response to": ("phrase", "As an answer or reaction to something."),
    "in return": ("phrase", "As an exchange, repayment, or response for something given."),
    "in spite of": ("phrase", "Without being prevented by; despite."),
    "in the wake of": ("phrase", "Following closely after, often as a consequence of a major event."),
    "in theory": ("phrase", "According to an abstract idea or rule, though not always in reality."),
    "in turn": ("phrase", "As a result in a sequence; one after another."),
    "no longer": ("phrase", "Not anymore; stopped happening or being true."),
    "on behalf of": ("phrase", "Acting for or representing another person, group, or organization."),
    "on track": ("phrase", "Making steady progress toward a planned goal or schedule."),
    "regardless of": ("phrase", "Without being affected or influenced by something."),
    "so far": ("phrase", "Up to the present moment."),
    "step by step": ("phrase", "Gradually, proceeding carefully from one stage to the next."),
    "subject to": ("phrase", "Dependent upon, governed by, or likely to experience something."),
    "thanks to": ("phrase", "Because of the help or positive effect of someone or something."),
    "under pressure": ("phrase", "Facing urgent demands, stress, or persuasion to act."),
    "up to": ("phrase", "As much or as many as; depending on someone's decision."),
    "with regard to": ("phrase", "Concerning or relating to a particular topic."),
    "with respect to": ("phrase", "Concerning or in relation to something."),
    "used to": ("phrase", "Accustomed to; describing a past habit or state that no longer continues."),
    "a number of": ("phrase", "Several; an unspecified but notable quantity of."),
    "as far as": ("phrase", "To the extent or distance that."),
    "at once": ("phrase", "Immediately; at the same time."),
    "by far": ("phrase", "By a great amount or margin."),
    "by no means": ("phrase", "Not at all; certainly not."),
    "day to day": ("phrase", "Happening every day as part of normal routine."),
    "face to face": ("phrase", "Directly in person, looking at each other."),
    "first of all": ("phrase", "Before anything else; as the most important point."),
    "for good": ("phrase", "Permanently; forever."),
    "from scratch": ("phrase", "From the very beginning, without using anything prepared earlier."),
    "in brief": ("phrase", "In a few words; concisely."),
    "in common": ("phrase", "Shared by two or more people or things."),
    "in detail": ("phrase", "Thoroughly, including many small facts."),
    "in full": ("phrase", "Completely, without leaving anything out."),
    "in line with": ("phrase", "In agreement with or matching a rule, standard, or trend."),
    "in part": ("phrase", "Partly; to some extent."),
    "in public": ("phrase", "Openly, where other people can see or hear."),
    "in short": ("phrase", "To summarize briefly."),
    "in the long run": ("phrase", "Over a long period of time; eventually."),
    "in time": ("phrase", "Early enough; eventually, as time passes."),
    "of course": ("phrase", "Naturally; certainly; as expected."),
    "on average": ("phrase", "Typically, based on the mathematical mean."),
    "on board": ("phrase", "Aboard a ship, plane, or train; agreeing to support a plan."),
    "on the whole": ("phrase", "Considering everything overall; in general."),
    "on time": ("phrase", "At the scheduled or expected time; punctually."),
    "out of date": ("phrase", "Old-fashioned or no longer valid or accurate."),
    "up to date": ("phrase", "Current; including the latest information or technology."),
    "vice versa": ("phrase", "With the two main items or roles reversed."),
    # High-frequency phrasal verbs
    "rely on": ("phrasal verb", "To depend on or trust someone or something for support or success."),
    "rely upon": ("phrasal verb", "To depend on or trust someone or something."),
    "come from": ("phrasal verb", "To originate in a place, family, source, or cause."),
    "call for": ("phrasal verb", "To publicly demand, require, or make something necessary."),
    "grow out of": ("phrasal verb", "To develop or originate from an earlier idea, event, or movement; to become too big or mature for."),
    "stem from": ("phrasal verb", "To originate from or be caused by something."),
    "grow up": ("phrasal verb", "To develop from childhood into adulthood; to arise gradually."),
    "focus on": ("phrasal verb", "To direct attention, effort, or study specifically toward something."),
    "depend on": ("phrasal verb", "To be determined by or need the support of something or someone."),
    "depend upon": ("phrasal verb", "To be determined by or need the support of something or someone."),
    "break down": ("phrasal verb", "To stop working or fail (such as talks or a machine); to divide into smaller parts."),
    "account for": ("phrasal verb", "To make up a specified share of a total; to explain the cause of something."),
    "break out": ("phrasal verb", "To begin suddenly (such as a war, fire, or disease); to escape."),
    "bring together": ("phrasal verb", "To unite people, groups, or ideas in one place or common effort."),
    "carry out": ("phrasal verb", "To perform, execute, or complete a task, plan, or study."),
    "set up": ("phrasal verb", "To establish, organize, or arrange something so it is ready to operate."),
    "point out": ("phrasal verb", "To draw attention to a fact, detail, or mistake."),
    "take over": ("phrasal verb", "To assume control, ownership, or responsibility for something."),
    "look into": ("phrasal verb", "To investigate or examine a matter carefully."),
    "come up with": ("phrasal verb", "To think of or produce an idea, plan, or solution."),
    "adapt to": ("phrasal verb", "To adjust to new conditions, environments, or requirements."),
    "add up": ("phrasal verb", "To calculate a total; to make logical sense."),
    "back up": ("phrasal verb", "To support a claim or person; to make a spare copy of data."),
    "break through": ("phrasal verb", "To force a way past a barrier or achieve a major advance."),
    "break up": ("phrasal verb", "To split into smaller pieces; to end a relationship or organization."),
    "bring about": ("phrasal verb", "To cause something to happen."),
    "bring back": ("phrasal verb", "To restore something from the past; to return with something."),
    "bring down": ("phrasal verb", "To reduce a level or price; to cause a leader or government to fall."),
    "build up": ("phrasal verb", "To gradually increase, strengthen, or accumulate over time."),
    "call off": ("phrasal verb", "To cancel a planned event or activity."),
    "carry on": ("phrasal verb", "To continue doing something despite difficulty."),
    "catch on": ("phrasal verb", "To become popular or widely adopted; to understand."),
    "catch up": ("phrasal verb", "To reach the same level, standard, or position as others."),
    "clear up": ("phrasal verb", "To resolve confusion or a problem; to become bright or tidy."),
    "come across": ("phrasal verb", "To find or encounter by chance; to give a certain impression."),
    "come back": ("phrasal verb", "To return to a place, condition, or former popularity."),
    "come down": ("phrasal verb", "To fall or decrease; to be passed down through history."),
    "come out": ("phrasal verb", "To be published, released, or become publicly known."),
    "come up": ("phrasal verb", "To arise or be mentioned in discussion; to approach."),
    "cut back": ("phrasal verb", "To reduce spending, production, or consumption."),
    "cut down": ("phrasal verb", "To reduce the amount of something; to fell a tree."),
    "cut off": ("phrasal verb", "To disconnect, isolate, or abruptly stop a supply or connection."),
    "deal with": ("phrasal verb", "To handle, manage, or take action regarding a problem or topic."),
    "die out": ("phrasal verb", "To become completely extinct or disappear gradually."),
    "draw on": ("phrasal verb", "To make use of a supply, resource, or past experience."),
    "draw upon": ("phrasal verb", "To make use of a supply, resource, or past experience."),
    "end up": ("phrasal verb", "To eventually reach a particular state, place, or outcome."),
    "fall apart": ("phrasal verb", "To break into pieces; to collapse or fail completely."),
    "fall behind": ("phrasal verb", "To fail to keep pace with others or with a schedule."),
    "figure out": ("phrasal verb", "To understand or solve something through careful thought."),
    "fill in": ("phrasal verb", "To supply missing information; to act as a temporary substitute."),
    "find out": ("phrasal verb", "To discover or learn a fact or piece of information."),
    "get rid of": ("phrasal verb", "To remove, discard, or free oneself from something unwanted."),
    "give rise to": ("phrasal verb", "To cause or trigger the beginning of something."),
    "give up": ("phrasal verb", "To stop trying or surrender; to quit a habit or claim."),
    "give way to": ("phrasal verb", "To be replaced by something else; to yield or collapse."),
    "go on": ("phrasal verb", "To continue happening or speaking; to proceed."),
    "go through": ("phrasal verb", "To experience something difficult; to examine carefully or pass through."),
    "hand over": ("phrasal verb", "To transfer control, power, or possession to someone else."),
    "hold back": ("phrasal verb", "To restrain, delay, or keep something secret or under control."),
    "hold on": ("phrasal verb", "To grip tightly; to wait briefly or endure."),
    "keep up": ("phrasal verb", "To maintain the same speed, level, or ongoing effort."),
    "keep up with": ("phrasal verb", "To stay at the same pace or stay informed about rapid changes."),
    "lay off": ("phrasal verb", "To dismiss workers from employment, usually for economic reasons."),
    "lead to": ("phrasal verb", "To cause or result in a particular outcome."),
    "look after": ("phrasal verb", "To take care of or be responsible for someone or something."),
    "look for": ("phrasal verb", "To search for or try to obtain something."),
    "look forward to": ("phrasal verb", "To anticipate a future event with pleasure or expectation."),
    "make sense": ("phrasal verb", "To be logical, clear, or reasonable."),
    "make up": ("phrasal verb", "To constitute or form a whole; to invent a story; to reconcile."),
    "make up for": ("phrasal verb", "To compensate for a loss, flaw, or missed opportunity."),
    "make use of": ("phrasal verb", "To employ or utilize something effectively."),
    "move on": ("phrasal verb", "To leave one place, topic, or stage behind and progress to the next."),
    "open up": ("phrasal verb", "To make accessible, available, or open to trade, travel, or discussion."),
    "pass away": ("phrasal verb", "To die (a polite expression)."),
    "pass down": ("phrasal verb", "To hand on knowledge, property, or traditions to younger generations."),
    "pass on": ("phrasal verb", "To transmit information or goods to another person; to decline."),
    "pay attention to": ("phrasal verb", "To watch, listen to, or consider something carefully."),
    "pay off": ("phrasal verb", "To yield good results; to finish repaying a debt."),
    "phase out": ("phrasal verb", "To gradually stop using or producing something in stages."),
    "pick up": ("phrasal verb", "To lift or collect; to learn informally; to increase in pace."),
    "play a role": ("phrasal verb", "To have a part or influence in causing or shaping something."),
    "play out": ("phrasal verb", "To unfold or develop to a conclusion."),
    "pull out": ("phrasal verb", "To withdraw troops, support, or participation from an area or agreement."),
    "push back": ("phrasal verb", "To resist or oppose a proposal; to postpone a scheduled date."),
    "put forward": ("phrasal verb", "To propose an idea, plan, or candidate for consideration."),
    "put off": ("phrasal verb", "To postpone to a later time; to discourage."),
    "put together": ("phrasal verb", "To assemble parts into a whole; to organize a team or plan."),
    "result in": ("phrasal verb", "To produce or lead to a particular consequence."),
    "roll out": ("phrasal verb", "To officially launch or introduce a new product, system, or policy."),
    "rule out": ("phrasal verb", "To exclude or decide that something is impossible or unsuitable."),
    "run into": ("phrasal verb", "To encounter a problem or meet someone unexpectedly."),
    "run out": ("phrasal verb", "To use up all of a supply so none remains; to expire."),
    "run out of": ("phrasal verb", "To exhaust the remaining supply of something."),
    "scale up": ("phrasal verb", "To increase the size, volume, or capacity of an operation."),
    "set off": ("phrasal verb", "To start a journey; to trigger a chain of events or an explosion."),
    "set out": ("phrasal verb", "To begin a journey or ambitious effort; to explain clearly in writing."),
    "show up": ("phrasal verb", "To arrive or appear, especially at a gathering or in data."),
    "shut down": ("phrasal verb", "To close a business, facility, or machine permanently or temporarily."),
    "slow down": ("phrasal verb", "To reduce speed, growth, or intensity."),
    "speed up": ("phrasal verb", "To move, grow, or happen faster."),
    "stand for": ("phrasal verb", "To represent or be an abbreviation for; to support a principle."),
    "stand out": ("phrasal verb", "To be noticeably better, clearer, or more prominent than others."),
    "step down": ("phrasal verb", "To resign or retire from an official post or leadership role."),
    "step up": ("phrasal verb", "To increase effort, action, or output; to take responsibility."),
    "take advantage of": ("phrasal verb", "To make good use of an opportunity; to exploit unfairly."),
    "take away": ("phrasal verb", "To remove something; to subtract."),
    "take off": ("phrasal verb", "To leave the ground in flight; to suddenly become very successful."),
    "take on": ("phrasal verb", "To accept a task, responsibility, or challenge; to acquire a quality."),
    "take part in": ("phrasal verb", "To participate in an event or activity."),
    "take place": ("phrasal verb", "To happen or occur, especially as planned."),
    "take up": ("phrasal verb", "To start a hobby or job; to occupy space or time; to address an issue."),
    "turn down": ("phrasal verb", "To reject an offer or request; to lower volume or heat."),
    "turn into": ("phrasal verb", "To transform or develop into something different."),
    "turn out": ("phrasal verb", "To prove to be the case in the end; to attend an event or produce."),
    "wipe out": ("phrasal verb", "To destroy completely or eliminate."),
    "work out": ("phrasal verb", "To solve or calculate; to succeed as planned; to exercise."),
    "belong to": ("phrasal verb", "To be owned by or be a member of a group or category."),
    "consist of": ("phrasal verb", "To be composed or made up of specific parts."),
    "contribute to": ("phrasal verb", "To help cause or add to a result or effort."),
    "refer to": ("phrasal verb", "To mention, describe, or direct attention to something."),
    "respond to": ("phrasal verb", "To react or reply to an event, message, or stimulus."),
    "serve as": ("phrasal verb", "To function or act in a particular role."),
    "turn to": ("phrasal verb", "To seek help from; to shift attention or direction toward."),
    "give in": ("phrasal verb", "To surrender or finally agree after resisting."),
    "hold out": ("phrasal verb", "To continue resisting or enduring; to offer hope."),
    "lay down": ("phrasal verb", "To establish a rule or principle; to put down weapons."),
    "put in": ("phrasal verb", "To invest time or effort; to install or submit."),
    "put up": ("phrasal verb", "To build or erect; to provide lodging; to offer resistance."),
    "put up with": ("phrasal verb", "To tolerate or endure something unpleasant."),
    "set aside": ("phrasal verb", "To reserve for a special purpose; to temporarily disregard."),
    "take back": ("phrasal verb", "To retract a statement; to reclaim possession."),
    "take in": ("phrasal verb", "To absorb or understand; to include; to shelter someone."),
    "watch out": ("phrasal verb", "To be careful and alert for danger."),
    "wear off": ("phrasal verb", "To gradually lose effect or intensity."),
    "wear out": ("phrasal verb", "To become damaged from heavy use; to exhaust completely."),
    "write off": ("phrasal verb", "To cancel a bad debt; to dismiss as a failure or loss."),
}

INFLECTION_GLOSS_RE = re.compile(
    r"^(?:the\s+)?(?:"
    r"plural|past\s+tense(?:\s+and\s+past\s+participle)?|"
    r"simple\s+past(?:\s+and\s+past\s+participle)?|"
    r"past\s+participle|present\s+participle|"
    r"third[- ]person\s+singular(?:\s+simple\s+present(?:\s+indicative)?)?|"
    r"comparative|superlative|inflection|gerund"
    r")(?:\s+form)?\s+of\s+([a-z][a-z'-]{0,30})\b",
    re.IGNORECASE,
)

STUB_GLOSS_RE = re.compile(
    r"^(?:"
    r"another\s+way\s+to\s+spell|"
    r"a\s+different\s+spelling\s+of|"
    r"alternative\s+(?:spelling|form|letter[- ]case\s+form|capitalization)\s+of|"
    r"spelling\s+variant\s+of|"
    r"misspelling\s+of|"
    r"obsolete\s+(?:spelling|form)\s+of|"
    r"archaic\s+(?:spelling|form)\s+of|"
    r"dated\s+(?:spelling|form)\s+of|"
    r"nonstandard\s+(?:spelling|form)\s+of|"
    r"eye\s+dialect\s+spelling\s+of|"
    r"clipping\s+of|"
    r"ellipsis\s+of|"
    r"short\s+for\b|"
    r"synonym\s+of\b|"
    r"see\s+also\b"
    r")",
    re.IGNORECASE,
)

ACRONYM_GLOSS_RE = re.compile(
    r"^(?:initialism|acronym|abbreviation)\s+of\s+(.+)",
    re.IGNORECASE,
)

SURNAME_OR_GIVEN_RE = re.compile(
    r"^(?:a\s+)?(?:(?:english|scottish|irish|welsh|french|german|italian|spanish|polish|"
    r"dutch|swedish|norwegian|danish|russian|greek|jewish|hungarian|czech|catalan|"
    r"portuguese|topographic|habitational|occupational|patronymic|metronymic|diminutive|"
    r"male|female|unisex|transferred\s+use\s+of\s+the)\s+)*"
    r"(?:surname|given\s+name|forename|family\s+name)\b",
    re.IGNORECASE,
)

LEADING_PAREN_RE = re.compile(r"^\(([^()]{1,75})\)\s*")
INLINE_REGISTER_PAREN_RE = re.compile(
    r"\s*\((?:chiefly|usually|often|sometimes|especially|now|formerly|originally|"
    r"literally|figuratively|transitive|intransitive|countable|uncountable|"
    r"US|UK|Britain|British|American|Australia|Canada|informal|formal|"
    r"humorous|jocular|pejorative|rare|dated|archaic|obsolete|slang|"
    r"grammar|linguistics|law|medicine|biology|chemistry|physics|mathematics|"
    r"computing|finance|economics|politics|military|nautical|music|sports|"
    r"botany|zoology|anatomy|astronomy|geology|electronics|engineering)"
    r"[^()]{0,45}\)",
    re.IGNORECASE,
)

CLEAN_WORD_RE = re.compile(r"^[a-z]+(?:[-'][a-z]+)*$")
CLEAN_PHRASE_RE = re.compile(r"^[a-z]+(?: [a-z]+){1,3}$")

INFLECTION_FORM_TAGS = {
    "plural",
    "past",
    "participle",
    "present",
    "third-person",
    "comparative",
    "superlative",
    "gerund",
}

CANONICAL_FORM_TAGS = {
    "canonical",
    "positive",
    "singular",
    "infinitive",
}

CORE_IRREGULARS = {
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
    "is": "be",
    "am": "be",
    "are": "be",
    "had": "have",
    "has": "have",
    "did": "do",
    "done": "do",
    "does": "do",
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
    "led": "lead",
    "lit": "light",
    "risen": "rise",
    "rose": "rise",
    "sank": "sink",
    "sunk": "sink",
    "shook": "shake",
    "shaken": "shake",
    "struck": "strike",
    "swore": "swear",
    "sworn": "swear",
    "tore": "tear",
    "torn": "tear",
    "wore": "wear",
    "worn": "wear",
    "withdrew": "withdraw",
    "withdrawn": "withdraw",
    "dealt": "deal",
    "sped": "speed",
    "laid": "lay",
    "relied": "rely",
    "relies": "rely",
    "relying": "rely",
    "stemmed": "stem",
    "stemming": "stem",
    "carried": "carry",
    "carries": "carry",
    "carrying": "carry",
    "bringing": "bring",
    "depending": "depend",
    "breaking": "break",
    "growing": "grow",
    "taking": "take",
    "giving": "give",
    "making": "make",
    "coming": "come",
    "putting": "put",
    "setting": "set",
    "cutting": "cut",
    "shutting": "shut",
    "stepping": "step",
    "stepped": "step",
    "stopped": "stop",
    "stopping": "stop",
    "focusing": "focus",
    "focused": "focus",
    "focussed": "focus",
    "focussing": "focus",
}


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
    with urllib.request.urlopen(req, timeout=120) as resp, tmp.open("wb") as out:
        shutil.copyfileobj(resp, out, length=1024 * 1024)
    tmp.replace(dest)
    return dest


def load_frequency_ranks(path: Path, max_entries: int) -> dict[str, int]:
    ranks: dict[str, int] = {}
    with path.open("r", encoding="utf-8", errors="ignore") as f:
        for line in f:
            parts = line.strip().split()
            if not parts:
                continue
            word = parts[0].lower()
            if len(word) > 28 or not CLEAN_WORD_RE.match(word):
                continue
            if word not in ranks:
                ranks[word] = len(ranks) + 1
                if len(ranks) >= max_entries:
                    break
    return ranks


def pick_ipa(sounds: list[dict[str, Any]] | None) -> str:
    if not sounds:
        return ""
    preferred: list[tuple[int, str]] = []
    for s in sounds:
        ipa = (s.get("ipa") or "").strip()
        if not ipa or len(ipa) > 40:
            continue
        tags = {str(t).lower() for t in (s.get("tags") or [])}
        if "us" in tags or "general-american" in tags or "general american" in tags:
            prio = 0
        elif "uk" in tags or "rp" in tags or "received-pronunciation" in tags:
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


def extract_leading_parens(gloss: str) -> set[str]:
    found: set[str] = set()
    cur = gloss.strip()
    for _ in range(4):
        m = LEADING_PAREN_RE.match(cur)
        if not m:
            break
        inner = m.group(1).lower()
        for piece in re.split(r"[,;/]", inner):
            p = piece.strip()
            if p:
                found.add(p)
        cur = cur[m.end():].strip()
    return found


def clean_and_shorten_definition(gloss: str, max_chars: int = 140) -> str:
    text = re.sub(r"\s+", " ", gloss).strip()
    if not text:
        return ""

    for _ in range(4):
        stripped = LEADING_PAREN_RE.sub("", text).strip()
        if stripped == text or not stripped:
            break
        text = stripped

    text = INLINE_REGISTER_PAREN_RE.sub("", text)
    text = re.sub(r"\s+([,.;:!?])", r"\1", text)
    text = re.sub(r"\s+", " ", text).strip(" ;:")
    if len(text) < 4:
        return ""

    if text[0].islower():
        text = text[0].upper() + text[1:]

    if len(text) <= max_chars:
        return text

    m = re.search(r"[.!?][\"'”’]?(?=\s|$)", text)
    if m and 16 <= m.end() <= max_chars:
        return text[: m.end()].strip()

    semi = text.find(";")
    if 20 <= semi <= max_chars - 1:
        return text[:semi].strip() + "."

    clipped = text[: max_chars - 1]
    if " " in clipped:
        clipped = clipped.rsplit(" ", 1)[0]
    return clipped.rstrip(" ,;:-") + "…"


def normalize_form_text(raw: str) -> str:
    text = re.sub(r"\s+", " ", str(raw or "")).strip().lower()
    if not text or " " in text or len(text) > 28:
        return ""
    if not CLEAN_WORD_RE.match(text):
        return ""
    return text


def harvest_entry_forms(
    word: str,
    forms: list[dict[str, Any]],
    raw_lemmas: dict[str, set[str]],
) -> None:
    for f in forms:
        f_val = normalize_form_text(f.get("form") or "")
        if not f_val or f_val == word:
            continue
        f_tags = {str(t).lower() for t in (f.get("tags") or [])}
        f_raw = {str(t).lower() for t in (f.get("raw_tags") or [])}
        all_f_tags = f_tags | f_raw
        if all_f_tags & CANONICAL_FORM_TAGS:
            raw_lemmas[word].add(f_val)
        elif all_f_tags & INFLECTION_FORM_TAGS:
            raw_lemmas[f_val].add(word)


def score_sense_commonality(
    sense: dict[str, Any],
    raw_gloss: str,
    short_def: str,
    order_idx: int,
    *,
    from_simple: bool,
    is_proper_noun: bool,
) -> tuple[float, bool, bool, bool]:
    """
    Score a single sense from MOST COMMON everyday usage to LEAST COMMON.

    Returns (score, is_obsolete_like, is_niche_or_low, has_examples).
    """
    tags = {str(t).lower() for t in (sense.get("tags") or [])}
    raw_tags = {str(t).lower() for t in (sense.get("raw_tags") or [])}
    topics = {str(t).lower() for t in (sense.get("topics") or [])}
    paren_labels = extract_leading_parens(raw_gloss)
    all_labels = tags | raw_tags | topics | paren_labels

    # Check obsolete/archaic/rare/dated
    is_obsolete_like = bool(all_labels & OBSOLETE_LIKE_TAGS) or any(
        bad in lbl for lbl in all_labels for bad in ("archaic", "obsolete", "rare", "dated")
    )

    # Check slang / dialectal / colloquial / historical
    low_tags = LOW_COMMONALITY_TAGS - ({"historical"} if is_proper_noun else set())
    is_low_register = bool(all_labels & low_tags) or any(
        bad in lbl for lbl in all_labels for bad in ("slang", "dialect", "colloquial", "nonstandard")
    )

    # Check narrow niche domains vs broader specialized domains
    is_niche_domain = bool(all_labels & NICHE_DOMAINS) or any(
        dom in lbl for lbl in paren_labels for dom in ("heraldry", "botany", "mineralogy", "nautical", "chess", "cricket", "baseball", "metallurgy", "foundry")
    )
    is_specialized = bool(all_labels & SPECIALIZED_DOMAINS)

    # Extra check: sport/niche keyword directly in short gloss (e.g. "A run in baseball...")
    low_def = short_def.lower()
    if any(kw in low_def for kw in ("in baseball", "in cricket", "in chess", "in heraldry", "in golf", "in poker", "in billiards")):
        is_niche_domain = True

    examples = sense.get("examples") or []
    example_count = len(examples)
    has_examples = example_count > 0

    score = 100.0
    if from_simple:
        score += 45.0

    # Everyday usage examples boost
    if example_count >= 2:
        score += 20.0
    elif example_count == 1:
        score += 14.0

    # Earlier sense in Wiktionary entry gets moderate preference
    score += max(0.0, 12.0 - order_idx * 2.0)

    # General usage boost (no domain topics, no niche/register/obsolete tags)
    if not is_obsolete_like and not is_low_register and not is_niche_domain and not is_specialized and not topics:
        score += 18.0

    # Penalties
    if is_obsolete_like:
        score -= 75.0
    if is_low_register:
        score -= 45.0
    if is_niche_domain:
        score -= 42.0
    elif is_specialized:
        score -= 18.0

    # Proper noun surname/given-name penalty so countries/places beat surnames
    if is_proper_noun and SURNAME_OR_GIVEN_RE.match(short_def):
        score -= 60.0

    return score, is_obsolete_like, (is_niche_domain or is_low_register), has_examples


def extract_scored_senses(
    word: str,
    pos: str,
    senses: list[dict[str, Any]],
    raw_lemmas: dict[str, set[str]],
    max_chars: int,
    *,
    from_simple: bool = False,
    is_acronym: bool = False,
    is_proper_noun: bool = False,
    collect_lemmas: bool = True,
) -> tuple[list[dict[str, Any]], int, int]:
    """
    Extract and score candidate senses.
    Returns (scored_senses, modern_general_count, example_sense_count).
    """
    out: list[dict[str, Any]] = []
    seen_lower: set[str] = set()
    modern_count = 0
    example_count = 0

    for idx, sense in enumerate(senses):
        form_refs = sense.get("form_of") or []
        if collect_lemmas:
            for ref in form_refs:
                ref_w = normalize_form_text(ref.get("word") or "")
                if ref_w and ref_w != word:
                    raw_lemmas[word].add(ref_w)

        if form_refs or sense.get("alt_of"):
            continue

        tags = {str(t).lower() for t in (sense.get("tags") or [])}
        raw_tags = {str(t).lower() for t in (sense.get("raw_tags") or [])}
        all_tags = tags | raw_tags
        if all_tags & HARD_EXCLUDED_TAGS:
            continue
        if any(bad in t for t in all_tags for bad in ("offensive", "vulgar", "slur", "derogatory", "misspelling")):
            continue

        glosses = sense.get("glosses") or []
        if not glosses:
            continue
        raw_gloss = str(glosses[0]).strip()
        if not raw_gloss:
            continue

        infl_match = INFLECTION_GLOSS_RE.match(raw_gloss)
        if infl_match:
            if collect_lemmas:
                target = normalize_form_text(infl_match.group(1))
                if target and target != word:
                    raw_lemmas[word].add(target)
            continue

        gloss_for_clean = raw_gloss
        acro_match = ACRONYM_GLOSS_RE.match(raw_gloss)
        if acro_match:
            expansion = acro_match.group(1).strip()
            if is_acronym or (" " in expansion and len(expansion) >= 6):
                gloss_for_clean = expansion
            else:
                continue
        elif STUB_GLOSS_RE.match(raw_gloss):
            continue

        short_def = clean_and_shorten_definition(gloss_for_clean, max_chars=max_chars)
        if not short_def:
            continue

        low = short_def.lower()
        if low in seen_lower:
            continue
        seen_lower.add(low)

        score, is_obsolete_like, is_niche_or_low, has_examples = score_sense_commonality(
            sense,
            raw_gloss,
            short_def,
            idx,
            from_simple=from_simple,
            is_proper_noun=is_proper_noun,
        )

        # Skip pure surname/given-name entries for non-curated proper nouns
        if is_proper_noun and SURNAME_OR_GIVEN_RE.match(short_def) and word not in MUST_INCLUDE_PROPER_NOUNS:
            continue

        if not is_obsolete_like:
            modern_count += 1
        if has_examples:
            example_count += 1

        out.append({
            "p": pos,
            "d": short_def,
            "score": score,
            "simple": from_simple,
            "obsolete": is_obsolete_like,
            "niche": is_niche_or_low,
            "has_ex": has_examples,
        })

    return out, modern_count, example_count


def new_word_record() -> dict[str, Any]:
    return {
        "ipa": "",
        "by_pos": defaultdict(list),
        "pos_stats": defaultdict(lambda: {"simple_modern": 0, "en_modern": 0, "en_examples": 0}),
    }


def merge_scored_senses(
    rec: dict[str, Any],
    pos: str,
    senses: list[dict[str, Any]],
    modern_count: int,
    example_count: int,
    *,
    from_simple: bool,
) -> None:
    stats = rec["pos_stats"][pos]
    if from_simple:
        stats["simple_modern"] += modern_count
    else:
        stats["en_modern"] += modern_count
        stats["en_examples"] += example_count

    bucket = rec["by_pos"][pos]
    existing_lower = {item["d"].lower() for item in bucket}
    # Keep top candidates per POS during streaming so memory stays compact
    for s in senses:
        low = s["d"].lower()
        if low in existing_lower:
            continue
        existing_lower.add(low)
        bucket.append(s)

    if len(bucket) > 12:
        bucket.sort(key=lambda x: (-x["score"], 0 if x["simple"] else 1, len(x["d"])))
        del bucket[12:]


def is_interesting_hyphenated_compound(word: str, freq_ranks: dict[str, int]) -> bool:
    if "-" not in word or word.count("-") > 2:
        return False
    parts = word.split("-")
    if any(len(p) < 2 for p in parts):
        return False
    for p in parts:
        if p in COMMON_COMPOUND_PREFIXES:
            continue
        if freq_ranks.get(p, 999999) <= 25000:
            continue
        return False
    return True


def ingest_simple_wiktionary(
    jsonl_gz_path: Path,
    entries: dict[str, dict[str, Any]],
    simple_words: set[str],
    phrase_entries: dict[str, dict[str, Any]],
    raw_lemmas: dict[str, set[str]],
    max_chars: int,
) -> int:
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
            raw_pos = str(obj.get("pos") or "").lower()

            if " " in word:
                if (
                    len(word) <= 36
                    and CLEAN_PHRASE_RE.match(word)
                    and word not in PHRASE_STOP_LIST
                    and raw_pos in {"verb", "phrase", "prep_phrase", "prep", "conj", "adv", "intj"}
                ):
                    p_label = "phrasal verb" if raw_pos == "verb" else "phrase"
                    senses, _, _ = extract_scored_senses(
                        word,
                        p_label,
                        obj.get("senses") or [],
                        raw_lemmas,
                        max_chars,
                        from_simple=True,
                        collect_lemmas=False,
                    )
                    senses = [s for s in senses if not s["obsolete"]]
                    if senses:
                        senses.sort(key=lambda x: -x["score"])
                        prec = phrase_entries.setdefault(
                            word, {"p": p_label, "ipa": "", "m": [], "from_simple": True}
                        )
                        if not prec["ipa"]:
                            prec["ipa"] = pick_ipa(obj.get("sounds"))
                        existing = {x["d"].lower() for x in prec["m"]}
                        for s in senses:
                            if len(prec["m"]) >= 2:
                                break
                            if s["d"].lower() not in existing:
                                existing.add(s["d"].lower())
                                prec["m"].append({"p": p_label, "d": s["d"]})
                continue

            if not word or len(word) > 28 or not CLEAN_WORD_RE.match(word):
                continue

            pos = SIMPLE_POS_MAP.get(raw_pos)
            if not pos:
                continue

            is_proper = pos == "proper noun"
            is_acro = (raw_word.isupper() and 2 <= len(raw_word) <= 10) or word in MUST_INCLUDE_ACRONYMS

            harvest_entry_forms(word, obj.get("forms") or [], raw_lemmas)
            scored, modern_cnt, ex_cnt = extract_scored_senses(
                word,
                pos,
                obj.get("senses") or [],
                raw_lemmas,
                max_chars,
                from_simple=True,
                is_acronym=is_acro,
                is_proper_noun=is_proper,
            )
            if not scored:
                continue

            rec = entries.get(word)
            if rec is None:
                rec = new_word_record()
                entries[word] = rec
            if not rec["ipa"]:
                rec["ipa"] = pick_ipa(obj.get("sounds"))

            merge_scored_senses(rec, pos, scored, modern_cnt, ex_cnt, from_simple=True)
            simple_words.add(word)

    return lines_read


def maybe_ingest_phrase(
    raw_word: str,
    word: str,
    raw_pos: str,
    obj: dict[str, Any],
    freq_ranks: dict[str, int],
    phrase_entries: dict[str, dict[str, Any]],
    raw_lemmas: dict[str, set[str]],
    max_chars: int,
) -> None:
    if len(word) > 36 or not CLEAN_PHRASE_RE.match(word):
        return
    if word in PHRASE_STOP_LIST:
        return
    if raw_word[0].isupper() and word not in CURATED_PHRASES:
        return

    parts = word.split(" ")
    is_curated = word in CURATED_PHRASES

    if not is_curated:
        if raw_pos == "verb":
            if len(parts) not in (2, 3):
                return
            if freq_ranks.get(parts[0], 999999) > 3000:
                return
            if parts[1] not in PHRASE_PARTICLES:
                return
            if len(parts) == 3 and parts[2] not in PHRASE_PARTICLES and freq_ranks.get(parts[2], 999999) > 1500:
                return
        elif raw_pos in {"prep", "prep_phrase", "conj", "adv", "phrase"}:
            if len(parts) > 4:
                return
            if any(freq_ranks.get(p, 999999) > 4000 for p in parts):
                return
        else:
            return
    else:
        if raw_pos not in {"verb", "phrase", "prep_phrase", "prep", "conj", "adv", "adj", "intj"}:
            return

    p_label = CURATED_PHRASES[word][0] if is_curated else ("phrasal verb" if raw_pos == "verb" else "phrase")

    existing_rec = phrase_entries.get(word)
    if existing_rec and existing_rec.get("from_simple") and len(existing_rec["m"]) >= 1:
        if not existing_rec["ipa"]:
            existing_rec["ipa"] = pick_ipa(obj.get("sounds"))
        return

    scored, _, _ = extract_scored_senses(
        word,
        p_label,
        obj.get("senses") or [],
        raw_lemmas,
        max_chars,
        from_simple=False,
        collect_lemmas=False,
    )
    scored = [s for s in scored if not s["obsolete"]]
    if not scored:
        return
    scored.sort(key=lambda x: -x["score"])

    prec = phrase_entries.setdefault(
        word, {"p": p_label, "ipa": "", "m": [], "from_simple": False}
    )
    if not prec["ipa"]:
        prec["ipa"] = pick_ipa(obj.get("sounds"))
    existing = {x["d"].lower() for x in prec["m"]}
    for s in scored:
        if len(prec["m"]) >= 2:
            break
        if s["d"].lower() not in existing:
            existing.add(s["d"].lower())
            prec["m"].append({"p": p_label, "d": s["d"]})


def ingest_english_wiktionary(
    jsonl_gz_path: Path,
    freq_ranks: dict[str, int],
    entries: dict[str, dict[str, Any]],
    simple_words: set[str],
    proper_noun_words: set[str],
    acronym_words: set[str],
    compound_words: set[str],
    phrase_entries: dict[str, dict[str, Any]],
    raw_lemmas: dict[str, set[str]],
    max_chars: int,
) -> int:
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
            if not raw_word:
                continue
            word = raw_word.lower()
            raw_pos = str(obj.get("pos") or "").lower()

            if " " in raw_word:
                maybe_ingest_phrase(
                    raw_word,
                    word,
                    raw_pos,
                    obj,
                    freq_ranks,
                    phrase_entries,
                    raw_lemmas,
                    max_chars,
                )
                continue

            if len(raw_word) > 28 or not CLEAN_WORD_RE.match(word):
                continue

            pos = EN_POS_MAP.get(raw_pos)
            if not pos:
                continue

            is_proper = pos == "proper noun"
            is_acro = (raw_word.isupper() and 2 <= len(raw_word) <= 10) or word in MUST_INCLUDE_ACRONYMS
            in_freq = word in freq_ranks
            in_simple = word in simple_words
            in_core = word in CORE_FUNCTION_WORDS
            in_must_proper = word in MUST_INCLUDE_PROPER_NOUNS
            is_compound = (not is_proper) and is_interesting_hyphenated_compound(word, freq_ranks)
            senses = obj.get("senses") or []

            if not (in_freq or in_simple or in_core or in_must_proper or is_acro or is_compound):
                for sense in senses:
                    for ref in sense.get("form_of") or []:
                        ref_w = normalize_form_text(ref.get("word") or "")
                        if ref_w and ref_w != word and (ref_w in freq_ranks or ref_w in simple_words):
                            raw_lemmas[word].add(ref_w)
                continue

            if is_proper and not (in_must_proper or in_simple or is_acro or freq_ranks.get(word, 999999) <= 140000):
                continue

            if is_acro and word not in MUST_INCLUDE_ACRONYMS and freq_ranks.get(word, 999999) > 90000:
                continue

            harvest_entry_forms(word, obj.get("forms") or [], raw_lemmas)

            scored, modern_cnt, ex_cnt = extract_scored_senses(
                word,
                pos,
                senses,
                raw_lemmas,
                max_chars,
                from_simple=False,
                is_acronym=is_acro,
                is_proper_noun=is_proper,
            )
            if not scored:
                continue

            rec = entries.get(word)
            if rec is None:
                rec = new_word_record()
                entries[word] = rec
            if not rec["ipa"]:
                rec["ipa"] = pick_ipa(obj.get("sounds"))

            merge_scored_senses(rec, pos, scored, modern_cnt, ex_cnt, from_simple=False)

            if is_proper:
                proper_noun_words.add(word)
            if is_acro:
                acronym_words.add(word)
            if is_compound:
                compound_words.add(word)

    return lines_read


def finalize_word_meanings(
    word: str,
    rec: dict[str, Any],
    freq_rank: int,
    max_per_pos: int,
) -> list[dict[str, str]]:
    """
    Order senses inside each POS from MOST COMMON to LEAST COMMON, drop purely
    obsolete/archaic senses when 3+ modern senses exist, and order Parts of
    Speech by real-world commonality rather than alphabetically.
    """
    # Count total modern senses across the whole word
    total_modern = sum(
        1
        for bucket in rec["by_pos"].values()
        for s in bucket
        if not s["obsolete"]
    )

    is_high_freq = freq_rank <= 6000 or word in CORE_FUNCTION_WORDS
    per_pos_cap = max(max_per_pos, 3) if is_high_freq else max_per_pos
    max_total_senses = 8 if is_high_freq else 6

    ranked_pos_buckets: list[tuple[float, str, list[dict[str, Any]]]] = []

    for pos, raw_bucket in rec["by_pos"].items():
        if not raw_bucket:
            continue

        # Sort senses inside this POS from most common -> least common
        senses_sorted = sorted(
            raw_bucket,
            key=lambda s: (-s["score"], 0 if s["simple"] else 1, 0 if s["has_ex"] else 1, len(s["d"])),
        )

        # Drop purely obsolete/archaic/rare senses if 3+ modern senses exist
        modern_here = [s for s in senses_sorted if not s["obsolete"]]
        if total_modern >= 3:
            senses_sorted = modern_here
            if not senses_sorted:
                continue

        # Drop purely niche-only secondary POS (e.g. adj "melted/molten" on "run")
        # when the word already has plenty of strong everyday modern senses in other POS
        if (
            total_modern >= 5
            and pos != "proper noun"
            and all(s["niche"] and not s["simple"] for s in senses_sorted)
            and rec["pos_stats"][pos]["en_modern"] <= 2
        ):
            continue

        cap = 1 if pos == "proper noun" else per_pos_cap
        chosen = senses_sorted[:cap]
        if not chosen:
            continue

        stats = rec["pos_stats"][pos]
        best_score = chosen[0]["score"]
        pos_score = (
            best_score
            + min(stats["simple_modern"], 6) * 16.0
            + min(stats["en_modern"], 30) * 3.0
            + min(stats["en_examples"], 12) * 2.0
        )
        # Boost core function-word POS backed by Simple Wiktionary (e.g. "well" adv, "in" prep)
        if pos in ("adv", "prep", "conj", "pron", "det") and stats["simple_modern"] >= 2:
            pos_score += 18.0
        # Slight default penalty for proper noun when everyday lowercase POS also exists
        # (runtime mid-sentence capitalization immediately moves proper noun to #1!)
        if pos == "proper noun" and len(rec["by_pos"]) > 1:
            pos_score -= 30.0

        ranked_pos_buckets.append((pos_score, pos, chosen))

    # Order Parts of Speech from MOST COMMON to LEAST COMMON
    ranked_pos_buckets.sort(key=lambda item: (-item[0], item[1]))

    meanings: list[dict[str, str]] = []
    seen_defs: set[str] = set()
    for _, pos, chosen in ranked_pos_buckets:
        for s in chosen:
            low = s["d"].lower()
            if low in seen_defs:
                continue
            seen_defs.add(low)
            meanings.append({"p": pos, "d": s["d"]})
            if len(meanings) >= max_total_senses:
                break
        if len(meanings) >= max_total_senses:
            break

    # Guarantee proper noun sense is NEVER truncated off if a word has one (e.g. Turkey, China, August)
    if (
        "proper noun" in rec["by_pos"]
        and not any(m["p"] == "proper noun" for m in meanings)
    ):
        for _, pos, chosen in ranked_pos_buckets:
            if pos == "proper noun" and chosen:
                meanings.append({"p": "proper noun", "d": chosen[0]["d"]})
                break

    return meanings


def select_phrases(
    phrase_entries: dict[str, dict[str, Any]],
    freq_ranks: dict[str, int],
    max_phrases: int = 2600,
) -> dict[str, dict[str, Any]]:
    for phrase, (p_label, fallback_def) in CURATED_PHRASES.items():
        rec = phrase_entries.get(phrase)
        if not rec or not rec.get("m"):
            phrase_entries[phrase] = {
                "p": p_label,
                "ipa": "",
                "m": [{"p": p_label, "d": fallback_def}],
                "from_simple": False,
            }
        else:
            rec["p"] = p_label
            for sense in rec["m"]:
                sense["p"] = p_label

    def phrase_rank(item: tuple[str, dict[str, Any]]) -> tuple[int, int, int, str]:
        phrase, rec = item
        if phrase in CURATED_PHRASES:
            return (0, 0, len(phrase), phrase)
        parts = phrase.split(" ")
        avg_freq = sum(freq_ranks.get(p, 50000) for p in parts) // max(1, len(parts))
        is_pv = 0 if rec["p"] == "phrasal verb" else 1
        return (1, is_pv, avg_freq, phrase)

    ranked = sorted(
        [(k, v) for k, v in phrase_entries.items() if v.get("m")],
        key=phrase_rank,
    )[:max_phrases]

    out: dict[str, dict[str, Any]] = {}
    for phrase, rec in sorted(ranked, key=lambda kv: kv[0]):
        compact: dict[str, Any] = {
            "p": rec["p"],
            "m": rec["m"][:2],
        }
        if rec.get("ipa"):
            compact["ipa"] = rec["ipa"]
        out[phrase] = compact
    return out


def build_dictionary(
    simple_gz_path: Path,
    english_gz_path: Path,
    freq_ranks: dict[str, int],
    out_dir: Path,
    max_per_pos: int = 2,
    max_words: int = 60000,
    max_proper_only: int = 8000,
    max_phrases: int = 2600,
    max_chars: int = 140,
) -> dict[str, Any]:
    entries: dict[str, dict[str, Any]] = {}
    simple_words: set[str] = set()
    proper_noun_words: set[str] = set()
    acronym_words: set[str] = set()
    compound_words: set[str] = set()
    phrase_entries: dict[str, dict[str, Any]] = {}
    raw_lemmas: dict[str, set[str]] = defaultdict(set)

    t0 = time.time()
    print("      [a] Parsing Simple English Wiktionary (commonality + simplicity priority)...")
    simple_lines = ingest_simple_wiktionary(
        simple_gz_path,
        entries,
        simple_words,
        phrase_entries,
        raw_lemmas,
        max_chars=max_chars,
    )
    print(
        f"          {simple_lines:,} lines -> {len(simple_words):,} Simple Wiktionary headwords "
        f"({time.time() - t0:.1f}s)"
    )

    t1 = time.time()
    print("      [b] Streaming full English Wiktionary (commonality scoring, POS counts, proper nouns & phrases)...")
    en_lines = ingest_english_wiktionary(
        english_gz_path,
        freq_ranks,
        entries,
        simple_words,
        proper_noun_words,
        acronym_words,
        compound_words,
        phrase_entries,
        raw_lemmas,
        max_chars=max_chars,
    )
    print(
        f"          {en_lines:,} lines -> {len(entries):,} merged headword candidates, "
        f"{len(phrase_entries):,} phrase candidates, {len(raw_lemmas):,} raw inflections "
        f"({time.time() - t1:.1f}s)"
    )

    lemma_targets: set[str] = set()
    for form, candidates in raw_lemmas.items():
        if form in freq_ranks:
            for c in candidates:
                if c in entries:
                    lemma_targets.add(c)

    regular_candidates: list[str] = []
    proper_only_candidates: list[str] = []

    for w, rec in entries.items():
        pos_keys = set(rec["by_pos"].keys())
        if not pos_keys:
            continue
        is_proper_only = (
            pos_keys == {"proper noun"}
            and w not in CORE_FUNCTION_WORDS
            and w not in simple_words
            and w not in acronym_words
        )
        if is_proper_only:
            proper_only_candidates.append(w)
        else:
            regular_candidates.append(w)

    def regular_sort_key(w: str) -> tuple[int, int, str]:
        if w in CORE_FUNCTION_WORDS or w in MUST_INCLUDE_ACRONYMS:
            return (0, freq_ranks.get(w, 0), w)
        if w in freq_ranks:
            return (1, freq_ranks[w], w)
        if w in lemma_targets:
            return (2, 0, w)
        if w in simple_words:
            return (3, 0, w)
        if w in compound_words:
            parts = w.split("-")
            p_rank = (
                max(freq_ranks.get(p, 25000) for p in parts if p not in COMMON_COMPOUND_PREFIXES)
                if any(p not in COMMON_COMPOUND_PREFIXES for p in parts)
                else 5000
            )
            return (4, p_rank, w)
        return (5, 0, w)

    def proper_sort_key(w: str) -> tuple[int, int, str]:
        if w in MUST_INCLUDE_PROPER_NOUNS:
            return (0, freq_ranks.get(w, 0), w)
        return (1, freq_ranks.get(w, 999999), w)

    proper_selected = sorted(proper_only_candidates, key=proper_sort_key)[:max_proper_only]
    regular_budget = max(10000, max_words - len(proper_selected))
    regular_selected = sorted(regular_candidates, key=regular_sort_key)[:regular_budget]

    selected_words = sorted(set(regular_selected) | set(proper_selected))
    selected_set = set(selected_words)

    final_lemmas: dict[str, str] = {}
    for form, candidates in raw_lemmas.items():
        if form in CORE_IRREGULARS:
            continue
        valid = [c for c in candidates if c in selected_set and c != form]
        if not valid:
            continue
        valid.sort(key=lambda c: (freq_ranks.get(c, 999999), len(c), c))
        final_lemmas[form] = valid[0]

    for form, base in CORE_IRREGULARS.items():
        if base in selected_set:
            final_lemmas[form] = base

    final_phrases = select_phrases(phrase_entries, freq_ranks, max_phrases=max_phrases)

    shards: dict[str, dict[str, Any]] = defaultdict(dict)
    total_senses = 0
    written_words = 0

    for word in selected_words:
        rec = entries[word]
        meanings = finalize_word_meanings(
            word, rec, freq_ranks.get(word, 999999), max_per_pos=max_per_pos
        )
        if not meanings:
            continue
        written_words += 1
        total_senses += len(meanings)
        compact: dict[str, Any] = {"m": meanings}
        if rec["ipa"]:
            compact["ipa"] = rec["ipa"]
        shards[shard_key_for(word)][word] = compact

    out_dir.mkdir(parents=True, exist_ok=True)
    for old_file in out_dir.glob("*.json"):
        old_file.unlink()

    total_bytes = 0
    shard_bytes = 0
    for key, payload in sorted(shards.items()):
        shard_path = out_dir / f"{key}.json"
        raw = json.dumps(payload, ensure_ascii=False, separators=(",", ":"))
        shard_path.write_text(raw, encoding="utf-8")
        sz = shard_path.stat().st_size
        shard_bytes += sz
        total_bytes += sz

    lemmas_path = out_dir / "lemmas.json"
    lemmas_raw = json.dumps(
        dict(sorted(final_lemmas.items())), ensure_ascii=False, separators=(",", ":")
    )
    lemmas_path.write_text(lemmas_raw, encoding="utf-8")
    lemmas_bytes = lemmas_path.stat().st_size
    total_bytes += lemmas_bytes

    phrases_path = out_dir / "phrases.json"
    phrases_raw = json.dumps(final_phrases, ensure_ascii=False, separators=(",", ":"))
    phrases_path.write_text(phrases_raw, encoding="utf-8")
    phrases_bytes = phrases_path.stat().st_size
    total_bytes += phrases_bytes

    simple_kept = sum(1 for w in selected_words if w in simple_words)
    proper_kept = sum(1 for w in selected_words if "proper noun" in entries[w]["by_pos"])
    stats = {
        "source": "Kaikki.org Simple English Wiktionary + English Wiktionary (CC BY-SA 4.0)",
        "simpleSourceUrl": SIMPLE_WIKTIONARY_URL,
        "englishSourceUrl": ENGLISH_WIKTIONARY_URL,
        "frequencySource": FREQUENCY_LIST_URL,
        "simpleLinesRead": simple_lines,
        "englishLinesRead": en_lines,
        "words": written_words,
        "simpleWordsIncluded": simple_kept,
        "properNounsIncluded": proper_kept,
        "phrases": len(final_phrases),
        "senses": total_senses,
        "lemmas": len(final_lemmas),
        "shards": len(shards),
        "shardBytes": shard_bytes,
        "lemmasBytes": lemmas_bytes,
        "phrasesBytes": phrases_bytes,
        "totalBytes": total_bytes,
    }
    manifest_path = out_dir / "manifest.json"
    manifest_path.write_text(
        json.dumps(stats, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )
    return stats


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Build 60,000-word commonality-ranked static sharded English learner dictionary + phrases.json."
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
        default=60000,
        help="Maximum headwords to keep (default: 60000)",
    )
    parser.add_argument(
        "--max-proper-only",
        type=int,
        default=8000,
        help="Maximum proper-noun-only entries to keep (default: 8000)",
    )
    parser.add_argument(
        "--max-phrases",
        type=int,
        default=2600,
        help="Maximum multi-word phrases to keep in phrases.json (default: 2600)",
    )
    parser.add_argument(
        "--freq-limit",
        type=int,
        default=250000,
        help="Maximum frequency-ranked words to load from en_full.txt (default: 250000)",
    )
    parser.add_argument(
        "--max-per-pos",
        type=int,
        default=2,
        help="Maximum definitions per part of speech for standard words (top 6k get up to 3)",
    )
    parser.add_argument(
        "--max-chars",
        type=int,
        default=140,
        help="Maximum characters per definition (default: 140)",
    )
    args = parser.parse_args()

    print(f"[1/4] Downloading frequency list -> {args.cache_dir / 'en_full.txt'}")
    freq_path = download_if_needed(FREQUENCY_LIST_URL, args.cache_dir / "en_full.txt")
    freq_ranks = load_frequency_ranks(freq_path, args.freq_limit)
    print(f"      Loaded {len(freq_ranks):,} frequency-ranked English words.")

    print(
        f"[2/4] Downloading Simple English Wiktionary -> {args.cache_dir / 'simple-extract.jsonl.gz'}"
    )
    simple_path = download_if_needed(
        SIMPLE_WIKTIONARY_URL, args.cache_dir / "simple-extract.jsonl.gz"
    )

    print(
        f"[3/4] Downloading full English Wiktionary -> {args.cache_dir / 'kaikki-english.jsonl.gz'}"
    )
    en_path = download_if_needed(
        ENGLISH_WIKTIONARY_URL, args.cache_dir / "kaikki-english.jsonl.gz"
    )

    print(f"[4/4] Scoring commonality, ordering POS, and writing shards + phrases.json -> {args.out}")
    stats = build_dictionary(
        simple_gz_path=simple_path,
        english_gz_path=en_path,
        freq_ranks=freq_ranks,
        out_dir=args.out,
        max_per_pos=args.max_per_pos,
        max_words=args.max_words,
        max_proper_only=args.max_proper_only,
        max_phrases=args.max_phrases,
        max_chars=args.max_chars,
    )
    print(
        f"Done! {stats['words']:,} headwords ({stats['simpleWordsIncluded']:,} Simple, "
        f"{stats['properNounsIncluded']:,} proper nouns), {stats['phrases']:,} phrases, "
        f"{stats['senses']:,} senses, {stats['lemmas']:,} lemma mappings across {stats['shards']} shards "
        f"({stats['totalBytes'] / (1024 * 1024):.2f} MB total; "
        f"lemmas.json = {stats['lemmasBytes'] / (1024 * 1024):.2f} MB, "
        f"phrases.json = {stats['phrasesBytes'] / 1024:.1f} KB)."
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
