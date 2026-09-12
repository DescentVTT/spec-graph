---
status: accepted
date: 2026-09-13
---

# ADR-0017: A predicate must finish

## Context

[ADR-0016](0016-a-query-needs-a-sentence.md) shipped project rules and recorded
a hazard it had made worse rather than created:

> **`~=` can hang a build, and this ADR moves where that lives.** The predicate
> compiles a JavaScript regular expression, and `[title~=(a+)+$]` against a long
> title never returns.

It closed with an open question, and with a bar for answering it: a hand-written
automaton "would make the predicate linear in the subject and close the hang
above, at the cost of a regex dialect that is not the one anybody expects. Worth
it only if a real repository hangs on this; none has."

The bar was wrong, and the example is why. `(a+)+$` is a pattern nobody writes
against a title of forty `a`s, so the hazard read as a curiosity. Here is one
somebody does write — "the title is words separated by single spaces":

```text
document[title~="^([A-Za-z0-9_]+[ ]?)+$"]
```

Against a title that fails it, V8 tries one branch per way of cutting each word
into pieces. A word of k letters can be cut 2^(k-1) ways, and the engine works
through the product:

| subject | `RegExp` | this matcher |
| --- | ---: | ---: |
| `the quick brown fox jumps over the lazy dog!` | 0.9s | 11us |
| `the quick brown fox jumps over the lazy dog and!` | 5.4s | 12us |
| `the quick brown fox jumps over the lazy dog and keeps!` | 103s | 13us |

Forty-four characters of ordinary English is a second. Fifty-four is two
minutes. A sixty-character title does not finish this year, and the rule runs
once per node against a corpus whose titles the author of the rule has not read.

So the question was never whether a repository had hung yet. **It was whether a
pure pipeline is allowed to contain one component whose running time nobody can
bound.** Every other part of this tool is a hand-written function over text with
a stated cost. `~=` was a call into a black box that can take longer than the
heat death of the job.

## Decision

**`~=` is matched by a non-deterministic finite automaton, simulated over the
subject one character at a time.** Thompson's construction, 1968: compile the
pattern to states, keep the set of states that are live at each position, and
step the whole set forward one character at a time. A state is visited at most
once per position, which turns the exponent into a product — the work is exactly
O(pattern x subject), with no pattern able to do worse than its own length.

There are no capture groups in the implementation at all. Nothing downstream
asks *where* a predicate matched, only whether it did, so there is no
leftmost-longest rule to settle and no submatches to carry: the first thread to
reach the end of the pattern is the answer. That is the difference between this
and a Pike VM, and it is most of the reason the module is 800 lines - a third of
them comment - rather than several thousand.

Matching stays case-insensitive and unanchored, because that is what `~=` has
always been — `new RegExp(source, 'i')` and `.test()`.

### What it will not run, and why that is the honest part

Backreferences and lookaround are not regular. No automaton can carry them, and
any implementation that accepted them would have to backtrack, which is the
thing being removed. So they are **refused while the selector is being read**,
with a message and the offending character pointed at:

```text
spec-graph: lookaround is not supported: an automaton that cannot backtrack
cannot look ahead - use ^= $= or *= for a fixed prefix, suffix or substring
  document[title~="(?=ADR)"]
                   ^
```

The same treatment goes to three things `RegExp` accepts and should not:

- `\A`, `\z`, `\Q`, and every other unknown letter escape. `RegExp` reads `\A`
  as a capital A, so a pattern meant as an anchor silently matches a letter.
  Anybody who typed it meant the anchor and would never have found out.
- `\p{Letter}`, which needs a table of Unicode properties this package does not
  carry and will not start carrying.
- Octal escapes, and malformed `\x`/`\u`. Annex B has a reading for each of
  these; none of the readings is what the author meant.

Everything else is supported: literals, `.`, classes with ranges and negation,
`\d \D \w \W \s \S \b \B`, groups (capturing, non-capturing and named — all
three compile identically, since no capture is kept), alternation, `* + ?`,
counted `{n,m}` with lazy forms accepted and ignored, and `^` `$` anchored to
the whole subject.

Counted repetition is compiled by copying, which is what keeps the simulation
flat. It also means `(a{99}){99}` is ten thousand states, so there is a ceiling
of 4,096 states, checked while compiling. The widest pattern in this
repository's own tests compiles to seventeen.

### A pattern that does not parse is now a usage error

It used to match nothing. That was defensible in isolation — "an invalid pattern
matches nothing rather than crashing a whole run" — and indefensible next to the
rest of this grammar, which rejects an unknown relation, an unknown node type,
an unquoted value with a space in it, and a mismatched arrow, each with a caret
under the character. A silent no-match is indistinguishable from a rule that ran
and found nothing, which is the one thing a check must never be.

