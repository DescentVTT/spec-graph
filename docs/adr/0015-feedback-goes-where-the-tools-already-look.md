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

*Amended 2026-09-13 with a second format and five more declines, all of which
turn on the same question: what already reads this, and who is it for.*

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

### Markdown, because of who reads it (2026-09-13)

SARIF puts a finding on the line that caused it, which is where somebody fixing
one wants it. It says nothing at all to the person deciding whether to merge: a
code-scanning alert is a list of lines, not a verdict, and it is on a different
tab from the review.

`--format markdown` is the verdict. The corpus counts, one table of findings
with each hint beside its message, and underneath it the baseline's slack -
*named* rather than counted, with the `paid` and `gone` labels from
[ADR-0012](0012-a-baseline-is-a-ratchet.md), because on a pull request a count
is the one thing a reader cannot act on.

Three decisions inside it are worth recording:

- **Named for what it is, not where it goes.** `$GITHUB_STEP_SUMMARY` is the
  reason it exists, and the same text is what a pull-request comment, a chat
  message or a generated page wants. A `--format github` would have been a
  narrower name for an identical file - and ambiguous besides, since SARIF is
  also for GitHub.
- **No environment detection.** Emitting Markdown automatically because
  `$GITHUB_STEP_SUMMARY` is set would make the format depend on where the
  command ran, which is the property `--format` exists to control. A pipeline
  redirecting stdout to a file would silently start getting a different
  document. Explicit stays deterministic.
- **The table escapes what it interpolates.** A pipe would end a cell and a
  newline would end a row, and since [ADR-0016](0016-a-query-needs-a-sentence.md)
  a message is a template the repository controls. That is user input reaching
  a table, so it is escaped like one.

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

**And the incremental half of the idea is not just stateful, it is wrong.**
The version usually proposed keeps the corpus in memory and re-scans only the
file that changed. It cannot work, because several of the answers here are
properties of the whole corpus rather than of one file: whether a bare `ADR-0099`
in prose is a citation depends on which families exist elsewhere
([ADR-0004](0004-reference-resolution.md)), a near-miss suggestion is computed
against every sibling document, and an identifier is ambiguous only relative to
what else claims it. Touch one file and the honest set of findings to recompute
is all of them. Which is fine - the pipeline is a pure function and 60 ms long -
but then the incremental index buys nothing and the whole feature is a loop.

The README states the absence with the one-line substitute, rather than leaving
it to be read as an oversight.

## Alternatives considered

**A language server.** The right shape for editor feedback, an order of magnitude
more surface than SARIF, and unnecessary while SARIF already reaches the problems
pane. Worth revisiting if the ask becomes hover and go-to-definition over the
graph, which is a genuinely different feature.

*Weighed again 2026-09-13 and still declined,* with the shape of the eventual
job now clearer than it was. Two things an LSP needs are already true:
`analyseSources()` takes text rather than paths, so an unsaved buffer needs no
temporary file, and every finding already carries a span. What is missing is the
protocol - initialize, capabilities, incremental document sync, framing - plus a
client extension per editor before any of it is usable by anybody. That is a
second package's worth of work and a standing maintenance commitment, and it
should be started when somebody wants hover and go-to-definition, not as a way
of delivering diagnostics that already arrive.

**Code frames in the terminal.** Two or three lines of source under each
finding, with a caret at the span. Attractive for a multi-hop project rule whose
`{0}` and `{1}` are in different files, and declined: the report already prints
`file:line:column`, which every terminal and editor in use turns into a click,
and `renderMatch` already prints the shape of the path. A code frame would
duplicate what the reader's own editor shows a keystroke later, and it would
need the source text carried as far as the reporter - which the reporter
deliberately does not have.

**A Model Context Protocol server.** The strategic case is real: an agent
drafting specifications wants to check a candidate edit before committing it.
The capability is already here - `analyseSources()` is exactly that call, and
`--format json` is exactly that answer - so what an MCP server would add is a
protocol implementation, hand-written to keep the dependency count at zero,
tracking a specification that is still moving, to expose three tools that are
three shell commands an agent can already run. "Latest is not newest" is the
rule this repository is built on, and this is the case it was written for. It
changes if an agent host appears that can speak MCP and cannot run a command.

**Provenance and attestation metadata.** Binding commit hashes, author
identities and verification timestamps into the exports, for a traceability
matrix in a regulated industry. Declined on the invariant: a timestamp in the
output means no two reports of the same corpus are ever byte-identical, which is
the property every format here is built to have. The commit is something CI
already knows and can record beside the report; asking the tool to read git
would put discovery and process spawning under a pipeline that is a pure
function of text.

**An interactive SVG or HTML graph.** A layout engine or a vendored
visualisation library, which is a runtime dependency wherever it sits in the
tarball, producing output whose bytes depend on a layout pass. `--graph-format
dot` and `mermaid` hand the layout to a tool built for it, and both are text.

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

- [ ] Should `spec-graph diff` report what changed *relationally* between two
      states of the graph - dependencies added or removed, a specification that
      moved from `draft` to `accepted`, an obligation that is newly unfulfilled?
      Noted here (2026-09-13) because it is the one item on this list that is
      deferred rather than declined, and because half the design is a decision
      that should be recorded before anybody writes it.

      **Not between two git revisions.** That means spawning a binary or reading
      an object store, which puts discovery and process control underneath a
      pipeline whose entire test strategy rests on being a pure function of
      text. The shape that keeps the invariant is a diff between two
      `--graph-format json` exports: two files in, one report out, pure, and CI
      already has both checkouts. `git stash`, a second worktree or the base
      branch's artifact each produce the second export in one line.

      The identity work it needs is done: a node is keyed the way
      [ADR-0012](0012-a-baseline-is-a-ratchet.md) keys a baseline entry, which
      survives a file being moved or renamed. What is left is a command, a
      comparison and a format, and 0.5.0 already carries a new matcher and a new
      rule about where the root is.
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
- [ADR-0017](0017-a-predicate-must-finish.md) - the other half of what a
  resident process was declined for: the pipeline now has no unbounded
  component, which is a property only a pure one can claim.
