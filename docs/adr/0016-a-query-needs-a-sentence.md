---
status: accepted
date: 2026-09-12
---

# ADR-0016: A query needs a sentence before it is a rule

## Context

[ADR-0005](0005-rules-are-queries.md) made a claim: the selector language is
expressive enough that a team whose convention spec-graph never anticipated can
express it without writing a plugin. Two built-in rules are selectors rather
than hand-written traversals, and that was offered as the proof.

For three releases the claim was only half true. `spec-graph query` could find
the thing; nothing could make finding it *fail*. The README's own answer was a
line of shell with a `!` in front of it, which loses the message, the hint, the
severity, the baseline, the sort order and the SARIF annotation — everything
that makes a finding worth reading.

Three ADRs recorded the same gap, and all three stopped at the same sentence:

- [ADR-0005](0005-rules-are-queries.md): "a query needs a severity and a message
  before it is a rule, and that is a larger design than a place to put it."
- [ADR-0010](0010-configuration-belongs-to-the-repository.md): "Named queries
  from ADR-0005 still have no home. The file is now the obvious one."
- [ADR-0012](0012-a-baseline-is-a-ratchet.md): "a baseline of user-defined rules
  would need one first."

The file arrived in 0.2.0. What was still missing was the sentence.

## Decision

**A project rule is a selector, a message, a hint and a severity, declared in
`.spec-graph.json` and run beside the built-ins.**

```json
"rules": {
  "no-draft-dependency": {
    "query": "document[phase=active] -depends-on-> document[phase=draft]",
    "message": "{0} depends on {1}, which is still a draft",
    "hint": "wait for {1} to be accepted, or drop it from {0.path}",
    "severity": "error"
  }
}
```

### The namespace is load-bearing

The id is the name with `project:` in front. That prefix is not decoration and
not politeness: a built-in id can never contain a colon, so a project rule can
never collide with one however a repository names it.

Which is what makes the rest of this ADR short. `--rule`, the severity table,
`--strict`, `--record-baseline`, the sort order, the record exemption, the
related-location cap and the SARIF `ruleId` all key on a rule id, and none of
them had to be taught what a project rule is. `RuleId` stays the closed union it
was; `AnyRuleId` is that union plus a template literal type, so the compiler
still checks a built-in exhaustively while a project id passes through every
surface intact.

The alternative was a reserved vocabulary — forbidding a repository from naming
a rule `broken-reference`. That is a rule about names, enforced at load time,
that a reader has to know about. A prefix is a rule about shape, enforced by
construction, that a reader can see.

### A message is a template over the path a query already numbers

`{0}` is the first node on the path and `{1}` the next; `{1.phase}` and
`{0.fm.owner}` read any attribute a selector can read. Positional, because a
path is positional, and naming the positions would mean inventing a second
vocabulary for something the selector already numbers. Attributes rather than a
second syntax, because `attributesOf` is the one place that knows what a node
answers to, and a template that could ask a different question from a predicate
would be two vocabularies for one graph.

### Everything that can be checked is checked when the file is read

A selector that does not parse, a `{2}` no query can reach, an attribute nothing
answers to, a name with a tab in it: all reported at load time, next to every
other configuration problem, with the rule left out of the run. The failure this
avoids is specific and nasty — a rule that looks configured, runs, matches
nothing, and is trusted. Silence from a linter is indistinguishable from health,
which is exactly why a rule that *cannot* work must say so rather than say
nothing.

`{2}` is checked against the *shortest* selector behind a rule, not the longest,
because a placeholder has to resolve for every one of them. The published list
of attributes is `SELECTOR_KEYS`, and a test reads the switch in `select.ts` to
make sure the list has not drifted from it — a published list that had would
either reject a key that works or accept one that renders as a blank space where
a document name should be.

Selectors are kept as written, beside the compiled form. A report has to
describe the rule, and the only honest description of a project rule is the
query behind it: its message is a template, and a template with `{0}` in it
describes nothing. Echoing the text back is exact and free.

### A list of selectors is a union, and that closes a different question

`query` takes a selector or a list of them, and a list is read as a union. A
path both selectors find is one finding, because a repository that broke one
convention once must not be told about it twice.

This answers ADR-0005's other open question — whether the grammar should support
top-level disjunction — by putting the union one level up. `a, b` inside a
selector would have to interact with predicates, with steps, and with the
transitive forms, and every one of those is a place to be subtly wrong. A list
of complete selectors has no interactions at all.