So the pattern is compiled where the selector is parsed, rather than on first
use. That is not an optimisation: it is the only place that knows where in the
selector the pattern was written, which is what the caret needs. Project rules
inherit it for free — [ADR-0016](0016-a-query-needs-a-sentence.md) already
reports a selector that does not parse when the configuration file is read.

## Consequences

**The pipeline has no unbounded component left.** Every stage from scanner to
reporter now has a stated cost in the size of its input. That is a property of
the whole tool rather than of this module, and it is the reason to do this work
at all.

**Two engines disagree about exotic case folding, in one place.** The
specification canonicalises both sides of a comparison: a character matches a
set when some member of the set folds to the same thing it does. A single
character can be asked that exactly, and is. A range cannot, without a fold
table for all 65,536 code units, so a range asks the question backwards — does
the character, or either of its own case forms, fall inside it. The two readings
differ only for a character whose fold is not its own case change, which in the
BMP is U+00B5 MICRO SIGN against U+03BC GREEK SMALL MU. A class written as the
range U+00B4 to U+00B6 matches a mu in `RegExp` and not here. A test pins it, so
it stays a decision rather than becoming a surprise.

**Duplicate group names are accepted here and rejected by `RegExp`.** Nothing
reads a group name, so nothing notices there are two. More permissive, in a
direction that cannot produce a wrong answer.

### Verification

A hand-written engine replacing a built-in one has something rare available: an
oracle. So the useful question is not "does it do what I think" but "does it do
what the thing it replaced did", and that is asked mechanically.

The committed test compares both engines over a hand-written corpus of 130
patterns against 53 subjects, and over 1,000 patterns generated from a seeded
grammar against 12 subjects — about 19,000 comparisons on every run, with the
seed fixed so a failure reproduces on every machine. Off to one side, a larger
run of the same comparison covered **1.33 million pattern-subject pairs with
zero disagreements**, and confirmed that every pattern the generator produced
which `RegExp` accepts, this accepts too.

It earned its keep immediately. The first version of `isWordChar` widened the
set for `\b` to U+017F and U+212A, because the specification says the word
characters under case-insensitivity include every character that folds into the
basic set. It does say that — in Unicode mode, where `Canonicalize` has no
clause keeping a non-ASCII character out of ASCII. This is the non-Unicode
dialect, `RegExp` says no, and reading the clause was not enough. Running it
was.

The generated corpus has a blind spot, and it is the one that matters: a
grammar produces the shapes its author thought to write down. It will never
emit an empty group, an alternation with nothing on one side, a class whose
first character closes it, or `a{0}`. Probing those by hand found the second
divergence - `RegExp` rejects `\b*` and accepts `(\b)*`, because a group makes
its contents quantifiable, and this parser treats a group as transparent and so
refused both. Repeating a zero-width assertion is exactly as meaningless as it
sounds and both engines read it as matching the empty string; the fix was to
remember whether a group had been written. Those shapes are in the committed
corpus now.

And the corpus itself has been wrong. The mutation score is what said so: a
survivor sat on the line that steps past the `^` in a negated class, where
`[^abc]` mutated to `[^[^abc]` passed 1.33 million comparisons. The corpus tested
classes against `"[]"`, and the `]` cancelled the wrongly-included `[`. Adding
every metacharacter as a **one-character subject** killed it, and then found a
real defect the oracle had been agreeing with: `[\d-\w]` matched U+017F,
because upper-casing it gives `S` and the range check tried the character's case
forms without asking whether the fold survived. It does not - the same clause,
for the second time, in a second place. See
[ADR-0007](0007-mutation-testing.md), which now carries the general form: the
oracle checks the implementation against a corpus, and the mutation score checks
the corpus.

That is the same lesson [ADR-0013](0013-the-scanner-hands-back-prose.md) drew
from an open question that turned out to be false, and
[ADR-0014](0014-a-relation-is-spelled-both-ways.md) from a near-miss gate that
was measured rather than argued: **a claim nobody executed is worth exactly as
much as a rule nobody tested.**

## Open Questions

- [ ] Should the matcher be reused for `--ignore` globs? `glob.ts` compiles a
      glob to a `RegExp`, and a glob has no nested quantifiers, so there is no
      hazard to remove - only one fewer engine in the package. Not obviously
      worth a rewrite of working code.
- [ ] Should a pattern that compiles to more than a few hundred states warn?
      The ceiling refuses the pathological case and nothing between "fine" and
      "refused" has been observed, so a warning would be a number invented to
      have something to say.

## See also

- [ADR-0016](0016-a-query-needs-a-sentence.md) carried this as an open question
  and is the reason it mattered: a rule in a file runs unattended.
- [ADR-0005](0005-rules-are-queries.md) is why the answer had to keep `~=` in
  both places rather than banning it from rules - one engine, or the claim that
  rules and queries are the same thing stops being true.
- [ADR-0001](0001-hand-written-markdown-scanner.md) is the same trade made
  earlier and for the same reason: a tool a security team has to audit is one
  that gets installed.
