---
status: accepted
date: 2026-09-07
---

# ADR-0006: False positives cost more than misses

## Context

Every design decision in this repository eventually reduces to one question:
when the evidence is ambiguous, should spec-graph report or stay quiet?

The temptation is to report. A finding is visible work; a miss is invisible. But
a specification linter has an unusual failure mode. It runs against documents
nobody wrote for it, on a repository whose conventions it has never seen, and it
runs *first* on a corpus with years of accumulated history. If that first run
produces a wall of findings, the tool does not get tuned. It gets uninstalled
that afternoon, and then it catches nothing at all, forever.

This stopped being theoretical. Run against a third repository - 66 briefs, none
written with spec-graph in mind - the tool produced **648 errors**. Every one was
a link into an `archive/` folder that exists on disk but that the default include
patterns did not reach. Not one of them was a defect in the specifications. The
tool was reporting *its own configuration* as the user's mistake.

## Decision

When evidence is ambiguous, stay quiet. Concretely, four rules that the codebase
applies everywhere:

**An inference that cannot be justified is not made.** An unrecognised status
becomes `unknown`, not a guess. A link with no governing verb becomes a neutral
`references`, not a dependency - because a wrongly inferred `assumes` produces a
confident stale-premise finding about a document that never depended on anything.

**Distinguish the user's mistake from ours.** A citation naming a document that
does not exist is a broken foreign key and an error. A citation naming a real
document that the include patterns did not reach is
`reference-outside-corpus` at `warn`, and the hint names the exact pattern that
would fix it, resolved against the citing file. "Widen the include patterns" is
advice the reader then has to translate; `spec-graph "archive/**/*.md"` is not.

**Some things are not references at all.** A link to source code
(`../../src/rules.ts`), an image, or a directory (`archive/`) is ordinary in a
design document. Reporting those would fire on the most common thing a
specification does. Identifiers found in prose are opportunistic: reported only
when their family already exists in the corpus, so `ADR-0099` in a repository of
ADRs is a finding and `SHA-256` is a sentence.

**One defect is one finding.** `blocked-by` both transfers an obligation and is
load-bearing, so `ghost-handover` and `stale-premise` both match it. The first
claims the edge and the second skips it. Two findings on one line, for one
defect, with one fix, is a bug.

## Consequences

Real defects are missed. A dangling citation to a family that appears nowhere in
the corpus is indistinguishable from prose and goes unreported. A team that
writes wiki links to concepts rather than documents will see findings that are
correct by the tool's contract and useless to them; they turn the rule off.

That is the right trade. The same 66-brief repository now reports 11 errors and
637 warnings, and following the hint once brings it to 29 errors and none - a
corpus a human can actually work through. The tool survives contact with a
repository it has never seen, which is the only condition under which it catches
anything at all.

**Running against an unseen corpus keeps finding these, and nothing else does.**
Two more surfaced on the v0.1.2 pass, both in how far a governing verb reaches,
and neither was visible to 454 passing tests:

- The look-behind window crossed a **table cell edge**. An index of archived
  documents whose column ended "...read the banner before assuming the drift was
  fixed" made every following row's link an `assumes` edge, and so made every
  archived document it listed a stale premise. A table row is a list of
  independent fields; the cell edge now ends a statement.
- A verb reached across a **negation**. "Owned by nobody today and disclaimed by
  [138]" was read as a delegation *to* 138 - the opposite of what the sentence
  says. An inference that inverts its own source is worse than no inference.

Nine of eighteen findings on that corpus were these two bugs. The lesson is not
that the heuristics were badly chosen; it is that a synthetic fixture never
writes a sentence like that, and only a repository nobody wrote for the tool
will.

*Amended 2026-09-27.* Two more, found the other way round: by reading what a
mutation sweep could not pin down, where the only test that would have pinned
it asserted a false alarm.

- **A link to a file was read as a link to a document** when the file was a
  dotfile or its extension was long. `../.nvmrc` has its only dot first, which
  counted as no extension at all, and `arch.excalidraw` has an extension of
  ten letters, which counted as part of an identifier. Both were broken
  references. An extension is now a dot and a letter, however long, and a
  dotfile has one; either makes the link a link to a file, which is not a
  reference. A dot followed by a digit - `ADR-0007.1`, `v1.2` - is still part
  of an identifier.
