import { session, type Session } from "electron";
import { z } from "zod";
import { createNet, type Net } from "@epoch-dev/scorers/net";
import { OLLAMA_ORIGIN, SUMMARY_ORIGINS } from "@epoch-dev/scorers/origins";
import { egressAllows } from "./egress-policy";
import { LATEST_RELEASE_URL, RELEASES_API_ORIGIN } from "./release";

/*
 * Main's one way out (ADR-016): every model request, and the update check's
 * one request (ADR-018), goes through a network wrapper (origin allowlist,
 * offline read at each request, abort of what is in flight) and then an
 * Electron session of its own, which no window uses and whose request filter
 * refuses anything else. Loaded only when something first sends (a lazy
 * chunk).
 *
 * Proven by a spike (M7 step 13): the Anthropic SDK runs unchanged on this
 * session's fetch (headers, body, abort), the filter runs before any
 * protocol handler, and a refused origin fails with ERR_BLOCKED_BY_CLIENT.
 */

export const EGRESS_PARTITION = "epoch-egress";

export interface Egress {
  readonly net: Net;
  readonly session: Session;
  /** The latest release's tag name (ADR-018); rejects on any failure. */
  readonly latestReleaseTag: () => Promise<string>;
  /** Aborts the update check's request, if one is in flight. */
  readonly abortUpdateCheck: () => void;
}

/** The latest release's answer is a few kilobytes; refuse anything huge. */
const MAX_RELEASE_BYTES = 1_000_000;

const LatestRelease = z.object({ tag_name: z.string().max(64) });

/**
 * The update check's request (GitHub's REST docs, read 2026-10-18: "Get the
 * latest release", API versions, and "All API requests must include a valid
 * User-Agent header"). Fixed headers only: no version, no identifier, and a
 * fixed language instead of the user's (Chromium would send its own). No
 * cookies, no redirects (the renamed repository's old path redirects).
 */
const RELEASE_REQUEST: RequestInit = {
  method: "GET",
  headers: {
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2026-03-10",
    "User-Agent": "Epoch",
    "Accept-Language": "en",
  },
  credentials: "omit",
  redirect: "error",
  cache: "no-store",
};

export function createEgress(offline: () => boolean): Egress {
  const egress = session.fromPartition(EGRESS_PARTITION, { cache: false });
  // As for the window's session (harden.ts): Chromium's spellchecker would
  // fetch a dictionary from Google for every new session.
  egress.setSpellCheckerEnabled(false);
  egress.setSpellCheckerLanguages([]);
  egress.webRequest.onBeforeRequest((details, callback) => {
    callback({
      cancel: !egressAllows(details.url, offline(), details.method),
    });
  });
  egress.setPermissionRequestHandler((_contents, _permission, callback) => {
    callback(false);
  });
  const net = createNet({
    offline,
    allow: Object.values(SUMMARY_ORIGINS),
    offlineAllow: [OLLAMA_ORIGIN],
    fetch: (input, init) =>
      egress.fetch(input instanceof URL ? input.href : input, init),
  });
  const updates = createNet({
    offline,
    allow: [RELEASES_API_ORIGIN],
    fetch: (input, init) =>
      egress.fetch(input instanceof URL ? input.href : input, init),
  });
  return {
    net,
    session: egress,
    async latestReleaseTag() {
      const res = await updates.fetch(LATEST_RELEASE_URL, RELEASE_REQUEST);
      if (res.status !== 200)
        throw new Error(`the release host answered ${String(res.status)}`);
      const text = await res.text();
      if (text.length > MAX_RELEASE_BYTES)
        throw new Error("the release host's answer is too large");
      return LatestRelease.parse(JSON.parse(text)).tag_name;
    },
    abortUpdateCheck: () => {
      updates.abortInFlight();
    },
  };
}
