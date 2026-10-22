import { describe, expect, it } from "vitest";
import { errorMessage } from "./errors";

describe("errorMessage", () => {
  it("strips Electron's IPC wrapper and the error name", () => {
    expect(
      errorMessage(
        new Error(
          "Error invoking remote method 'epoch:open-project': NotGrantedError: Epoch opens only folders chosen in its folder dialog.",
        ),
      ),
    ).toBe("Epoch opens only folders chosen in its folder dialog.");
    expect(
      errorMessage(
        new Error(
          "Error invoking remote method 'epoch:get-graph': Error: No project is open.",
        ),
      ),
    ).toBe("No project is open.");
    expect(
      errorMessage(
        new Error(
          "Error invoking remote method 'epoch:update-settings': SettingsNotConfirmed: The change was not confirmed.",
        ),
      ),
    ).toBe("The change was not confirmed.");
  });

  it("keeps other messages as they are", () => {
    expect(errorMessage(new Error("Plain failure."))).toBe("Plain failure.");
    expect(errorMessage("text")).toBe("text");
  });
});