- **A superseded document handing its open question to its successor was a
  delegation cycle.** The newer decision supersedes the older, and the older
  defers its question to the newer: projected onto documents that is a loop,
  and nothing in it is ever passed back. It is the hand-off supersession exists
  for, so the cycle search leaves it out
  ([ADR-0005](0005-rules-are-queries.md)).

Three more, raised in review of the two above:

- **A loop that took a supersession to close was a delegation cycle** when the
  hand-off went further than one step: to the latest of two successors, or to
  the successor by way of a third document. Obligations and supersessions are
  now searched for cycles apart ([ADR-0005](0005-rules-are-queries.md)).
- **A superseded document whose open question was delegated to a live
  document still held an orphaned obligation.** The finding's own hint - move
  each item to a live document - had been followed. An item delegated to a
  document that can still take work is not counted
  ([ADR-0003](0003-item-state-signals.md)).
- **A link to a directory without its trailing slash was a reference outside
  the corpus**, "resolves to a file that is not a specification", with a hint
  to widen patterns that could never reach it. The disk now says whether the
  path is a directory, and a directory is not a reference either way.

*Amended 2026-09-30.* A governing phrase is read in Chinese, and the two
limits above carry over to it. Ten phrases hand work on as `deferred to` and
`handed to` do - `延後至`, `延至`, `移交至`, `移交給`, `留待`, `交由`, `併入` and
their Simplified forms - each standing before the reference. Chinese puts no
space between words, and a Han character is a letter, so the word boundary an
English phrase needs would never match inside Chinese; a Chinese phrase has
none, and an English phrase no longer counts a Han character as part of its
word, so `此問題deferred to ADR-0002` is a delegation as it is with a space.
The negation that inverts a Chinese phrase stands directly before it,
`未移交給 ADR-0002`, and cancels it. And a statement ends at `。`, `？`, `！`
and `；`, with or without a space after: without that,
`上次延後至別處。另見 ADR-0002` handed a question to ADR-0002 from the sentence
before, the table-cell bug again in another script.

Two things are left out on purpose. `根據`, `依據` and `基於` would be `assumes`,
and Chinese uses them for any citation: read as premises, they would make a
stale premise of every document that mentions a retired one. And a verb
written around the reference, `由 ADR-0002 決定` or `在 ADR-0002 中追蹤`, is not
something a phrase before the reference can express; those are missed, which
is the direction this ADR prefers. `併入`, merged into, is a hand-off rather
than the supersession `rolled into` is: read as a supersession, a constraint
merged into another decision's design would retire the document stating it.

*Amended 2026-09-30, after 0.10.0.* The Chinese phrases are taken out with
the Chinese statuses (ADR-0002, the same day), and with them the negation
read directly before a phrase and the boundary that let an English phrase
touch a Han character: a Han character is a letter again, so
`此問題deferred to ADR-0002` is a reference and no more. The stop at `。`,
`？`, `！` and `；` stays. It only ends a statement sooner, so it reads fewer
relations and never more - `Deferred to later。另見 ADR-0002` hands nothing
to ADR-0002 - which is this ADR's direction whatever language a document is
written in.

*Amended 2026-10-14.* **A negation is read whatever mark stands after it.**
The rule above is that a verb does not reach across a negation. The reader
held it where a space followed the word, or the reference itself, and
nowhere else. Measured on main at b9da6ab, 0.16.0, through the launcher: one
document for each sentence, and the relation `graph` exports for it.

| Written before the reference | 0.16.0 | Now |
| --- | --- | --- |
| `Blocked by none`, and with a comma, a bracket or a spaced dash after the word | a citation | the same |
| `Blocked by none:` | `blocked-by` | a citation |
| `Deferred to nothing: see` | `delegates-to` | a citation |
| `Superseded by none:`, `Depends on nothing:`, `As decided in none:`, `Amended by nobody:` | the phrase's relation | a citation |
| The word against an em dash, an en dash, an ellipsis or a slash | the phrase's relation | a citation |
| The word against a stop that no space follows, `none.)` | the phrase's relation | a citation |
| `Blocked by the no-op in`, `the never-ending migration in`, `the NO2 ceiling in`, `the notes:` | `blocked-by` | the same |

A colon is what a label is written with, and each of those sentences said
the opposite of the relation read from it. A stop with a space after it ends
the statement, so `Blocked by none. See` was a citation already: the word
was missed only where a mark stood against it.

