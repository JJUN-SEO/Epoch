import type { BlastRadiusResult } from "@epoch-dev/core";
import { PathLabel, SectionTitle, Segmented, Toggle } from "./ui";

/** Affected files listed per depth before "and N more". */
const LIST_LIMIT = 200;

const plural = (n: number, one: string, many = `${one}s`) =>
  `${String(n)} ${n === 1 ? one : many}`;

/** "12 files", or "3 packages · 9 files" when Go packages are involved (ADR-013). */
export function affectedLabel(r: BlastRadiusResult): string {
  return r.byKind.package > 0
    ? `${plural(r.byKind.package, "package")} · ${plural(r.byKind.file, "file")}`
    : plural(r.byKind.file, "file");
}

export interface ImpactSettings {
  /** certain: fact edges; likely: plus hint edges at or above the hint threshold. */
  readonly mode: "certain" | "likely";
  readonly includeTypeOnly: boolean;
  /** Hops to follow; undefined for all. */
  readonly maxDepth: number | undefined;
}

/**
 * Blast radius of the selection (CLAUDE.md "Blast radius"): what transitively
 * depends on it, by depth, directory and language. Certain mode follows fact
 * edges only; Likely mode adds hint edges at or above the hint threshold
 * (the toolbar's slider), and marks what only they reach.
 */
