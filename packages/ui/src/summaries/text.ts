import type {
  SummaryApprovalReason,
  SummaryFailureReason,
  SummaryJobPlan,
  SummaryUnavailableReason,
} from "@epoch-dev/core";

/* Words for the Summary section; main sends codes, never provider text. */

export const UNAVAILABLE_TEXT: Readonly<
  Record<SummaryUnavailableReason, string>
> = {
  disabled: "Summaries are off.",
  offline: "Offline mode is on.",
  "no-key": "Add a key for the chosen provider in Settings.",
  "no-price": "Enter this model's prices in Settings.",
  "no-cap": "Set a monthly spending cap in Settings.",
  "cap-reached": "This month's spending cap is reached.",
  "session-budget": "This session's budget is spent.",
  "no-local-model": "Choose an Ollama model in Settings.",
  secret: "Never sent: this file looks like it holds secrets.",
  "not-in-graph": "Not part of the analyzed project.",
  unreadable: "This file can't be read.",
  empty: "This file is empty.",
  "no-project": "No project is open.",
  busy: "Another summary is being made.",
  "not-supported": "Nothing to summarize here yet.",
};

export const FAILED_TEXT: Readonly<Record<SummaryFailureReason, string>> = {
  auth: "The provider refused the key.",
  "rate-limited": "Rate limited by the provider; try again later.",
  unreachable: "Couldn't reach the provider.",
  server: "The provider had an error.",
  "bad-request": "The provider rejected the request.",
  "key-needs-workspace":
    "This key isn't in a workspace. Create one inside a workspace in the Claude Console, then save it in Settings.",
  "no-model": "That model isn't available.",
  refusal: "The model declined to summarize this.",
  "cut-off": "The answer was cut off; nothing was kept.",
  "nothing-kept": "The answer was all code; nothing was kept.",
  cancelled: "Cancelled; what was done is kept.",
  "plan-changed": "The files changed; ask again.",
  expired: "That request expired; ask again.",
};

export const APPROVAL_TEXT: Readonly<Record<SummaryApprovalReason, string>> = {
  consent:
    "The first summary in this project from this provider: Epoch asks before sending anything.",
  "over-threshold": "Estimated above your ask-first amount.",
  "folder-job":
    "A folder is summarized from its files and subfolders, bottom-up.",
  requested: "",
};

const SETTINGS_REASONS = new Set<SummaryUnavailableReason>([
  "disabled",
  "offline",
  "no-key",
  "no-price",
  "no-cap",
  "cap-reached",
  "session-budget",
  "no-local-model",
]);

/** Whether Settings is where the user fixes this. */
export const needsSettings = (reason: SummaryUnavailableReason): boolean =>
  SETTINGS_REASONS.has(reason);

export const staleText = (why: "file" | "dependencies"): string =>
  why === "file"
    ? "Out of date: the file changed since."
    : "Files it imports were summarized again since.";

const plural = (n: number, one: string, many = `${one}s`) =>
  `${String(n)} ${n === 1 ? one : many}`;

/** What approving a plan sends, where, and the most it can cost. */
export function planText(plan: SummaryJobPlan): { what: string; cost: string } {
  const files = plan.sends.length + plan.sendsMore;
  const parts: string[] = [];
  if (plan.requests > 1)
    parts.push(`${plural(plan.requests, "summary", "summaries")}.`);
  parts.push(
    plan.remote
      ? `Sends ${plural(files, "file")} to ${plan.destination} (${plan.model}) with your key.`
      : `Runs on this machine (${plan.model}); nothing leaves it.`,
  );
  if (plan.excluded.length > 0)
    parts.push(`Never sent: ${plan.excluded.join(", ")}.`);
  const usd = plan.estimate.worstCaseUsd;
  return {
    what: parts.join(" "),
    cost: plan.remote
      ? `At most $${usd < 0.01 ? usd.toFixed(4) : usd.toFixed(2)} at your prices.`
      : "Free.",
  };
}
