import path from "node:path";
import { FsReader, toPosix, type HintOptions } from "@epoch-dev/engine";
import {
  ModelScorer,
  resolveModel,
  runSummary,
  type ScorerValues,
} from "@epoch-dev/scorers";

/*
 * --scorer for `epoch analyze` and `epoch findings` (options and rules in
 * @epoch-dev/scorers' options.ts). A model scorer reads file excerpts
 * through the engine's root-confined reader and prints its plan, and what
 * it spent, on stderr.
 */

export interface ChosenScorer {
  readonly hints?: HintOptions["scorer"];
  /** One line on what the model scorer did, after the run. */
  readonly summary: () => string | undefined;
}

export function chooseScorer(
  values: ScorerValues,
  target: string,
  stderr: { write(chunk: string): unknown },
  env: NodeJS.ProcessEnv = process.env,
): ChosenScorer {
  const model = resolveModel(values, env);
  if (!model) return { summary: () => undefined };
  const root = toPosix(path.resolve(target));
  const reader = new FsReader(root);
  const scorer = new ModelScorer({
    backend: model.backend,
    readText: (rel) => reader.readFile(`${root}/${rel}`),
    consent: model.consent,
    maxPairs: model.maxPairs,
    ...(model.spend ? { spend: model.spend } : {}),
    onPlan: (text) => {
      stderr.write(text);
    },
  });
  return {
    hints: {
      id: model.backend.id,
      scorer,
      byModel: true,
      prepare: (context) => {
        scorer.prepare(context);
      },
    },
    summary: () => runSummary(model.backend, scorer.report(), model.spend),
  };
}
