// Types for the tests that import scripts/release.mjs.

export interface Release {
  version: string;
  /** `latest`, or `next` for a prerelease, which must never become the default install. */
  distTag: string;
  notes: string;
}

/** The release the tag describes, or the sentence explaining why it describes none. */
export declare function releaseOf(tag: string, version: string, changelog: string): Release | string;

/**
 * The text under the `## <version>` heading, up to the next heading of that
 * level or above, or null where there is no such section or it is empty.
 */
export declare function changelogSection(changelog: string, version: string): string | null;
