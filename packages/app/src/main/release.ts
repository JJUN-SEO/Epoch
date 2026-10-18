import { parseVersion } from "./version";

/**
 * Where Epoch is published: its GitHub repository (renamed from
 * JJUN-SEO/under-construction-; GitHub redirects the old name, but links and
 * requests use the current one).
 */
export const REPOSITORY = "JJUN-SEO/Epoch";

/** The repository's page, opened from Help. */
export const REPOSITORY_URL = `https://github.com/${REPOSITORY}`;

/** The release host's API, which the update check asks (ADR-018). */
export const RELEASES_API_ORIGIN = "https://api.github.com";

/**
 * GitHub's "Get the latest release": the newest release that is neither a
 * draft nor a pre-release (docs.github.com/en/rest/releases/releases, read
 * 2026-10-18). The only URL the update check requests.
 */
export const LATEST_RELEASE_URL = `${RELEASES_API_ORIGIN}/repos/${REPOSITORY}/releases/latest`;

/**
 * The page of the release tagged `tag`, built here and never taken from the
 * release host's answer; undefined unless `tag` is a release version.
 */
export function releasePageUrl(tag: string): string | undefined {
  if (!parseVersion(tag)) return undefined;
  return `${REPOSITORY_URL}/releases/tag/${tag}`;
}
