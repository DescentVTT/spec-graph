---
status: accepted
date: 2026-09-14
---

# ADR-0019: The sweep runs in shards

## Context

[ADR-0007](0007-mutation-testing.md) made the hosted mutation sweep the figure
that governs, and then measured what it costs. The same source took one runner
168, 171 and 166 minutes, three times. The job's cap went from 120 to 180 to 240
to keep a slow runner from cancelling it. The figure arrived per tag and once a
week. A pull request that touched the pipeline waited 30 to 110 minutes for an
incremental signal that was not the figure either.

@descent-vtt/spec-guard reached the same wall at 42m39s, against a limit of 45,
and split its sweep across parallel jobs. One merge step puts the reports back
together, refuses anything that is not exactly one sweep, and applies the gate
to the merged score. Its sweep now takes 15m33s from the first shard to the
score. The design transfers, and so do the failures its history records.

## Decision

**The hosted sweep runs as four shards, each mutating its own files against
every test. `scripts/mutation-shards.mjs` merges their reports and applies the
gate to the merged score.**

### Where the minutes are

Stryker's reports carry no timings. Its progress reporter prints a timestamped
count every few seconds, and Stryker tests mutants in a fixed order: uncovered
first, then file by file, with static mutants moved to the end. So each file
owns a stretch of the count, and `scripts/mutation-timeline.mjs` reads the
stretches off a log. The order is inferred from Stryker's source, so the script
checks it: the timeouts counted inside each stretch must match the report's
timeouts for that file. On the 2026-09-14 schedule's log they matched exactly
for the files that matter - 104 in `extract.ts`, 87 in `state.ts`, 55 in
`markdown.ts`, 26 in `regex.ts`.

| file | minutes | of which static |
| --- | ---: | ---: |
| `extract.ts` | 42.5 | 42.1 |
| `markdown.ts` | 32.2 | 32.2 |
| `state.ts` | 17.0 | 16.9 |
| `rules.ts` | 11.6 | 11.1 |
| `identity.ts` | 9.0 | 8.6 |
| `lifecycle.ts` | 8.9 | 8.8 |
| `yaml.ts` | 7.7 | 7.5 |
| the other fifteen | 36.9 | |

166 minutes in all, and 155 of them are static mutants - the cost ADR-0007
already names. **A shard cannot take less time than its largest file**,
so no number of whole-file shards gets under `extract.ts`'s 42.5. Four is the
fewest that reach that floor, and six or eight would give the same wall time
from more jobs:

| shard | files | minutes |
| --- | --- | ---: |
| 1 | `extract.ts` | 42.5 |
| 2 | `markdown.ts`, `identity.ts` | 41.2 |
| 3 | `state.ts`, `yaml.ts`, `sections.ts`, `graph.ts`, `regex.ts`, `cli.ts`, `glob.ts`, `paths.ts`, `baseline.ts` | 40.8 |
| 4 | everything else the configuration mutates | 41.3 |

The last shard is written as the base patterns less the listed files, not as a
list, so a file added later is mutated without anyone remembering to assign it.

*Amended 2026-09-26.* `regex.ts` has left shard 3: the matcher moved to
spec-core ([ADR-0017](0017-a-predicate-must-finish.md)), and the copy under
`src/vendor/` is mutated by no shard, because spec-core's sweep measures it.

*Amended again the same day.* The scanner and the front-matter reader moved
there too ([ADR-0023](0023-the-scanner-is-the-familys.md)). `markdown.ts` and
`yaml.ts` stay in their shards, holding only spec-graph's reading of what
spec-core's copies report, so shard 2 is nearer ten minutes than forty-one and
shard 3 some eight minutes lighter until a sweep measures them again. The wall
time is still `extract.ts`'s, in shard 1.

