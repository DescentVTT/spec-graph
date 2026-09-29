# Security

## Supported versions

| Version | Fixed |
| --- | --- |
| The latest minor release on npm (`npm view @descent-vtt/spec-graph version`) | yes, in a patch release of it |
| Any older minor | no |

A fix ships as a patch release of the latest minor, which under the spec-*
tools' [versions policy](https://github.com/DescentVTT/spec-core/blob/main/docs/adr/0009-versions-before-1-0.md)
cannot turn a passing run red. Older minors get no fixes: to take one, upgrade
to the latest minor.

## Reporting a vulnerability

Report it privately, through GitHub: open the repository's **Security** tab
and choose **Report a vulnerability**. Say which version you ran and include
the smallest input that shows the problem - a Markdown file, a pattern or a
configuration.

Do not open a public issue, pull request or discussion for a vulnerability.
That publishes it before there is a fix.

## What happens next

1. The report is acknowledged.
2. The fix is released as a patch of the latest minor, with a GitHub security
   advisory that describes it.
3. You are credited in the advisory and the changelog, if you want to be.
