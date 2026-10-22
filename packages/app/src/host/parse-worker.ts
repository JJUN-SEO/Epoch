import { installTripwire } from "@epoch-dev/scorers/tripwire";

// A parse worker for the host's ParsePool, bundled as its own entry so the
// worker loads from a known path inside the app (see electron.vite.config.ts).
// Like the host, it never uses the network: the tripwire refuses any attempt.
installTripwire();

export { default } from "@epoch-dev/engine/parse-worker";