### `warn` by default

A rule a team has just written has not yet earned the right to stop their build,
and the first run of a new convention is exactly when it is most likely to be
wrong. `--strict` promotes it on the same terms as a built-in, and an explicit
`--rule` still wins over strict, so a team can adopt strict and exempt the one
convention they are still calibrating.

### A baseline accepts a project id on its namespace alone

`parseBaseline` takes `project:anything` without checking that it exists, because
the baseline is read before the configuration that defines it has any say.
Rejecting the entry would un-accept debt somebody had signed off. A name nothing
defines suppresses nothing and is reported as stale, which says the same thing
by a route that leaves the file readable.

A rule name may not contain a tab. A baseline key is three fields joined by one,
and a rule id that could contain a tab would be accepted debt that could be
forged by typing carefully.

## Consequences

A repository can now express a convention spec-graph never anticipated and have
it fail a build, which is what ADR-0005 promised. The cost is that
`.spec-graph.json` can now contain something wrong in a way that matters — a
selector is a small language, and a small language still has syntax errors. That
is paid for at load time and reported in full.

Project rules inherit the record exemption from
[ADR-0011](0011-a-record-is-not-a-specification.md) without opting in. A journal
is not the subject of a finding about obligations, and a rule written by a
repository is a rule about obligations until it says otherwise. No way to opt out
of that is offered, because nobody has asked and the exemption has never been
wrong.

Nothing here widens what spec-graph *reads*. A project rule asks a question about
the graph that was already built; it cannot add a node, an edge or a parse.

**`~=` can hang a build, and this ADR moves where that lives.** The predicate
compiles a JavaScript regular expression, and `[title~=(a+)+$]` against a long
enough title backtracks exponentially. Probing found it at once: 40 documents and
the process never returned.

The hazard is not new — `spec-graph query 'document[title~=(a+)+$]'` has hung
since 0.1.0, and `safeRegExp` has only ever guarded against a pattern that fails
to *compile*. What is new is the residence. A command line is typed by the person
waiting for it; a configuration file is written once and then runs on every build
for people who did not write it, over a corpus that grows.

Nothing is done about it here, and the alternatives were weighed rather than
skipped:

- **Reject nested quantifiers.** Catches `(a+)+` and misses `(a|a)+`. A guard
  that is incomplete and says it is safe is worse than no guard, which is the
  same argument ADR-0006 makes about findings.
- **Ban `~=` from project rules.** Breaks the symmetry ADR-0005 rests on for a
  foot-gun that lives in the repository's own file. If `~=` is too dangerous for
  a config file it is too dangerous for the command line, and the answer would be
  to remove it from both.
- **Time-box the match.** There is no deadline for a regex in Node without a
  worker, and a resident worker is the thing ADR-0015 declined.

So `~=` stays, on the same terms it already had, and the help now says it is a
JavaScript regular expression run once per node. `^=`, `$=` and `*=` cover the
cases most rules actually want and cannot backtrack at all.

**A transitive project rule can produce ten thousand findings.** That is the
engine's match limit doing its job - the ceiling is fixed rather than a function
of the corpus - and `--max` is what makes the report readable. Measured at 120 ms
over 300 documents and 2,955 edges, which is the shape a test now holds.

## Open Questions

- [ ] Should `spec-graph query project:no-drafts` run a named rule by its id?
      The rule is already compiled by then, and a team debugging a convention
      currently has to copy the selector out of the file.
- [ ] Should a project rule be able to name its own `related` locations? It gets
      every edge after the first, which is the right default and is not
      configurable.
- [ ] Should a rule be able to declare itself exempt from the record exemption?
      No corpus has asked, and guessing at the answer would mean shipping a knob
      that documents a distinction nobody has needed to draw.
- [ ] Should `~=` run on a matcher that cannot backtrack? A hand-written NFA
      would make the predicate linear in the subject and close the hang above,
      at the cost of a regex dialect that is not the one anybody expects. Worth
      it only if a real repository hangs on this; none has.

## See also

- [ADR-0005](0005-rules-are-queries.md) made the claim this implements, and
  carried the open question for three releases.
- [ADR-0010](0010-configuration-belongs-to-the-repository.md) is the file these
  rules live in.
- [ADR-0012](0012-a-baseline-is-a-ratchet.md) is the baseline they are accepted
  in.
- [ADR-0006](0006-false-positives-cost-more.md) is why a new rule defaults to
  `warn`.
