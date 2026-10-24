import { useState } from "react";
import type { AnalysisInfo } from "@epoch-dev/core";
import type { CoverageChoice } from "../bridge";
import { Button } from "../components/ui";
import { COVERAGE_COMMANDS, coverageLines } from "./coverage";
import { Popover } from "./Popover";

/** The desktop app's coverage actions (main's file dialog, ADR-020). */
export interface CoverageActions {
  readonly choose: () => Promise<CoverageChoice>;
  readonly clear: () => Promise<void>;
}

/**
 * What the analysis read for test coverage, the commands that write a
 * report, and choosing a report by hand. Epoch never runs the commands.
 */
export function CoveragePanel(props: {
  readonly coverage: AnalysisInfo["coverage"];
  readonly actions: CoverageActions;
  readonly onClose: () => void;
}) {
  const { coverage, actions } = props;
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | undefined>();
  const act = (run: () => Promise<string | undefined>) => {
    setBusy(true);
    setNote(undefined);
    run()
      .then(setNote)
      .catch((err: unknown) => {
        setNote(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        setBusy(false);
      });
  };
  return (
    <Popover
      role="dialog"
      label="Test coverage"
      className="bottom-7 left-0 w-[28rem] p-3 text-[12px] whitespace-normal"
      onClose={props.onClose}
    >
      <h2 className="text-fg mb-1 text-[13px] font-semibold">Test coverage</h2>
      <ul data-testid="coverage-reports" className="text-fg mb-1 space-y-0.5">
        {coverageLines(coverage).map((line) => (
          <li key={line} className="selectable break-words">
            {line}
          </li>
        ))}
      </ul>
      {coverage.chosen !== undefined && (
        <p className="mb-1">Chosen by you; Epoch is not looking for others.</p>
      )}
      <p className="mt-2 mb-1.5">
        Epoch never runs your tests. Run your test runner with coverage, and
        Epoch reads the report as soon as it is written, in the project folder
        or a package folder:
      </p>
      <table className="mb-1.5 w-full">
        <tbody>
          {COVERAGE_COMMANDS.map(({ tool, command }) => (
            <tr key={tool}>
              <td className="py-0.5 pr-3 align-top whitespace-nowrap">
                {tool}
              </td>
              <td className="py-0.5">
                <code className="selectable bg-sunken text-fg rounded px-1 font-mono text-[11px] break-all">
                  {command}
                </code>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="mb-3">
        Formats read: lcov, Cobertura and Clover XML, Istanbul JSON and Go
        profiles. For coverage.py, run{" "}
        <code className="font-mono">coverage xml</code> or{" "}
        <code className="font-mono">coverage lcov</code>: Epoch does not read
        its .coverage database.
      </p>
      <div className="flex items-center gap-2">
        <Button
          disabled={busy}
          onClick={() => {
            act(async () => {
              const choice = await actions.choose();
              return choice.state === "outside-project"
                ? "Choose a report inside the project folder."
                : undefined;
            });
          }}
        >
          Choose report…
        </Button>
        {coverage.chosen !== undefined && (
          <Button
            variant="ghost"
            disabled={busy}
            onClick={() => {
              act(async () => {
                await actions.clear();
                return undefined;
              });
            }}
          >
            Look for reports again
          </Button>
        )}
        {busy && <span>Analyzing…</span>}
      </div>
      {note !== undefined && (
        <p role="status" className="text-danger mt-2">
          {note}
        </p>
      )}
    </Popover>
  );
}
