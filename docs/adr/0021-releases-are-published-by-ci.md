---
status: accepted
date: 2026-09-24
---

# ADR-0021: Releases are published by CI, with provenance

## Context

Ten versions, 0.2.0 to 0.8.0, were published with `npm publish` from a
workstation and a one-time password. It worked every time. It also asked
everybody who installs spec-graph to take three things on trust that none of
them can check:

- that the `dist/` in the tarball was compiled from the commit the tag names,
  rather than from whatever happened to be in the working tree;
- that the four checks in CLAUDE.md passed on that commit before it went out;
- that the credential able to publish has not been copied off the machine that
  holds it.

The registry records none of it. A published tarball names a repository in its
metadata because the author typed it there, and that is the whole of the link
between what is installed and what can be read.

That is a poor trade for any package and a worse one for this package.
spec-graph runs inside other repositories' pipelines, reads their documentation
and decides whether their build fails. A linter is installed once and then
stopped being looked at, which is the property that makes it useful and the
property that makes a bad version of it expensive.

npm's trusted publishing, generally available since July 2025, accepts a publish
from a named workflow in a named repository on the strength of the OIDC token
GitHub issues to that run. The token is minted for one job, expires in minutes,
and is never written down: there is no secret in the repository to leak and none
to rotate. A version published that way carries a provenance attestation, signed
through Sigstore and logged publicly, naming the repository, the commit and the
run that built it. `npm audit signatures` checks it, from the consumer's side,
without asking anybody to be believed.

## Decision

**A version tag publishes, and nothing else does.** On a `v*` tag,
`.github/workflows/release.yml` runs four jobs, each holding only the access it
needs and no more.

1. **CI again**, the whole matrix on the tagged commit. `ci.yml` gained a
   `workflow_call` trigger for it. This is not belt and braces: CI on main
   cancels a run when a newer push arrives, so a tagged commit may never have
   finished one.
2. **`pack`**, with read access alone. The commit must be one main has, the tag
   must be `v` followed by the version in `package.json`, and `CHANGELOG.md`
   must have a section for that version with text in it (`scripts/release.mjs`).
   It then builds from clean, packs, and uploads the tarball together with the
   changelog section as release notes.
3. **`publish`**, the only job with `id-token: write`, running in the `npm`
   environment. It checks out nothing, installs nothing and builds nothing: it
   downloads the tarball the job above produced and hands that to npm, byte for
   byte. A development dependency that has been taken over runs in `pack`,
   where there is no token to take.
4. **`github-release`**, with `contents: write` alone: the changelog section as
   the notes, and the tarball npm has as the asset.

A prerelease version, one with a `-` in it, goes out under the `next` dist-tag
and never becomes `latest`. Installing with no version is what most upgrades
are, and a candidate arriving there is the one mistake a dist-tag exists to
prevent.

Run by hand from main, the workflow rehearses: every job but the GitHub release,
with `npm publish --dry-run` in place of the upload. npm refuses even a dry run
over a version it already has, so a rehearsal of a published version stops
before the upload and says so. The exchange with npm is the one step a rehearsal
cannot try.

### The check runs at both ends

`scripts/release.mjs` is the gate on the tag, and the same function runs in the
unit suite against this repository's own `package.json` and `CHANGELOG.md`. A
pull request that bumps the version without writing the notes fails there,
where somebody is looking, rather than in a release job an hour later. npm never
lets a version number be used again, so every mistake worth catching is one that
cannot be taken back.

### The mutation sweep is not in the release path

It takes about three hours in four shards, it already runs on a `v*` tag of its
own accord, and its score moves with the runner by more than the margin anybody
would gate on ([ADR-0007](0007-mutation-testing.md),
[ADR-0019](0019-the-sweep-runs-in-shards.md)). A release that waited on it would
be a release waiting on a number nobody can reproduce.

### The actions are pinned to commits

Every `uses:` in all three workflows names a commit, with the tag beside it as a
comment, and every checkout sets `persist-credentials: false`. The argument
above is that the tarball can be traced to a commit and a run; that is worth
little if the run can be changed underneath the repository by moving a tag in
somebody else's. Each workflow also states its `permissions` rather than
inheriting whatever the repository setting happens to be.

