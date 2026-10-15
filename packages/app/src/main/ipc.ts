import type { BrowserWindow, IpcMain, IpcMainInvokeEvent } from "electron";
import { z } from "zod";
import { isUiUrl } from "./policy";

/** Thrown for an invoke from an untrusted sender or with an invalid payload. */
export class IpcRejected extends Error {
  constructor(reason: string) {
    super(`IPC request rejected: ${reason}`);
    this.name = "IpcRejected";
  }
}

/** What main knows about the frame that sent an invoke. */
export interface SenderInfo {
  /** The sender is the web contents of one of Epoch's project windows. */
  readonly knownWindow: boolean;
  readonly isMainFrame: boolean;
  /** URL of the sending frame; undefined if the frame is gone. */
  readonly url: string | undefined;
}

/**
 * The checks every invoke passes before its handler runs (CLAUDE.md "Electron
 * security": validate every IPC payload with zod and verify the sender):
 * the sender is the main frame of a project window showing Epoch's own UI,
 * and the arguments match the channel's schema.
 */
export function admit<A>(
  sender: SenderInfo,
  schema: z.ZodType<A>,
  args: readonly unknown[],
  devOrigin?: string,
): A {
  if (!sender.knownWindow) throw new IpcRejected("unknown sender");
  if (!sender.isMainFrame) throw new IpcRejected("not the main frame");
  if (sender.url === undefined || !isUiUrl(sender.url, devOrigin)) {
    throw new IpcRejected("sender is not Epoch's UI");
  }
  const parsed = schema.safeParse(args);
  if (!parsed.success) {
    throw new IpcRejected(`invalid payload (${z.prettifyError(parsed.error)})`);
  }
  return parsed.data;
}

export interface Route<A extends unknown[]> {
  readonly args: z.ZodType<A>;
  readonly handle: (win: BrowserWindow, ...args: A) => Promise<unknown>;
}

/** Registers the handler for one channel. */
export type Register = <A extends unknown[]>(
  channel: string,
  route: Route<A>,
) => void;

/**
 * Returns the function that registers one ipcMain handler per channel, each
 * behind admit(). Nothing else listens, so an unknown channel gets Electron's
 * "no handler registered" rejection.
 */
export function createRouter(
  ipcMain: IpcMain,
  windowFor: (event: IpcMainInvokeEvent) => BrowserWindow | undefined,
  devOrigin: string | undefined,
): Register {
  return (channel, route) => {
    ipcMain.handle(channel, async (event, ...args: unknown[]) => {
      const win = windowFor(event);
      const frame = event.senderFrame;
      const parsed = admit(
        {
          knownWindow: win !== undefined,
          isMainFrame: frame !== null && frame === event.sender.mainFrame,
          url: frame?.url,
        },
        route.args,
        args,
        devOrigin,
      );
      if (win === undefined) throw new IpcRejected("unknown sender");
      return route.handle(win, ...parsed);
    });
  };
}