The word now ends where a governing phrase ends, at anything but a letter or
a digit, and at the end of the text, which is where the reference begins. A
hyphen is the exception. It joins the word to the next, and what is joined
names a thing and denies nothing: `the no-op`, `the never-ending migration`,
`not-yet-written`. Read as negations those would lose a relation the
sentence does state, which is a miss, and can be a finding too: an open
question in a retired document is not orphaned while a live document has
taken it ([ADR-0003](0003-item-state-signals.md)), and is orphaned once the
sentence that hands it over goes unread.

That is also why this arrives in a minor release. Three checks, measured on
both builds: an open question in a superseded document, `Deferred to nobody:
see` a live one, was exit `0` and is exit `1`, `orphaned-obligation`, as it
was with a comma for the colon; an open question `Blocked by none:` a
retired document was exit `1`, `ghost-handover`, and is exit `0`; and a
sentence that `depends on nothing:` a retired document was exit `1`,
`stale-premise`, and is exit `0`.

Three things are as they were. A negation before the phrase is not read:
`Not in this release: deferred to` is a delegation, which a test holds, and
so `Not blocked by` is a `blocked-by` edge. A mark against the front of the
word leaves it unread, `by:none`. And `no-one` is not on the list of words,
so the hyphen makes it a name.

*Amended 2026-10-18.* **A negation is read before the phrase, against any
mark, and in code.** The three things left as they were, and a fourth,
measured on main at 4574727, 0.17.0, through the launcher: one document for
each sentence, citing a second, and the relation `graph` exports for it.

| Written | 0.17.0 | Now |
| --- | --- | --- |
| `Not blocked by`, `This is not blocked by`, `No longer blocked by`, `Not even blocked by` | `blocked-by` | a citation |
| `Never deferred to`, `Not yet deferred to`, `It was never deferred to` | `delegates-to` | a citation |
| `It isn't blocked by` (and with `’`), `Neither blocked by [ADR-0002] nor`, `Done without being blocked by`, `Nobody is blocked by` | `blocked-by` | a citation |
| `This doesn't depend on` | `depends-on` | a citation |
| `It has not been superseded by`, `It hasn't been superseded by` | the cited document supersedes this one | a citation |
| `Not blocked by ADR-0002.`, a bare identifier | `blocked-by` | a citation |
| `Blocked by:none`, and `none` between two em dashes | `blocked-by` | a citation |
| `Deferred to no-one: see` | `delegates-to` | a citation, as `no one` was |
| ``Blocked by `none`:`` | `blocked-by` | a citation, as `**none**` was |
| `Not only blocked by`, `Not just blocked by`, `Nothing but blocked by` | `blocked-by` | the same |
| `Not in this release: deferred to`, `Not blocked by the cache, but deferred to` | `delegates-to` | the same |
| `The "never" option is blocked by`, `The option "never" blocked by`, `"Not now" is blocked by` | `blocked-by` | the same |
| `Not the cache; blocked by`, `Cannot ship; blocked by` | `blocked-by` | the same |
| `Blocked by the no-op in`, ``Blocked by the `--no-cache` flag in`` | `blocked-by` | the same |
| `Blocked by the "none" option in` | a citation | the same |

The rule above, that a verb does not reach across a negation, already
covers the mark: `by:none` has the word between the phrase and the
reference, and the word was missed only because the pattern wanted a space
before it. It begins now where it ends, after anything but a letter, a digit
or a hyphen, and the hyphen is the exception at the front as at the end:
`the anti-none rule` names a thing. The other three the rule does not
cover, and each is decided here with what it trades.

**A negation just before the phrase cancels it.** "It has not been
superseded by [ADR-0002]" made ADR-0002 the successor of the document that
says it has none, and a superseded document's open questions are orphaned
and its premises stale: the worst inference a sentence can be read into.
The negation is the last word before the phrase, or before words that carry
a tense or leave the relation in doubt and claim nothing of their own: `be`,
`been`, `being`, `is`, `are`, `was`, `were`, `yet`, `longer`, `ever`,
`even`, `currently`, `actually`, `really`, `necessarily`, `always`. The
words are the list above with `no one` and a contraction, `isn't` or
`doesn’t`, and `cannot`. Only a space stands between: a quote mark keeps a
quoted word to itself, so the option `"never"` is a name. A straight quote
and apostrophe are kept for that in the text a phrase is read from, as the
curly ones always were, and where one stands beside a space it now counts
toward the 40 characters a phrase reaches, as a curly one did.

