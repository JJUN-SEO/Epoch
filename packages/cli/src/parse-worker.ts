import { installTripwire } from "@epoch-dev/scorers/tripwire";

// A parse worker for the CLI's ParsePool, as its own entry so the worker
// loads from a known path in the build tree and in the npm bundle alike
// (ADR-018). Parsing never uses the network: the tripwire refuses any attempt.
installTripwire();

export { default } from "@epoch-dev/engine/parse-worker";
