import fs from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { serializeCanonical, type Progress } from "@epoch-dev/core";
import { analyze } from "@epoch-dev/engine";
import { formatSummary } from "./summary.js";

/** Where the CLI writes; the real bin passes process.stdout and process.stderr. */
export interface CliIo {
  readonly stdout: { write(chunk: string): unknown };
  readonly stderr: { write(chunk: string): unknown; isTTY?: boolean };
}

export const EXIT_OK = 0;
export const EXIT_ERROR = 1;

export const USAGE = `Usage:
  epoch analyze <path> [--json]

Commands:
  analyze <path>   Build the dependency graph of a project folder (read-only)

Options:
  --json           Print the canonical graph as JSON on stdout
  -h, --help       Show this help
`;

class UsageError extends Error {}

/** Our own usage errors and node:util parseArgs rejections (unknown option, extra positional). */
function isUsageError(err: unknown): boolean {
  if (err instanceof UsageError) return true;
  const code =
    typeof err === "object" && err !== null && "code" in err
      ? err.code
      : undefined;
  return typeof code === "string" && code.startsWith("ERR_PARSE_ARGS_");
}

function progressReporter(stderr: CliIo["stderr"]): (p: Progress) => void {
  let lastStage: Progress["stage"] | undefined;
  return (p) => {
    if (p.stage === "done") {
      if (stderr.isTTY) stderr.write("\r\x1b[K");
      return;
    }
    if (stderr.isTTY) {
      stderr.write(`\r\x1b[K${p.stage} ${String(p.done)}/${String(p.total)}`);
    } else if (p.stage !== lastStage) {
      stderr.write(`${p.stage}...\n`);
    }
    lastStage = p.stage;
  };
}

async function analyzeCommand(
  args: readonly string[],
  io: CliIo,
): Promise<number> {
  const { values, positionals } = parseArgs({
    args: [...args],
    options: { json: { type: "boolean", default: false } },
    allowPositionals: true,
    strict: true,
  });
  if (positionals.length !== 1 || positionals[0] === undefined) {
    throw new UsageError("analyze needs exactly one <path>");
  }
  const target = path.resolve(positionals[0]);
  let isDir = false;
  try {
    isDir = fs.statSync(target).isDirectory();
  } catch {
    // reported below
  }
  if (!isDir) throw new Error(`not a directory: ${positionals[0]}`);

  const { graph, meta } = await analyze(target, {
    onProgress: progressReporter(io.stderr),
  });
  if (values.json) {
    // stdout carries only the canonical, schema-validated Graph.
    io.stdout.write(serializeCanonical(graph));
    io.stderr.write(formatSummary(graph, meta));
  } else {
    io.stdout.write(formatSummary(graph, meta));
  }
  return EXIT_OK;
}

/**
 * The `epoch` command line. Returns the exit code instead of exiting, so it
 * can be tested in-process. Progress, warnings and errors go to stderr;
 * with --json, stdout holds nothing but the graph.
 */
export async function run(argv: readonly string[], io: CliIo): Promise<number> {
  const [command, ...rest] = argv;
  try {
    if (command === "-h" || command === "--help" || command === "help") {
      io.stdout.write(USAGE);
      return EXIT_OK;
    }
    if (command === "analyze") return await analyzeCommand(rest, io);
    throw new UsageError(
      command === undefined ? "missing command" : `unknown command: ${command}`,
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    io.stderr.write(`epoch: ${message}\n`);
    if (isUsageError(err)) io.stderr.write(`\n${USAGE}`);
    return EXIT_ERROR;
  }
}
