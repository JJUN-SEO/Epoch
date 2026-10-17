import { X } from "lucide-react";
import { useCallback, useEffect, useState, type ReactNode } from "react";
import {
  SHIPPED_PRICES,
  SHIPPED_PRICES_SOURCE,
  applySettingsPatch,
  priceOf,
  type EpochApi,
  type KeyStatus,
  type Settings,
  type SettingsPatch,
  type SpendStatus,
} from "@epoch-dev/core";
import type { Shell } from "../api";
import type { CacheSummary } from "../bridge";
import { Button, IconButton, Segmented, Toggle } from "../components/ui";
import { errorMessage } from "../errors";
import { bytes, keyStatusText, parseUsd, usd } from "./model";

/*
 * Settings (M7, ADR-016): privacy, model features, keys, prices, spending
 * and the cache. Every change goes to main, which validates it; one that
 * lets Epoch spend more is confirmed there, in a native dialog. A key is
 * sent once and the field is cleared; only its status comes back.
 */

function Section(props: {
  readonly title: string;
  readonly children: ReactNode;
}) {
  return (
    <section
      aria-label={props.title}
      className="border-line flex flex-col gap-2 border-b px-5 py-4 last:border-b-0"
    >
      <h3 className="text-muted text-[11px] font-semibold tracking-wide uppercase">
        {props.title}
      </h3>
      {props.children}
    </section>
  );
}

function Row(props: {
  readonly label: string;
  readonly hint?: ReactNode;
  readonly children: ReactNode;
}) {
  return (
    <div className="flex items-start justify-between gap-4">
      <div className="min-w-0 flex-1">
        <div className="text-[13px] font-medium">{props.label}</div>
        {props.hint !== undefined && (
          <div className="text-muted text-xs">{props.hint}</div>
        )}
      </div>
      <div className="flex shrink-0 items-center gap-1.5">{props.children}</div>
    </div>
  );
}

const fieldClass =
  "border-line bg-canvas focus:border-accent h-7 rounded-md border px-2 text-[13px] outline-none";

/** A text field that commits on Enter or when it loses focus. */
function CommitField(props: {
  readonly label: string;
  readonly value: string;
  readonly onCommit: (value: string) => void;
  readonly placeholder?: string;
  readonly width?: string;
}) {
  const [text, setText] = useState(props.value);
  useEffect(() => {
    setText(props.value);
  }, [props.value]);
  const commit = () => {
    if (text.trim() !== props.value) props.onCommit(text.trim());
  };
  return (
    <input
      type="text"
      aria-label={props.label}
      spellCheck={false}
      placeholder={props.placeholder}
      className={`${fieldClass} ${props.width ?? "w-44"}`}
      value={text}
      onChange={(e) => {
        setText(e.target.value);
      }}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === "Enter") commit();
      }}
    />
  );
}

export interface SettingsDialogProps {
  readonly api: EpochApi;
  readonly shell: Shell;
  readonly onClose: () => void;
}

