import { Menu, type MenuItemConstructorOptions } from "electron";
import type { MenuCommand } from "../shared/channels";

export interface MenuActions {
  readonly openProject: () => void;
  readonly openRecent: (folder: string) => void;
  readonly openRepository: () => void;
  /** Sends a command to the focused window's UI. */
  readonly command: (id: MenuCommand) => void;
  readonly recent: readonly string[];
  /** Adds Reload and DevTools (development builds only). */
  readonly development: boolean;
}

/**
 * The native menu bar (CLAUDE.md "App UX basics": native menus and
 * shortcuts). On macOS the menu handles the app's accelerators and sends the
 * command to the UI. Windows and Linux hide the menu bar behind the custom
 * title bar, so there the accelerators are only displayed and the UI handles
 * the keys itself (packages/ui/src/shell/commands.ts uses the same keys).
 */
export function buildMenu(actions: MenuActions): Menu {
  const mac = process.platform === "darwin";
  /** An item whose shortcut the UI handles on Windows and Linux. */
  const app = (
    label: string,
    accelerator: string,
    click: () => void,
  ): MenuItemConstructorOptions => ({
    label,
    accelerator,
    click,
    ...(mac ? {} : { registerAccelerator: false }),
  });
  const command = (label: string, accelerator: string, id: MenuCommand) =>
    app(label, accelerator, () => {
      actions.command(id);
    });

  const recent: MenuItemConstructorOptions[] =
    actions.recent.length === 0
      ? [{ label: "No Recent Projects", enabled: false }]
      : actions.recent.map((folder) => ({
          label: folder,
          click: () => {
            actions.openRecent(folder);
          },
        }));
  const template: MenuItemConstructorOptions[] = [
    ...(mac ? [{ role: "appMenu" as const }] : []),
    {
      label: "File",
      submenu: [
        app("Open Project…", "CmdOrCtrl+O", actions.openProject),
        { label: "Open Recent", submenu: recent },
        { type: "separator" },
        mac ? { role: "close" } : { role: "quit" },
      ],
    },
    { role: "editMenu" },
    {
      label: "View",
      submenu: [
        command("Command Palette…", "CmdOrCtrl+K", "palette"),
        { type: "separator" },
        command("Graph", "CmdOrCtrl+1", "view.graph"),
        command("Focus", "CmdOrCtrl+2", "view.focus"),
        command("Findings", "CmdOrCtrl+3", "view.findings"),
        command("Back", "CmdOrCtrl+[", "nav.back"),
        command("Forward", "CmdOrCtrl+]", "nav.forward"),
        { type: "separator" },
        command("Toggle Sidebar", "CmdOrCtrl+B", "panel.sidebar"),
        command("Toggle Inspector", "CmdOrCtrl+Alt+B", "panel.inspector"),
        { type: "separator" },
        { role: "resetZoom" },
        { role: "zoomIn" },
        { role: "zoomOut" },
        { type: "separator" },
        { role: "togglefullscreen" },
        ...(actions.development
          ? [
              { type: "separator" as const },
              { role: "reload" as const },
              { role: "toggleDevTools" as const },
            ]
          : []),
      ],
    },
    { role: "windowMenu" },
    {
      role: "help",
      submenu: [{ label: "Epoch on GitHub", click: actions.openRepository }],
    },
  ];
  return Menu.buildFromTemplate(template);
}
