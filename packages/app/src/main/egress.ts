import { session, type Session } from "electron";
import { createNet, type Net } from "@epoch-dev/scorers/net";
import { OLLAMA_ORIGIN, SUMMARY_ORIGINS } from "@epoch-dev/scorers/origins";
import { egressAllows } from "./egress-policy";

/*
 * Main's one way out (ADR-016): every model request goes through the network
 * wrapper (origin allowlist, offline read at each request, abort of what is
 * in flight) and then an Electron session of its own, which no window uses
 * and whose request filter refuses anything else. Loaded only when a model
 * feature first sends (a lazy chunk).
 *
 * Proven by a spike (M7 step 13): the Anthropic SDK runs unchanged on this
 * session's fetch (headers, body, abort), the filter runs before any
 * protocol handler, and a refused origin fails with ERR_BLOCKED_BY_CLIENT.
 */

export const EGRESS_PARTITION = "epoch-egress";

export interface Egress {
  readonly net: Net;
  readonly session: Session;
}

export function createEgress(offline: () => boolean): Egress {
  const egress = session.fromPartition(EGRESS_PARTITION, { cache: false });
  egress.webRequest.onBeforeRequest((details, callback) => {
    callback({ cancel: !egressAllows(details.url, offline()) });
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
  return { net, session: egress };
}
