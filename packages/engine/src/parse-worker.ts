import { EXTRACTORS } from "./extractors.js";
import { extractFile, type ExtractedFile } from "./extract-file.js";
import { Parsers } from "./parse.js";

/**
 * A batch of files of one adapter for a parse worker. The worker gets bytes,
 * never a path to read: reading stays in the main thread, behind the FsReader
 * confined to the project root.
 */
export interface ParseTask {
  readonly adapterId: string;
  readonly files: readonly {
    readonly rel: string;
    readonly grammar: string;
    readonly bytes: Uint8Array;
  }[];
}

/** Grammars load on first use in each worker, each passing the startup self-test. */
const parsers = new Map<string, Promise<Parsers>>();

function parsersFor(grammar: string): Promise<Parsers> {
  let p = parsers.get(grammar);
  if (p === undefined) {
    p = Parsers.load([grammar]);
    parsers.set(grammar, p);
  }
  return p;
}

/** The piscina task: Parse and Extract each file of the batch, in order. */
export default async function parseTask(
  task: ParseTask,
): Promise<ExtractedFile[]> {
  const extract = EXTRACTORS[task.adapterId];
  if (extract === undefined) {
    throw new Error(`Unknown adapter: ${task.adapterId}`);
  }
  const out: ExtractedFile[] = [];
  for (const f of task.files) {
    out.push(
      extractFile(
        await parsersFor(f.grammar),
        extract,
        f.rel,
        f.grammar,
        f.bytes,
      ),
    );
  }
  return out;
}