export function ImpactPanel(props: {
  readonly selected: string | undefined;
  /** The full radius (every depth), for the depth control. */
  readonly full: BlastRadiusResult | undefined;
  /** The radius at the chosen depth. */
  readonly result: BlastRadiusResult | undefined;
  readonly settings: ImpactSettings;
  readonly onSettings: (s: ImpactSettings) => void;
  /** Likely mode follows hint edges at or above this confidence. */
  readonly hintThreshold: number;
  /** Hint edges in this analysis; Likely mode needs some. */
  readonly hintCount: number;
  readonly shown: boolean;
  readonly onShown: (shown: boolean) => void;
  readonly onShow: (id: string) => void;
}) {
  const { result, full, settings } = props;
  if (props.selected === undefined || !result || !full) {
    return (
      <p className="text-muted px-4 py-6 text-center text-[13px]">
        Select a file to see what depends on it, directly or through other
        files: its blast radius.
      </p>
    );
  }
  const depths = Array.from({ length: full.maxDepth }, (_, i) => i + 1);
  const byDepth = new Map<number, { id: string; viaHint: boolean }[]>();
  for (const a of result.affected) {
    byDepth.set(a.depth, [
      ...(byDepth.get(a.depth) ?? []),
      { id: a.id, viaHint: a.viaHint },
    ]);
  }
  const likely = settings.mode === "likely" && props.hintCount > 0;
  const dirs = Object.entries(result.byDirectory)
    .sort(([a, x], [b, y]) => y - x || (a < b ? -1 : 1))
    .slice(0, 10);
  const languages = Object.entries(result.byLanguage).sort(
    ([a, x], [b, y]) => y - x || (a < b ? -1 : 1),
  );
  return (
    <div data-testid="impact" className="pb-4">
      <header className="border-line border-b px-3 pt-3 pb-3">
        <p className="text-muted text-xs">Changing</p>
        <h2 className="selectable text-[14px] leading-snug font-semibold">
          <PathLabel id={props.selected} />
        </h2>
        <p className="mt-2 text-[13px]">
          can affect{" "}
          <strong data-testid="impact-total" className="text-[15px]">
            {affectedLabel(result)}
          </strong>
          {result.total > 0 && (
            <span className="text-muted">
              , up to {plural(result.maxDepth, "level")} away
            </span>
          )}
        </p>
        {likely && (
          <p data-testid="impact-via-hints" className="text-muted mt-1 text-xs">
            {result.viaHints === 0
              ? `No more through likely relations at or above ${props.hintThreshold.toFixed(2)}.`
              : `${String(result.viaHints)} reached only through likely relations (confidence ${props.hintThreshold.toFixed(2)} or more), marked "likely".`}
          </p>
        )}
      </header>
      <div className="flex flex-col gap-2 px-3 pt-3">
        <div className="flex flex-wrap items-center gap-2">
          <Segmented
            label="Mode"
            options={[
              {
                value: "certain",
                label: "Certain",
                title: "Imports the resolver proved",
              },
              {
                value: "likely",
                label: "Likely",
                disabled: props.hintCount === 0,
                title:
                  props.hintCount === 0
                    ? "No likely relations in this analysis (they come from git co-change and shared strings)"
                    : `Also follows likely relations (co-change, shared strings) at or above ${props.hintThreshold.toFixed(2)}; set the threshold with the Hints slider`,
              },
            ]}
            value={props.hintCount === 0 ? "certain" : settings.mode}
            onChange={(mode) => {
              props.onSettings({ ...settings, mode });
            }}
          />
          <label className="text-muted inline-flex items-center gap-1.5 text-[12px]">
            Depth
            <select
              aria-label="Depth"
              className="bg-sunken border-line rounded-md border px-1.5 py-0.5 text-[12px]"
              value={
                settings.maxDepth === undefined
                  ? "all"
                  : String(settings.maxDepth)
              }
              onChange={(e) => {
                const v = e.currentTarget.value;
                props.onSettings({
                  ...settings,
                  maxDepth: v === "all" ? undefined : Number(v),
                });
              }}
            >
              <option value="all">All</option>
              {depths.map((d) => (
                <option key={d} value={String(d)}>
                  {d}
                </option>
              ))}
            </select>
          </label>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Toggle
            label="Type-only imports"
            title="Follow imports of types only (on by default)"
            checked={settings.includeTypeOnly}
            onChange={(on) => {
              props.onSettings({ ...settings, includeTypeOnly: on });
            }}
          />
          <Toggle
            label="Show on graph"
            title="Color the affected files on the graph by distance"
            checked={props.shown}
            onChange={props.onShown}
          />
        </div>
      </div>
      {dirs.length > 0 && (
        <section>
          <SectionTitle>By folder</SectionTitle>
          <dl className="px-3 text-[12px]">
            {dirs.map(([dir, n]) => (
              <div key={dir} className="flex justify-between gap-3 py-0.5">
                <dt className="selectable truncate">
                  {dir === "." ? "(root)" : dir}
                </dt>
                <dd className="text-muted tabular-nums">{n}</dd>
              </div>
            ))}
          </dl>
        </section>
      )}
      {languages.length > 1 && (
        <section>
          <SectionTitle>By language</SectionTitle>
          <dl className="px-3 text-[12px]">
            {languages.map(([language, n]) => (
              <div key={language} className="flex justify-between gap-3 py-0.5">
                <dt>{language}</dt>
                <dd className="text-muted tabular-nums">{n}</dd>
              </div>
            ))}
          </dl>
        </section>
      )}
      {[...byDepth.entries()].map(([depth, ids]) => (
        <section key={depth}>
          <SectionTitle>
            {depth === 1 ? "Direct dependents" : `${String(depth)} levels away`}{" "}
            ({ids.length})
          </SectionTitle>
          <ul className="px-1.5">
            {ids.slice(0, LIST_LIMIT).map(({ id, viaHint }) => (
              <li key={id}>
                <button
                  type="button"
                  className="hover:bg-hover flex w-full items-center gap-1.5 rounded-md px-1.5 py-0.5 text-left text-[13px]"
                  onClick={() => {
                    props.onShow(id);
                  }}
                >
                  <span className="min-w-0 flex-1">
                    <PathLabel id={id} />
                  </span>
                  {viaHint && (
                    <span
                      className="text-muted border-strong-line shrink-0 rounded border border-dashed px-1 text-[11px]"
                      title="Reached only through a likely relation, not a proven import"
                    >
                      likely
                    </span>
                  )}
                </button>
              </li>
            ))}
          </ul>
          {ids.length > LIST_LIMIT && (
            <p className="text-muted px-3 text-xs">
              and {ids.length - LIST_LIMIT} more
            </p>
          )}
        </section>
      ))}
    </div>
  );
}
