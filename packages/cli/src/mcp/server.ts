import { McpServer } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import type { z } from "zod";
import manifest from "../../package.json" with { type: "json" };
import { openSession, type AgentSession } from "./session.js";
import { INSTRUCTIONS, TOOLS, ToolError, type ToolContext } from "./tools.js";

/*
 * `epoch mcp`: the agent server (ADR-021). MCP over stdio and nothing else:
 * no port, no HTTP. stdout is the protocol channel, so everything Epoch has
 * to say goes to stderr. The tools only read; the project is never written.
 */

/** A tool as the server registers it; the SDK validates `args` against `input` first. */
interface Spec {
  readonly name: string;
  readonly title: string;
  readonly description: string;
  readonly input: z.ZodObject;
  readonly run: (ctx: ToolContext, args: never) => unknown;
}

const text = (value: string, isError = false) => ({
  content: [{ type: "text" as const, text: value }],
  ...(isError ? { isError: true } : {}),
});

function register(server: McpServer, session: AgentSession, spec: Spec): void {
  server.registerTool(
    spec.name,
    {
      title: spec.title,
      description: spec.description,
      inputSchema: spec.input,
      annotations: {
        readOnlyHint: true,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async (args) => {
      try {
        // Compact JSON: an agent pays for every character.
        return text(
          JSON.stringify(spec.run(await session.context(), args as never)),
        );
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return text(
          err instanceof ToolError
            ? message
            : `Epoch could not answer: ${message}`,
          true,
        );
      }
    },
  );
}

export function createServer(session: AgentSession): McpServer {
  const server = new McpServer(
    { name: "epoch", version: manifest.version },
    { instructions: INSTRUCTIONS },
  );
  for (const spec of TOOLS) register(server, session, spec);
  return server;
}

/** Serves `target` to one agent over this process's stdio until it hangs up. */
export async function serveAgent(
  target: string,
  log: (line: string) => void,
): Promise<void> {
  const session = openSession(target, log);
  const handle = serveStdio(() => createServer(session), {
    onerror: (err) => {
      log(`epoch: ${err.message}\n`);
    },
  });
  await new Promise<void>((resolve) => {
    const done = () => {
      resolve();
    };
    // The agent closes our stdin when it is finished with us.
    process.stdin.once("end", done);
    process.stdin.once("close", done);
    process.once("SIGINT", done);
    process.once("SIGTERM", done);
  });
  await handle.close();
  await session.close();
}
