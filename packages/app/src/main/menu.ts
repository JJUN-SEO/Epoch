import { Menu, type MenuItemConstructorOptions } from "electron";

export interface MenuActions {
  readonly openProject: () => void;
  readonly openRecent: (folder: string) => void;
  readonly openRepository: () => void;
  readonly recent: readonly string[];
  /** Adds Reload and DevTools (development builds only). */
  readonly development: boolean;
}

/** The native menu bar (CLAUDE.md "App UX basics": native menus and shortcuts). */
export function buildMenu(actions: MenuActions): Menu {
  const mac = process.platform === "darwin";
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
        {
          label: "Open Project…",
          accelerator: "CmdOrCtrl+O",
          click: actions.openProject,
        },
        { label: "Open Recent", submenu: recent },
        { type: "separator" },
        mac ? { role: "close" } : { role: "quit" },
      ],
    },
    { role: "editMenu" },
    {
      label: "View",
      submenu: [
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