What it trades. The false positive it removes is a relation the sentence
denies. The false negative it adds is a negation that belongs to another
clause, with nothing but a comma before the phrase, since a comma is blanked
in that text as it was: `both or neither, because [ADR-0002] says so` and
`if not, blocked by [ADR-0002]` each state the relation and are citations
now. Keeping the comma would stop those two, and it moves the reach of
every phrase across a comma by a character: measured that way, relations a
phrase reached by a character or two went too, `per tick`, `per cent` and
`per unit` read as premises and `blocks` in "frozen blocks were run" read
as a verb, and the window is not this amendment's to move. `not only`, `not just`, `not merely` and `nothing but` state the
relation and are read as relations, by the word that stands between.

**`no-one` is `no one`.** The hyphen that makes `no-op` a name makes
`no-one` the British spelling of a word on the list. It trades nothing
found: no sentence measured used `no-one` to name a thing.

**A code span that holds nothing but a negation word cancels.** The
structure mask blanks code, which keeps a phrase or a link written in code
from being read, and hid the one word ``Blocked by `none`:`` denies with,
where `**none**` was read. A span whose whole content is a word on the list
is read as that word, before the phrase or after it. The false negative it
trades is a value called `none`, ``deferred to the `none` policy's owner
in``, which is now a citation; a span that holds more, `` `--no-cache` `` or
`` `none of it` ``, is code as it was.

Measured on the Markdown of the family's five repositories: 576 relations,
none changed. On three other repositories nobody wrote for spec-graph,
16,355 relations, of which 33 gave way to 28 citations, the other five
merging with a citation of the same document already there, from seven
sentences written several times over: four deny the relation read from them ("never amends
its own code", "never depends on", a table row's "Not superseded by",
"Nothing blocks it"), one read a premise from the negated "because" of
"not because it is broad", one read `per` in "no per-wall" as a premise,
and one is the miss above, "both or neither, because". Six relations that
said the opposite of their sentence, or nothing, for one that a sentence
stated: the direction this ADR is for.

A check that passed can fail, so it arrives in a minor release. Four
checks, measured on both builds:

| The corpus | 0.17.0 | Now |
| --- | --- | --- |
| An open question in a superseded document, "Not yet deferred to" a live one | exit `0` | exit `1`, `orphaned-obligation` |
| An open question in a live document, "Not blocked by" a retired one | exit `1`, `ghost-handover` | exit `0` |
| A live document that "doesn't depend on" a retired one | exit `1`, `stale-premise` | exit `0` |
| An accepted document that "has not been superseded by" another | exit `1`, `live-supersession` | exit `0` |

*Amended 2026-10-19.* **A comma ends the clause a negation before the
phrase is in, and counts toward no phrase's reach.** The amendment of
2026-10-18 cancelled a phrase by a negation as the last word before it,
with the comma blanked in the text it was read from, so a negation that
ends a clause of its own stood against the next one's phrase, and
`if not, blocked by [ADR-0002]` and
`both or neither, because [ADR-0002] says so` each state the relation and
were citations. Keeping the comma in that text would have moved the 40
characters a phrase reaches. The text is
read twice now, from one statement: once with each run of spaces and
commas one space, as before, for the phrase and its reach, and once with
such a run that holds a comma written as the comma, one character either
way, for the negation before the phrase. A comma between that negation and
the phrase keeps the two apart; one before the negation keeps nothing
apart. Measured on main at 29c7b8a, 0.18.0, through the launcher: one
document for each sentence, citing a second, and the relation `graph`
exports for it.