Two of the pinned actions were on lines that had stopped receiving fixes -
`setup-node` v5 and `cache` v4 did not get the 2026 updates their newer majors
did - so pinning meant moving those forward. The pins are the newest patch of
the newest major that has been out long enough to have one, which is not always
the newest major there is.

*Amended 2026-09-26.* `publish` stages the version rather than publishing
it. 0.9.0, the first tag, passed every job and was refused at the upload,
`OIDC permission denied`: a trusted publisher configured after 2026-09-03
permits `npm stage publish` by default, and a direct publish only where the
package opts in. Staging is the better of the two answers. The version waits on
npmjs.com, installable by nobody, until a maintainer runs `npm stage approve`
with a second factor, so a person decides that each version goes out, and a
run that is not the maintainer's can at most queue one. The job installs an npm
new enough to stage, 11.15 or later inside 11.x. spec-guard releases the same
way.

## Consequences

- **A maintainer sets up npmjs.com once.** In the package's settings, add a
  trusted publisher: GitHub Actions, repository `DescentVTT/spec-graph`,
  workflow `release.yml`, environment `npm`. Then set publishing access to
  require two-factor authentication and disallow tokens, which leaves this
  workflow and a person holding a second factor as the only ways to publish.
- **A maintainer approves each release.** The tag's run ends with the version
  staged, and its summary names the commands: `npm stage list
  @descent-vtt/spec-graph`, `npm stage view <id>`, then `npm stage approve <id>`
  with a second factor, or the Staged Packages tab on npmjs.com.
- **The `npm` environment carries the release's own protections**, in the
  repository's settings rather than in this file: which refs may deploy to it,
  and a required reviewer where a release should wait for one.
- **Pushing a `v*` tag is now the act of releasing**, so a repository ruleset
  restricts creating, updating and deleting those tags to administrators. A tag
  pushed by accident used to be a tag; it is now a publish.
- **0.2.0 to 0.8.0 have no provenance, and never will.** Every later version
  does, and the difference is visible on the registry page and to
  `npm audit signatures`.
- **Three things can no longer be done by hand**: publishing from a working
  tree, publishing a commit main does not have, and publishing a version the
  changelog says nothing about. That is the point of the change rather than a
  cost of it, but it is a real loss of a fast path, and the rehearsal exists
  because the fast path is what people reach for when a release is urgent.

## Alternatives considered

**A granular access token in a repository secret.** It would get provenance too,
and it puts back exactly what this removes: a long-lived credential, in a place
that has to be guarded and rotated, that publishes from anywhere it is copied
to. Trusted publishing exists because this was the state of the art and was not
good enough.

**Publishing from the workstation, with provenance.** Not available. Provenance
is issued against a CI identity; there is nothing for a laptop to attest with.

**Publishing when a version bump merges to main.** It would remove the tag, and
the ruleset with it. It also makes a release a side effect of a merge, decided
by a diff of `package.json`, where a tag is somebody saying that this commit is
the release. The tag is what the changelog, the GitHub release and the two tags
already in this repository's history are keyed on.

**`npm version` inside CI, committing the bump.** A write credential back in the
release path, to save one command on a branch.

## Open Questions

- [ ] Should the `npm` environment require a reviewer? The workflow supports it
      and it is off: the gate today is who can push a `v*` tag, which is the
      same set of people. It is worth turning on the first time a release goes
      out that somebody did not mean to send.
- [ ] Should the workflow verify its own work - `npm audit signatures` against
      the freshly published version, as a fifth job? It would catch a provenance
      that silently did not attach, which is a failure mode nobody has seen yet.
- [ ] Should the tarball also be attested with `actions/attest-build-provenance`,
      giving an attestation on the GitHub side as well as npm's? Two
      attestations of one artifact is either defence in depth or two things to
      keep in step.

## See also

- [ADR-0007](0007-mutation-testing.md) - what the mutation score is worth, and
  why it is not a release gate.
- [ADR-0019](0019-the-sweep-runs-in-shards.md) - the sweep's shape and its cost.
