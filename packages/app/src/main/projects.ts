import { dialog, type BrowserWindow } from "electron";
import type { ProjectInfo } from "@epoch-dev/core";
import { reportInside, type CoverageChoice } from "./coverage-report";
import type { ProjectSession } from "./project";
import type { RecentProjects } from "./recent";
import { realFolder, type GrantedRoots } from "./roots";

/**
 * Opening projects, for IPC and the native menu alike: grants, the recent
 * list and each window's session in one place.
 */
export class Projects {
  private readonly roots: GrantedRoots;
  private readonly recent: RecentProjects;
  private readonly sessionFor: (win: BrowserWindow) => ProjectSession;
  private readonly onRecentChanged: () => void;

  constructor(deps: {
    roots: GrantedRoots;
    recent: RecentProjects;
    sessionFor: (win: BrowserWindow) => ProjectSession;
    onRecentChanged: () => void;
  }) {
    this.roots = deps.roots;
    this.recent = deps.recent;
    this.sessionFor = deps.sessionFor;
    this.onRecentChanged = deps.onRecentChanged;
  }

  /** Starts analyzing a folder already checked against the granted roots. */
  private open(win: BrowserWindow, real: string): ProjectInfo {
    const info = this.sessionFor(win).open(real);
    this.recent.add(real);
    this.onRecentChanged();
    win.setTitle(`${info.name} — Epoch`);
    return info;
  }

  /** A folder the user granted before (the recent list). */
  openGranted(win: BrowserWindow, folder: string): ProjectInfo {
    return this.open(win, this.roots.resolve(folder));
  }

  /** A folder from a real drop: the drop grants it. */
  openDropped(win: BrowserWindow, folder: string): ProjectInfo {
    return this.open(win, this.roots.grant(folder));
  }

  /** The native folder dialog; choosing a folder grants it. Null if cancelled. */
  async choose(win: BrowserWindow): Promise<ProjectInfo | null> {
    const choice = await dialog.showOpenDialog(win, {
      title: "Open Project",
      properties: ["openDirectory"],
    });
    const [folder] = choice.filePaths;
    if (choice.canceled || folder === undefined) return null;
    return this.open(win, this.roots.grant(folder));
  }

  /**
   * Main's file dialog for the window's project coverage report (ADR-020).
   * Only a file inside the project is kept; the renderer never sends a path.
   */
  async chooseCoverageReport(win: BrowserWindow): Promise<CoverageChoice> {
    const session = this.sessionFor(win);
    const root = session.root();
    if (root === undefined) throw new Error("No project is open.");
    const choice = await dialog.showOpenDialog(win, {
      title: "Choose a Coverage Report",
      defaultPath: root,
      properties: ["openFile"],
      filters: [
        {
          name: "Coverage reports",
          extensions: ["info", "lcov", "json", "xml", "out"],
        },
        { name: "All files", extensions: ["*"] },
      ],
    });
    const [file] = choice.filePaths;
    if (choice.canceled || file === undefined) return { state: "canceled" };
    const report = reportInside(root, file);
    if (report === undefined) return { state: "outside-project" };
    await session.setCoverageReport(report);
    return { state: "chosen", path: report };
  }

  /** Forgets the window's chosen report and looks for reports again. */
  clearCoverageReport(win: BrowserWindow): Promise<void> {
    return this.sessionFor(win).setCoverageReport(undefined);
  }

  /** Recent projects that still exist as the same real folders. */
  recentProjects(): string[] {
    return this.recent.projects.filter((p) => {
      try {
        return realFolder(p) === p;
      } catch {
        return false;
      }
    });
  }
}