| Written | 0.18.0 | Now |
| --- | --- | --- |
| `If not, blocked by`, `No, blocked by` | a citation | `blocked-by` |
| `Both or neither, because` | a citation | `assumes` |
| `Not yet, deferred to`, `Owner: nobody, deferred to` | a citation | `delegates-to` |
| `Ready or not, depends on` | a citation | `depends-on` |
| `Like it or not, superseded by` | a citation | the cited document supersedes this one |
| `Never, ever, blocked by`, `Not, repeat, not, blocked by`, `Not yet, nor ever, blocked by` | a citation | `blocked-by` |
| `It isn't, blocked by`, `It has not, been superseded by` | a citation | the phrase's relation |
| `Not blocked by`, `This is, however, not blocked by`, `No longer blocked by [ADR-0002], nor by the cache` | a citation | the same |
| `If so, blocked by`, `Not now, blocked by`, `Not only, blocked by` | `blocked-by` | the same |
| `Not, as it happens, blocked by` | `blocked-by` | the same |
| `Blocked by none, see`, `Blocked by ADR-0003, not ADR-0002` | a citation | the same |
| `Blocked by, if nothing else,`, `Deferred to, but not owned by,` | a citation | the same |
| `Blocked by the shards, the queue, the cache, the log` with 40 characters to the reference, and 41 | `blocked-by`; a citation | the same |

What it trades. The false negatives it removes are relations a sentence
states after a clause that ends in a negation: a condition, `if not` or
`or not`, an answer, `no` or `not yet`, a value, `nobody`. The false
positives it adds are negations that deny the phrase they stand before
and are set apart from it by a comma all the same: an emphatic one,
`never, ever,` or `not, repeat, not,`, and a comma written between a
negation and its own verb, `it isn't, blocked by`. The first are the way
a clause is ended in English, and the second a way of writing that
specifications rarely use; read either way, one kind is missed. A
negation set apart from the phrase by more than a comma was not read
before and is not now: `Not, as it happens, blocked by` states what its
sentence denies, as it did.

Measured on the Markdown of the family's five repositories as each main
had it (spec-core 153ba40, spec-brief fbe9875, spec-graph 29c7b8a,
spec-guard 3b65529, spec-harness 3c4112c): 515 relations, and two read
otherwise, both in this ADR, where the amendment of 2026-10-18 quoted the
two sentences above in prose: each was read as the relation it states.
They are written in code now, as the other sentences it quotes are, and
with that no relation of the family's changed. No repository outside the
family was read for this amendment.

**A negation after the phrase is read as it was.** The rule that a comma
is a boundary a negation does not cross was asked for in either
direction, and after the phrase, between it and the reference, it was
measured two ways and neither is taken. Where a comma between the phrase
and the negation kept the two apart, `Blocked by ADR-0003, not ADR-0002`,
`Blocked by ADR-0003, ADR-0004, not ADR-0002` and
`Deferred to the team, not to [ADR-0002]` read relations to the document
each denies one, the first two a list's own exception. Where the negation
was kept from the phrase and the reference only by a comma on each side,
so that it cancels what it stands beside and nothing set off from it,
`Blocked by, if nothing else, [ADR-0002]`,
`Deferred to, but not owned by, [ADR-0002]` and
`Blocked by ADR-0003, never by the cache, and ADR-0002` read the relation
each states, and
`Superseded by, as of today, nothing, though ADR-0002 proposes to` and
`Deferred to, at present, nobody, though ADR-0002 asked` read a
supersession and a hand-off each denies: the inference this ADR names the
worst, for a miss of the same kind. A negation anywhere between the phrase
and the reference cancels it, whatever commas stand there.

A check that passed can fail, so it arrives in a minor release. Four
checks, measured on both builds:

| The corpus | 0.18.0 | Now |
| --- | --- | --- |
| An open question in a live document, `if not, blocked by` a superseded one | exit `0` | exit `1`, `ghost-handover` |
| A live document, `both or neither, because` a superseded one says so | exit `0` | exit `1`, `stale-premise` |
| An open question in a superseded document, `not yet, deferred to` a live one | exit `1`, `orphaned-obligation` | exit `0` |
| An open question in a live document, `never, ever, blocked by` a superseded one | exit `0` | exit `1`, `ghost-handover` |

## Open Questions

- [ ] Should the default include patterns be widened, or is naming the fix in
      the hint enough? Widening risks pulling in changelogs and issue templates,
      which is a different kind of noise.
- [x] Should there be a `--strict` that promotes every warning to an error, for
      teams past the first run? **Resolved (2026-09-07):** yes, shipped. It
      raises `warn` to `error`, leaves `info` alone because those rules are
      advisory by design, and lets an explicit `--rule` win so a team can adopt
      strict and exempt the one rule their repository disagrees with. Every
      escalated finding is labelled, so a reader can always tell what the build
      would do without the flag.

## See also

- [ADR-0004](0004-reference-resolution.md) applies this to reference resolution.
