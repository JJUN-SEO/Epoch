import { describe, expect, it } from "vitest";
import { z } from "zod";
import { IpcRejected, admit, type SenderInfo } from "./ipc";

const ui: SenderInfo = {
  knownWindow: true,
  isMainFrame: true,
  url: "epoch://app/index.html",
};
const oneString = z.tuple([z.string().min(1)]);

describe("admit", () => {
  it("returns the parsed arguments for the UI's main frame", () => {
    expect(admit(ui, oneString, ["/projects/a"])).toEqual(["/projects/a"]);
    expect(admit(ui, z.tuple([]), [])).toEqual([]);
  });

  it.each<[string, SenderInfo]>([
    ["an unknown window", { ...ui, knownWindow: false }],
    ["a subframe", { ...ui, isMainFrame: false }],
    ["a frame that is gone", { ...ui, url: undefined }],
    ["remote content", { ...ui, url: "https://example.com/" }],
    ["another app origin", { ...ui, url: "epoch://other/index.html" }],
    [
      "the dev server outside development",
      { ...ui, url: "http://localhost:5173/" },
    ],
  ])("rejects %s", (_name, sender) => {
    expect(() => admit(sender, oneString, ["/projects/a"])).toThrow(
      IpcRejected,
    );
  });

  it("accepts the dev server only when it is the configured one", () => {
    const dev = { ...ui, url: "http://localhost:5173/" };
    expect(admit(dev, oneString, ["x"], "http://localhost:5173")).toEqual([
      "x",
    ]);
  });

  it.each([[[]], [[42]], [["/a", "/b"]], [[""]], [[{ path: "/a" }]]])(
    "rejects the invalid payload %j",
    (args) => {
      expect(() => admit(ui, oneString, args)).toThrow(/invalid payload/);
    },
  );
});