*Amended 2026-10-01.* It was not. The table above was balanced on a sweep run
in one process, and a shard instruments only its own files, so a file's
minutes in a shard are not its minutes there, as spec-core found when it split
its own sweep ([its record of
2026-09-30](https://github.com/DescentVTT/spec-core/blob/main/docs/adr/0007-verification.md)).
In the three sweeps of 58a5389's source, shard 2 finished in 5 to 7 minutes
and shard 3, which held `state.ts`, in 30 to 31, and shard 3 set the wall time
of all three while `extract.ts` alone took 23 to 30. Read shard by shard,
those sweeps (runs 36681244752, 36684834993 and 36695585590) give:

| file | minutes | static mutants timed out |
| --- | ---: | ---: |
| `extract.ts` | 22.5 to 29.3 | 102 |
| `state.ts` | 16.3 to 16.8 | 84 |
| `identity.ts` | 4.7 to 6.4 | 0 |
| `resolve.ts` | 4.3 to 4.8 | 0 |
| `rules.ts` | 4.1 to 4.5 | 0 |
| `select.ts` | 3.3 to 4.0 | 5 |
| the other sixteen | 23.7 to 24.5 | 0 |

Most of `extract.ts`'s minutes, and of `state.ts`'s, are those static mutants.
Stryker cuts each off at one and a half times the whole suite's time, plus
`timeoutMS`, plus the overhead of a test run, and the suite and the overhead
are slower on a slower runner and in a shard that instruments more files. The
runner is most of what moves `extract.ts`: over five sweeps its clock read
28.9 to 36.2 seconds, and its minutes followed, 22.5 on the fastest and 31.0
on the slowest.

**The layout.** `extract.ts` keeps a shard to itself, and it is the floor.
`state.ts` shares one with three small files, and the other files are balanced
under `extract.ts`:

| shard | files | mutants | minutes, run 36714214913 |
| --- | --- | ---: | ---: |
| 1 | `extract.ts` | 1,292 | 31.6 |
| 2 | `state.ts`, `glob.ts`, `paths.ts`, `yaml.ts` | 902 | 20.6 |
| 3 | `identity.ts`, `resolve.ts`, `rules.ts`, `select.ts` | 1,975 | 19.3 |
| 4 | everything else the configuration mutates: `cli.ts`, `report.ts`, `diff.ts`, `sections.ts`, `config.ts`, `lifecycle.ts`, `directives.ts`, `project-rules.ts`, `baseline.ts`, `graph.ts`, `runner.ts`, `markdown.ts`, `source.ts` | 4,224 | 21.4 |

The first try held `yaml.ts` in shard 3, and its sweep (run 36710662185) took
30.2, 15.2, 21.8 and 16.4 minutes; `yaml.ts`, 110 mutants and under two
minutes, moved to the lighter shard. That sweep drew fast runners for shards 2
and 4, and the sweep of this layout slow ones for all four; shards 2 to 4 took
15 to 22 minutes between them, and none came within a minute of `extract.ts`'s
fastest.

**Still four.** Three would put 28 minutes or more beside `extract.ts`. A
fifth would wait on it just the same, from one more job, and a push already
runs CI's seven jobs beside these, on an account whose other repositories'
CI and sweeps share the twenty jobs GitHub runs at once on a free plan.

**The sweeps**, from the first shard starting to the merged score:

| sweep | score | killed | timeout | survived | shards | took |
| --- | ---: | ---: | ---: | ---: | --- | ---: |
| main, 58a5389 | 96.32 | 7,825 | 259 | 293 | 29m48s, 6m39s, 31m09s, 22m43s | 31m49s |
| main, 56f8a6c | 96.32 | 7,827 | 257 | 293 | 24m55s, 5m22s, 30m03s, 23m28s | 30m38s |
| tag v0.11.0 | 96.32 | 7,825 | 259 | 293 | 22m53s, 7m15s, 30m52s, 23m59s | 31m43s |
| dispatch, first try | 96.32 | 7,827 | 257 | 293 | 30m11s, 15m12s, 21m49s, 16m26s | 31m28s |
| dispatch, this layout | 96.32 | 7,826 | 258 | 293 | 31m33s, 20m36s, 19m15s, 21m24s | 32m12s |

The same source throughout, 8,393 mutants with 16 uncovered. Mutant by mutant,
the two dispatched sweeps differ from main's three by one to three mutants
moving between killed and timed out, in `graph.ts` and `extract.ts`, as main's
three differ from each other by two; the same 293 survived in all five.

The wall time is now `extract.ts`'s and no other shard's: 23 to 32 minutes as
its runner goes, where it used to be the larger of that and shard 3's 30 to 31.
Both dispatched sweeps drew `extract.ts` its two slowest runners yet, so they
took as long as the sweeps before them. On the tag's runners this layout
would have waited on `extract.ts`'s 22m53s, not on shard 3's 30m52s. What
moves the floor now is `extract.ts`'s own minutes, about half of them its 102
static mutants waiting out their clock, and that is
[ADR-0007](0007-mutation-testing.md)'s to decide, not a layout's.

*Amended again the same day.* It moved. The scans now step past an empty
match, so those 102 static mutants, and `state.ts`'s 84, fail an assertion
instead of waiting out the clock ([ADR-0007](0007-mutation-testing.md),
2026-10-01). `extract.ts` took 13.9 to 14.7 minutes in the three sweeps since
and `state.ts` 2.3 to 2.8, where they had taken 22.5 to 31.0 and 13.3 to
16.8. The layout above then put shard 3 at 19.1 minutes beside `extract.ts`'s
14.4 (run 36724681688), so the other files were balanced again, twice.
A file is slower in a shard that instruments more files, and on a slower
runner: moved from beside `state.ts` into the last shard, `glob.ts`, `yaml.ts`
and `paths.ts` took half as long again, and the first rebalance ran the last
shard to 17.3 minutes (run 36729888575). The layout, on the slower of the
first two sweeps' minutes, and as the third measured it:

| shard | files | mutants | minutes, slower of two | minutes, run 36732850656 |
| --- | --- | ---: | ---: | ---: |
| 1 | `extract.ts` | 1,283 | 14.4 | 14.7 |
| 2 | `identity.ts`, `select.ts`, `state.ts`, `paths.ts` | 1,330 | 14.4 | 12.8 |
| 3 | `resolve.ts`, `rules.ts`, `sections.ts`, `graph.ts`, `yaml.ts` | 1,811 | 14.8 | 16.3 |
| 4 | everything else the configuration mutates: `cli.ts`, `report.ts`, `lifecycle.ts`, `glob.ts`, `directives.ts`, `diff.ts`, `config.ts`, `runner.ts`, `project-rules.ts`, `baseline.ts`, `markdown.ts`, `source.ts` | 3,961 | 14.6 | 10.7 |

The third sweep drew a slow runner for shard 3 and a fast one for shard 4:
their files took four minutes more and four less between them than in the
sweep before, which is more than is left to balance. **Still four.** The files
beside `extract.ts` hold 44 minutes, and three shards put them level with it;
a fifth would take a minute or so off a slow runner's sweep, from one more
job, and a push already runs CI's ten jobs beside these.

| sweep | score | killed | timeout | survived | shards | took |
| --- | ---: | ---: | ---: | ---: | --- | ---: |
| main, 58a5389, the layout above | 96.32 | 7,825 | 259 | 293 | 29m48s, 6m39s, 31m09s, 22m43s | 31m49s |
| dispatch, 2d02aac: the scans step past, the layout above | 96.29 | 8,008 | 66 | 295 | 14m57s, 5m28s, 19m36s, 15m34s | 20m08s |
| dispatch, c6c7d00: first rebalance | 96.31 | 8,011 | 65 | 293 | 14m25s, 13m40s, 10m51s, 17m53s | 18m57s |
| dispatch, dba9ed5: this layout | 96.31 | 8,007 | 69 | 293 | 15m16s, 13m19s, 16m49s, 11m09s | 17m24s |

Five sweeps of 58a5389's source took 30m38s to 32m12s; the three since take 17
to 20 minutes. What sets the floor is still `extract.ts`, now its runtime
mutants, 10.0 to 10.5 of its minutes.

### Not splitting `extract.ts`

Stryker's `mutate` takes line ranges, and splitting `extract.ts` and
`markdown.ts` in half each would take the floor to about 21 minutes. It is not done, for two reasons.

**A range loses mutants silently.** Stryker generates a mutant only when the
node lies wholly inside a range (`locationIncluded` in its instrumenter). A
mutant spanning the split line belongs to neither shard, and no merge can see a
mutant that was never generated. A split is safe only on a top-level boundary,
and that boundary moves with every edit to the file.

**And the minutes are a defect.** `extract.ts` takes 42.5 minutes because
1,111 of its 1,247 mutants are static and each runs the whole suite. The cause
is measured: test files that analyse a corpus while they are collected, before
any test is named, make static whatever that corpus reaches - see ADR-0007. Machinery to route around that would outlive the thing it routes
around. When the static mutants are dealt with, re-measure; changing the shards
is one table and one matrix line.

### What a shard must not change

The merged sweep has to be the sweep one runner would have done. Five things
could make it something else, and each is closed:

1. **Which tests run.** Vitest's `related` option, on by default, limits the
   initial test run to test files that import a mutated file. With every file
   mutated that is the whole suite; with a quarter of them it is whatever a
   quarter reaches. It is off in `stryker.config.mjs`, so every shard runs every
   test, and perTest coverage still narrows each mutant to the tests that reach
   it. The suite Stryker runs is otherwise unchanged at 845 tests: the merge's
   own tests are excluded from it, because they reach nothing under `src/` and
   would run for every static mutant that survives.
2. **Which mutants exist.** The merge refuses a missing shard, a shard reported
   twice, a file mutated by two shards or by one it does not belong to, a listed
   file its shard did not report, and a shard that ran with patterns other than
   its own.
3. **What a verdict means.** Stryker numbers tests afresh in every run, so a test
   id means nothing outside its own report. The merge keys tests by file and
   name, refuses shards that ran different tests, and refuses names that are not
   unique within a file.
4. **The score.** Each shard runs with the break threshold off, because the
   shard holding `extract.ts` can sit under the gate while the sweep clears it.
   The merge scores the merged report with `mutation-testing-metrics`, the
   library Stryker's own gate uses, and fails an unrounded score under 70.
5. **What else is running.** Splitting the sweep changes which mutants run at
   the same moment, and a verdict that depends on that was never a verdict.
   Checking for this found that some were: tests wrote to fixed paths, and
   workers running the same test file lost each other's files. ADR-0007 has the
   count, at least 77 false kills in the 2026-09-14 sweep. Every test now writes
   to a path named for its process, which had to land first. Without it, a
   sharded sweep and an unsplit one could not be compared at all.

### Two tiers, and only a full sweep publishes

A push to `main`, a tag, the schedule and a manual dispatch run the full sweep,
and a full sweep restores no incremental file, so nothing can be carried into
it. A pull request runs incrementally, and each of its shards starts from its own
part of the file the last full sweep on `main` published (`cacheFor`): every
test, and only the files it mutates. Stryker reports the verdicts an incremental
file holds for files a run does not mutate as its own. spec-guard's first
sharded sweep did exactly that, and its merge refused it.

Only a full sweep on `main` publishes, keyed on the run. This retires the
lineage ADR-0007 spent four corrections on. An incremental file is now always
derived from the code, one full sweep ago, and never from another incremental
file. A tag's or a dispatch's entry would live on a ref no pull request can
restore, so neither publishes one.

### Verification

`tests/mutation-shards.test.ts` splits a report the way Stryker would write the
shards: ids renumbered, and tests listed in an order of their own, so a merge
that trusted an id across reports would attach the wrong tests. The merge must
reproduce every verdict, every test by name, and the metrics. Each refusal above
has a test. The tests are spec-guard's, where each of 24 defects put into the
merge one at a time made them fail.

Checked on real output before the first sharded sweep:

- **The 2026-09-14 sweep's report**, all 9,697 mutants, split into the four
  shards and merged back. Every verdict came back identical, tests matched by
  name, and so did the metrics: 76.46%, the figure that sweep printed.
- **Real Stryker runs** over `paths.ts` and `source.ts` as two shards, merged,
  against one run over both. They disagreed on 8 of 206 verdicts, and that was
  the race above, not the merge. With per-process paths, all 206 matched in
  status, static flag and covering tests, and both read 88.83%. Only `killedBy`
  differed, for 39 mutants, as spec-guard also found: with bail on it names
  whichever covering test failed first, and vitest orders test files by timings
  it caches between runs. It is not part of the score.
- **A shard started from its own part of an incremental file** reported
  `paths.ts` alone, with all 74 verdicts reused. Started from the whole file, it
  reported `source.ts` as well, and the merge refused it: "src/source.ts belongs
  to shard 2, but shard 1 reported it."

And then on hosted runners:

| sweep | score | killed | timeout | survived | shards | dispatch to score |
| --- | ---: | ---: | ---: | ---: | --- | ---: |
| dispatch, 09f16ad | 73.41 | 6,849 | 346 | 2,382 | 34m19s, 26m07s, 33m10s, 35m24s | 36m |
| pull request, 09f16ad | 73.39 | 6,849 | 344 | 2,384 | 33m47s, 32m03s, 29m29s, 28m31s | 34m |

The pull request's run found no published file, logged "shard 2 tests every
mutant", and so was a second full sweep. The two agree to 0.02 points. Each
shard's minutes moved by up to six between runners on identical work, which is
the variance the job's cap is headroom for.

Read shard by shard, the same log gives per-file minutes on hosted runners, with
the timeout check again exact where it matters (103 of 103 in `extract.ts`, 88
of 88 in `state.ts`, 57 of 57 in `markdown.ts`): `extract.ts` 34.0; `markdown.ts`
20.2 and `identity.ts` 5.6; `state.ts` 13.5 and eight small files 19.4; `rules.ts`
10.0, `lifecycle.ts` 7.1, `select.ts` 6.7 and seven more 11.3. Shard 2 is light by
eight minutes, and moving files into it would even the shards without moving the
wall time, which is still shard 1's.

**It is also the figure that corrected the ones before it.** Two sweeps of
race-free tests at 73.4%, against 76.46% the day before, is ADR-0007's race
measured at full size: about 300 kills that no assertion earned.

## Consequences

**A push to `main` costs four jobs of 26 to 36 minutes and one short one**,
where it used to cost one incremental job. On a public repository that is free,
and it buys a governing figure for every push, not every tag. With CI's seven
jobs a push runs about a dozen at once, under the twenty a free account gets.
*Amended 2026-10-01:* one of 23 to 32 minutes, `extract.ts`'s, and three of
15 to 22 beside it. *Amended again the same day:* four of 11 to 17 minutes,
with CI's ten jobs beside them.

**The sweep's figure and a pull request's figure are labelled apart** in the
job summary. The shard checks are not the gate; the score job is.

**A new source file lands in the last shard** until someone re-measures, which
`scripts/mutation-timeline.mjs` does from any sweep's log and report, one shard
at a time.

**`npm run test:mutation` is unchanged.** A developer machine runs the sweep as
one process, and its figure is still the local one ADR-0007 describes.

## Open Questions

- [x] Is a sharded sweep's figure the single runner's figure on hosted
      runners? At two files it is, exactly, once the race is gone. But the
      instrumented files around a shard change how long its tests take, and a
      timeout is a timing measurement. The answer is a sharded sweep and an
      unsplit one of the same source, both after the race fix.
      **Resolved (2026-09-14): yes.** The unsplit sweep of the race-free source
      (7094ead, one runner) read **73.39%**: 6,847 killed, 346 timeouts, 2,384
      survived. The sharded sweeps of the same tests read 73.41, 73.39 and 73.32.
      That is a spread of 0.09 points, where the racing single-runner rebuilds
      spread over 0.44. The one runner took 191m53s, longer than the 166 to 171
      it took with the races, because a false kill had let a mutant stop at the
      first failing test and a survivor runs them all. The shards did the same
      work in 34 to 36 minutes.
- [ ] When the static mutants are dealt with, how many shards? The floor is the
      largest file, and it is the static mutants that set it. *Partly answered
      (2026-09-14):* moving every analysis out of collection took them from
      5,307 to 1,405 and shards 2 to 4 to 22-24 minutes, but `extract.ts` still
      takes 30. Its remaining 448 are vocabulary tables built at import, which
      no test can attribute, so four whole-file shards remain the floor until
      someone decides those tables are worth splitting the file over.

## See also

- [ADR-0007](0007-mutation-testing.md) - the figure this computes, and the
  static mutants that set how long it takes.