export function SettingsDialog({ api, shell, onClose }: SettingsDialogProps) {
  const [settings, setSettings] = useState<Settings>();
  const [keyStatus, setKeyStatus] = useState<KeyStatus>();
  const [spend, setSpend] = useState<SpendStatus>();
  const [cache, setCache] = useState<CacheSummary>();
  const [error, setError] = useState<string>();
  const [keyInput, setKeyInput] = useState("");
  const [prices, setPrices] = useState({ input: "", output: "" });
  const [limits, setLimits] = useState({ cap: "", session: "", ask: "" });
  const [confirmClear, setConfirmClear] = useState(false);

  const fail = useCallback((e: unknown) => {
    setError(errorMessage(e));
  }, []);

  const refresh = useCallback(() => {
    api.getKeyStatus("anthropic").then(setKeyStatus, fail);
    api.getSpend().then(setSpend, fail);
    shell.getCacheStats().then(setCache, fail);
  }, [api, shell, fail]);

  useEffect(() => {
    api.getSettings().then(setSettings, fail);
    refresh();
    return shell.onSettingsChanged(setSettings);
  }, [api, shell, refresh, fail]);

  const model = settings?.summaries.model ?? "";
  // The price in effect: the user's own, else the one Epoch ships.
  const price = settings ? priceOf(settings, "anthropic", model) : undefined;
  const ownPrice = settings?.prices[`anthropic:${model}`];
  const shippedPrice = SHIPPED_PRICES[`anthropic:${model}`];
  useEffect(() => {
    setPrices({
      input: price ? String(price.inputPerMTok) : "",
      output: price ? String(price.outputPerMTok) : "",
    });
  }, [price]);
  const storedCap = settings?.spend.monthlyCapUsd;
  const storedSession = settings?.spend.sessionBudgetUsd;
  const storedAsk = settings?.spend.confirmAboveUsd;
  // The form follows what is stored, not every render.
  useEffect(() => {
    setLimits({
      cap: storedCap === undefined ? "" : String(storedCap),
      session: storedSession === undefined ? "" : String(storedSession),
      ask: storedAsk === undefined ? "" : String(storedAsk),
    });
  }, [storedCap, storedSession, storedAsk]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
    };
  }, [onClose]);

  /**
   * Sends a change to main. A toggle shows at once and is put back if main
   * refuses it; limits and prices, which main may ask about, wait for it.
   */
  const update = (patch: SettingsPatch, optimistic = true) => {
    setError(undefined);
    const before = settings;
    if (before && optimistic) {
      try {
        setSettings(applySettingsPatch(before, patch));
      } catch {
        // main will refuse it too, and say why
      }
    }
    api.updateSettings(patch).then(
      (next) => {
        setSettings(next);
        api.getSpend().then(setSpend, fail);
      },
      (e: unknown) => {
        if (before && optimistic) setSettings(before);
        fail(e);
      },
    );
  };

  const saveKey = () => {
    const value = keyInput.trim();
    // The field never keeps the key once it has been sent.
    setKeyInput("");
    if (value === "") return;
    setError(undefined);
    api.setKey("anthropic", value).then(refresh, fail);
  };

  const savePrices = () => {
    const input = parseUsd(prices.input);
    const output = parseUsd(prices.output);
    if (input === null && output === null) {
      update({ prices: { [`anthropic:${model}`]: null } }, false);
      return;
    }
    if (
      input === undefined ||
      output === undefined ||
      input === null ||
      output === null
    ) {
      setError("Enter both prices as dollars per million tokens.");
      return;
    }
    update(
      {
        prices: {
          [`anthropic:${model}`]: {
            inputPerMTok: input,
            outputPerMTok: output,
          },
        },
      },
      false,
    );
  };

  const saveLimits = () => {
    const cap = parseUsd(limits.cap);
    const session = parseUsd(limits.session);
    const ask = parseUsd(limits.ask);
    if (
      cap === undefined ||
      cap === null ||
      session === undefined ||
      session === null ||
      ask === undefined ||
      ask === null
    ) {
      setError("Enter each limit in dollars.");
      return;
    }
    update(
      {
        spend: {
          monthlyCapUsd: cap,
          sessionBudgetUsd: session,
          confirmAboveUsd: ask,
        },
      },
      false,
    );
  };

  const summaries = settings?.summaries;

  return (
    <div
      className="no-drag fixed inset-0 z-40 flex justify-center bg-black/15 pt-[6vh] dark:bg-black/40"
      onPointerDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        role="dialog"
        aria-label="Settings"
        className="border-line bg-raised shadow-pop flex h-fit max-h-[86vh] w-[min(640px,92vw)] flex-col overflow-hidden rounded-xl border"
      >
        <header className="border-line flex items-center gap-2 border-b px-5 py-3">
          <h2 className="flex-1 text-[15px] font-semibold">Settings</h2>
          <IconButton icon={X} label="Close settings" onClick={onClose} />
        </header>
        {error !== undefined && (
          <div
            role="alert"
            className="border-danger/30 bg-danger/10 text-danger mx-5 mt-3 rounded-lg border px-3 py-2 text-[13px]"
          >
            {error}
          </div>
        )}
        {!settings || !summaries ? (
          <p className="text-muted px-5 py-6 text-[13px]">Loading…</p>
        ) : (
          <div className="min-h-0 overflow-auto">
            <Section title="Privacy">
              <Row
                label="Offline mode"
                hint="Blocks every network request. A model on this machine still works if you chose one."
              >
                <Toggle
                  hideLabel
                  label="Offline mode"
                  checked={settings.offline}
                  onChange={(offline) => {
                    update({ offline });
                  }}
                />
              </Row>
              <Row
                label="Check for updates"
                hint={
                  settings.offline
                    ? "Never while offline."
                    : "Once installers ship, asks the release host for the latest version; sends no project data."
                }
              >
                <Toggle
                  hideLabel
                  label="Check for updates"
                  checked={settings.updateChecks && !settings.offline}
                  onChange={(updateChecks) => {
                    update({ updateChecks });
                  }}
                />
              </Row>
            </Section>

            <Section title="Summaries">
              <Row
                label="Summaries"
                hint="Model-written summaries of files and folders. They turn on when you save an Anthropic key; nothing is sent before you agree, once per project."
              >
                <Toggle
                  hideLabel
                  label="Summaries"
                  checked={summaries.enabled}
                  onChange={(enabled) => {
                    update({ summaries: { enabled } });
                  }}
                />
              </Row>
              <Row label="Model">
                <Segmented
                  label="Model provider"
                  value={summaries.provider}
                  onChange={(provider) => {
                    update({ summaries: { provider } });
                  }}
                  options={[
                    { value: "anthropic", label: "Anthropic (your key)" },
                    { value: "local", label: "On this machine" },
                  ]}
                />
              </Row>
              {summaries.provider === "anthropic" ? (
                <Row
                  label="Claude model"
                  hint="Sent with your key to Anthropic's API."
                >
                  <CommitField
                    label="Claude model"
                    value={summaries.model}
                    onCommit={(m) => {
                      if (m !== "") update({ summaries: { model: m } });
                    }}
                  />
                </Row>
              ) : (
                <Row
                  label="Ollama model"
                  hint="Ollama on this machine; nothing leaves it."
                >
                  <CommitField
                    label="Ollama model"
                    value={summaries.localModel ?? ""}
                    placeholder="e.g. qwen3:4b"
                    onCommit={(m) => {
                      if (m !== "") update({ summaries: { localModel: m } });
                    }}
                  />
                </Row>
              )}
              <Row
                label="Summarize on open"
                hint="When a file is shown, within your limits below. Folders and anything over the ask-first amount always ask."
              >
                <Toggle
                  hideLabel
                  label="Summarize on open"
                  checked={summaries.auto}
                  onChange={(auto) => {
                    update({ summaries: { auto } });
                  }}
                />
              </Row>
            </Section>

            <Section title="Keys">
              <Row
                label="Anthropic API key"
                hint={keyStatus ? keyStatusText(keyStatus) : "…"}
              >
                <input
                  type="password"
                  aria-label="Anthropic API key"
                  autoComplete="off"
                  spellCheck={false}
                  placeholder={
                    keyStatus?.configured ? "Replace key" : "Paste key"
                  }
                  className={`${fieldClass} w-44`}
                  value={keyInput}
                  onChange={(e) => {
                    setKeyInput(e.target.value);
                  }}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") saveKey();
                  }}
                />
                <Button disabled={keyInput.trim() === ""} onClick={saveKey}>
                  Save
                </Button>
                {keyStatus?.configured === true && (
                  <Button
                    variant="ghost"
                    onClick={() => {
                      api.removeKey("anthropic").then(refresh, fail);
                    }}
                  >
                    Remove
                  </Button>
                )}
              </Row>
              <Row
                label="Jev (TypeSafe AI)"
                hint="Not in the app; the CLI's --scorer jev reads JEV_API_KEY."
              >
                <span className="text-muted text-xs">—</span>
              </Row>
            </Section>

            <Section title="Prices">
              <p className="text-muted text-xs" aria-label="Price source">
                {ownPrice
                  ? `Your prices for ${model}, in dollars per million tokens.`
                  : shippedPrice
                    ? `From Anthropic's pricing page (${SHIPPED_PRICES_SOURCE.url}), read ${SHIPPED_PRICES_SOURCE.readOn}, in dollars per million tokens. Nothing to do unless the page has changed.`
                    : `Enter ${model}'s prices from Anthropic's pricing page (${SHIPPED_PRICES_SOURCE.url}), in dollars per million tokens. Without them, paid summaries stay off.`}
              </p>
              <Row label={`${model}: input / output`}>
                <input
                  type="text"
                  inputMode="decimal"
                  aria-label="Input price per million tokens"
                  className={`${fieldClass} w-20`}
                  value={prices.input}
                  onChange={(e) => {
                    setPrices((p) => ({ ...p, input: e.target.value }));
                  }}
                />
                <input
                  type="text"
                  inputMode="decimal"
                  aria-label="Output price per million tokens"
                  className={`${fieldClass} w-20`}
                  value={prices.output}
                  onChange={(e) => {
                    setPrices((p) => ({ ...p, output: e.target.value }));
                  }}
                />
                <Button onClick={savePrices}>Save</Button>
                {ownPrice && shippedPrice && (
                  <Button
                    variant="ghost"
                    onClick={() => {
                      update(
                        { prices: { [`anthropic:${model}`]: null } },
                        false,
                      );
                    }}
                  >
                    Use Epoch&apos;s
                  </Button>
                )}
              </Row>
            </Section>

            <Section title="Spending">
              {spend && (
                <p className="text-[13px]" aria-label="Spending so far">
                  This month: {usd(spend.monthUsd)}
                  {spend.capUsd === undefined
                    ? " (no cap set)"
                    : ` of ${usd(spend.capUsd)}`}
                  {" · "}This session: {usd(spend.sessionUsd)} of{" "}
                  {usd(spend.sessionBudgetUsd)}
                </p>
              )}
              <Row
                label="Monthly cap"
                hint="Paid requests stop here each month. Raising a limit asks you first."
              >
                <input
                  type="text"
                  inputMode="decimal"
                  aria-label="Monthly cap in dollars"
                  className={`${fieldClass} w-20`}
                  value={limits.cap}
                  onChange={(e) => {
                    setLimits((l) => ({ ...l, cap: e.target.value }));
                  }}
                />
              </Row>
              <Row label="Session budget">
                <input
                  type="text"
                  inputMode="decimal"
                  aria-label="Session budget in dollars"
                  className={`${fieldClass} w-20`}
                  value={limits.session}
                  onChange={(e) => {
                    setLimits((l) => ({ ...l, session: e.target.value }));
                  }}
                />
              </Row>
              <Row
                label="Ask first above"
                hint="A request or folder job estimated above this asks before it runs."
              >
                <input
                  type="text"
                  inputMode="decimal"
                  aria-label="Ask first above, in dollars"
                  className={`${fieldClass} w-20`}
                  value={limits.ask}
                  onChange={(e) => {
                    setLimits((l) => ({ ...l, ask: e.target.value }));
                  }}
                />
              </Row>
              <div className="flex justify-end gap-1.5">
                <Button
                  variant="ghost"
                  onClick={() => {
                    shell.resetSpend().then(setSpend, fail);
                  }}
                >
                  Reset this month
                </Button>
                <Button onClick={saveLimits}>Save limits</Button>
              </div>
            </Section>

            <Section title="Cache">
              {cache && (
                <p className="text-[13px]" aria-label="Cache size">
                  {bytes(cache.bytes)} on this machine · {cache.facts} files ·{" "}
                  {cache.summaries.paid + cache.summaries.local} summaries (
                  {cache.summaries.paid} paid)
                </p>
              )}
              <p className="text-muted text-xs">
                Derived data that Epoch rebuilds from your files. Summaries cost
                money to make again.
              </p>
              <div className="flex justify-end gap-1.5">
                {confirmClear ? (
                  <>
                    <span className="text-muted self-center text-xs">
                      Deletes {cache?.summaries.paid ?? 0} paid summaries.
                    </span>
                    <Button
                      variant="ghost"
                      onClick={() => {
                        setConfirmClear(false);
                      }}
                    >
                      Keep
                    </Button>
                    <Button
                      onClick={() => {
                        setConfirmClear(false);
                        shell.clearCache().then(setCache, fail);
                      }}
                    >
                      Clear cache
                    </Button>
                  </>
                ) : (
                  <Button
                    onClick={() => {
                      setConfirmClear(true);
                    }}
                  >
                    Clear…
                  </Button>
                )}
              </div>
            </Section>
          </div>
        )}
      </div>
    </div>
  );
}
