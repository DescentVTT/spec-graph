---
status: accepted
date: 2026-09-10
---

# ADR-0015: Feedback goes where the tools already look

## Context

A full run over this repository takes about 60 ms, and over a 400-document
corpus it is still well under a second. The engine is not the reason a developer
finds out late; the reason is that the answer arrives as an exit code in a CI
log, twenty minutes after the push, on a page nobody opens unless it is red.

Two ways to close that gap get proposed, and they look similar from a distance:

1. Make the tool resident, so it re-checks on save.
2. Make the output legible to the things a developer already has open.

## Decision

**Emit SARIF, and do not build a watcher.**

### SARIF, because of what reads it

`--format sarif` writes SARIF 2.1.0. The reason is not the format, which is
verbose and nobody enjoys; it is that `github/codeql-action/upload-sarif` turns
it into annotations on the diff, and editors turn it into the problems pane,
with no integration written on either side.

One field decided it. `partialFingerprints` is how a consumer follows one finding
across commits without keying on a line number - so that a reviewer is not shown
the same annotation twice because a paragraph moved. spec-graph has had exactly
that identifier since [ADR-0012](0012-a-baseline-is-a-ratchet.md), built for
exactly that reason: the rule, the specification, and the citation, with no
position in it. The baseline key and the SARIF fingerprint turned out to be the
same problem, so they are the same string.

Three properties are kept deliberately:

- **The driver describes the run, not the tool.** Only rules that fired are
  listed. A file claiming eleven rules and reporting two describes a program.
- **No timestamp, no absolute path, no run id.** Two runs over the same corpus
  produce byte-identical output, like every other format here.
- **`check` only.** SARIF is a report about findings and no other command
  produces any. Falling back to JSON for `graph` would fail later, in somebody
  else's uploader, with a message about a schema rather than about the command.

`--format json` stays the output to parse when building something bespoke: it
carries the baseline note, the summary and the per-file detail SARIF has nowhere
to put.

### No watcher, and the README says so

A `--watch` mode would save typing a command that takes 60 ms. Against that:

**It buys nothing the shell does not already have.** A loop, an editor's on-save
task, or `nodemon` all do it, in the tool the developer has already configured,
and none of them is spec-graph's to maintain.

**It contradicts the structure everything here rests on.** I/O stays at the
edges; the scanner, extraction, resolution, the graph and the rules are a pure
function of text. That is why tests can build a pathological corpus in memory
and why `analyseSources()` is a first-class entry point. A watcher is a resident
process, a debounce timer and a mutable file-set - state, in the one codebase
whose testability comes from not having any.

**`fs.watch` is the least deterministic API in Node.** Editors save atomically,
so a save arrives as `rename` on one platform and `change` on another; Windows
emits duplicates; recursive watching has a different implementation on each of
the three platforms this must work on. Byte-determinism across Linux, macOS and
Windows is an invariant here, and a watcher would be the one part of the program
that could not honour it.

**It adds no verification.** It makes an existing check faster to trigger. Every
other change in this release makes the tool *correct* about something it was
wrong about.

The README states the absence with the one-line substitute, rather than leaving
it to be read as an oversight.

## Alternatives considered

**A language server.** The right shape for editor feedback, an order of magnitude
more surface than SARIF, and unnecessary while SARIF already reaches the problems
pane. Worth revisiting if the ask becomes hover and go-to-definition over the
graph, which is a genuinely different feature.

**Emitting SARIF instead of JSON.** SARIF has no home for the baseline note, the
per-file counts or the summary, and a consumer wanting those would have to
recompute them. Two formats, two audiences.

**Watching, but only under an explicit flag.** The flag is not what costs; the
resident process is. A feature nobody can test the way the rest of this codebase
is tested does not become cheaper by being opt-in.

## Consequences

A repository can annotate its pull requests in four lines of workflow YAML, and
the annotations survive a reformat because the fingerprint has no position in it.

Adding a rule now means adding it to a fourth place - severity, description,
README table, and whatever a SARIF consumer has pinned - though only the first
three are enforced by a test. The `RULE_DESCRIPTIONS` table already feeds SARIF,
so in practice the description is written once.

## Open Questions

- [x] SARIF's `fixes` field can carry a machine-applicable edit, and several
      findings have exactly one. **Declined (2026-09-12).** Counted, and
      "several" was generous: exactly one rule has a fix that is an edit rather
      than a judgement. `unknown-relation-key` knows the key's span and the
      spelling to put there. Everything else is a guess or a construction -
      `superseded-by: ADR-0002` has to be *inserted*, into front matter that may
      not exist yet, at a position only a human can choose.

      [ADR-0004](0004-reference-resolution.md)'s near-miss suggestions made the
      case weaker rather than stronger. There is now a "did you mean ADR-0015?"
      to attach to a `broken-reference`, and it is deliberately a guess - one
      candidate or silence, never certainty. Promoting a guess to a
      machine-applicable edit would throw away the restraint that makes it
      worth printing.

      Shipping `fixes` for one rule out of twelve teaches an editor's user that
      spec-graph findings are fixable, on a corpus where they mostly are not.
- [x] The stale baseline entries are named in the human report and counted in
      JSON. **Resolved (2026-09-12):** they are in the note, as
      `baseline.entries`, each carrying the `paid` or `gone` label from
      [ADR-0012](0012-a-baseline-is-a-ratchet.md). A count is enough to know the
      file has slack and never enough to strike it, and the rows cannot go on
      stdout beside a JSON document without breaking the parse.

      Not added to SARIF. The semantically correct slot is
      `invocations[].toolConfigurationNotifications`, and nothing that consumes
      SARIF renders it - an annotation nobody sees is the cost of this format
      without the benefit. `--record-baseline` and a diff remain the better
      answer there, as they were always going to be.

## See also

- [ADR-0012](0012-a-baseline-is-a-ratchet.md) - the fingerprint SARIF reuses,
  and the reasoning that made it position-free.
