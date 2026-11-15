import {
  Graph,
  blastRadius,
  clusters,
  dependencyPath,
  mostDependedOn,
} from "@epoch-dev/core";
import { expect, test } from "@playwright/test";
import fs from "node:fs";

// The landing page and the demo viewer: the desktop app's UI over the
// precomputed graphs, read-only, with no request beyond the site's own files.

const data = new URL("../data/", import.meta.url);
const read = (file: string): unknown =>
  JSON.parse(fs.readFileSync(new URL(file, data), "utf8"));

interface Meta {
  readonly id: string;
  readonly name: string;
  readonly url: string;
  readonly commit: string;
  readonly license: string;
  readonly copyright: string;
  readonly licenseFile: string;
  readonly madeWith: { readonly coverage?: { readonly ranOn: string } };
}
const demos = ["zod", "flask", "cli"].map((id) => ({
  meta: read(`${id}.meta.json`) as Meta,
  graph: Graph.parse(read(`${id}.graph.json`)),
}));

/** The status bar's node counts, as StatusBar.tsx writes them. */
function stats(graph: Graph): string {
  const count = (kind: string) =>
    graph.nodes.filter((n) => n.kind === kind).length;
  const files = `${String(count("file"))} files`;
  return count("package") > 0
    ? `${String(count("package"))} packages · ${files}`
    : files;
}

test("landing links to every offline demo and installer", async ({ page }) => {
  await page.goto("./");
  await expect(
    page.getByRole("heading", { name: /See the shape of/i }),
  ).toBeVisible();
  for (const { meta } of demos)
    await expect(
      page.locator(`a[href="./demo.html?repo=${meta.id}"]`).first(),
    ).toBeVisible();
  await expect(page.locator('a[href$="Epoch-mac-arm64.dmg"]')).toBeVisible();
  await expect(
    page.locator('a[href$="Epoch-win-x64-setup.exe"]'),
  ).toBeVisible();
  await expect(page.locator('a[href$="Epoch-linux-x64.deb"]')).toBeVisible();
  await expect(
    page.locator('a[href$="Epoch-linux-x64.AppImage"]'),
  ).toBeVisible();
});

for (const { meta, graph } of demos) {
  test(`${meta.name} demo: the graph, where it came from, and nothing else loaded`, async ({
    page,
  }) => {
    const outside: string[] = [];
    const violations: string[] = [];
    page.on("request", (request) => {
      if (new URL(request.url()).origin !== "http://127.0.0.1:4173")
        outside.push(request.url());
    });
    page.on("console", (message) => {
      if (message.type() === "error") violations.push(message.text());
    });
    page.on("pageerror", (error) => violations.push(error.message));
    await page.goto(`./demo.html?repo=${meta.id}`);
    const attribution = page.getByTestId("attribution");
    await expect(attribution).toContainText(meta.name);
    await expect(attribution).toContainText(meta.commit.slice(0, 12));
    await expect(attribution).toContainText(meta.copyright);
    await expect(
      attribution.getByRole("link", { name: meta.license }),
    ).toHaveAttribute("href", `./data/${meta.licenseFile}`);
    await expect(attribution).toContainText("No source code or model features");
    if (meta.madeWith.coverage) {
      await expect(page.getByTestId("coverage-source")).toHaveText(
        `Coverage from its own tests, run ${meta.madeWith.coverage.ranOn}.`,
      );
    }
    await expect(page.getByTestId("graph-stats")).toContainText(stats(graph));
    expect(await page.evaluate(() => "epoch" in window)).toBe(false);
    expect(outside).toEqual([]);
    expect(violations).toEqual([]);
  });
}

test("each demo repository's license text is served", async ({ request }) => {
  for (const { meta } of demos) {
    const res = await request.get(`./data/${meta.licenseFile}`);
    expect(res.status()).toBe(200);
    expect(await res.text()).toContain(meta.copyright);
  }
});

test("zod shows reviewable findings with caveats and evidence", async ({
  page,
}) => {
  await page.goto("./demo.html?repo=zod");
  await expect(page.getByTestId("findings-banner")).toBeVisible();
  await page
    .getByTestId("findings-banner")
    .getByRole("button", { name: "Review" })
    .click();
  await expect(
    page.getByText("Candidates for review, not verdicts"),
  ).toBeVisible();
  await page.locator("button[data-finding-id]").first().click();
  const details = page.getByTestId("finding-details");
  await expect(details).toContainText("Keep in mind");
  await expect(details).toContainText("Why it was flagged");
});

test("zod blast radius matches the core calculation", async ({ page }) => {
  const zod = demos.find((d) => d.meta.id === "zod");
  if (!zod) throw new Error("no zod demo");
  const nodeId = "packages/zod/src/v4/core/versions.ts";
  const expected = blastRadius(zod.graph, nodeId, {
    mode: "certain",
    includeTypeOnly: true,
  });
  expect(expected.total).toBeGreaterThan(0);
  await page.goto("./demo.html?repo=zod");
  await page.getByRole("button", { name: "Search files and commands" }).click();
  await page
    .getByRole("combobox", { name: "Search files and commands" })
    .fill("versions.ts");
  await page.getByRole("option", { name: nodeId, exact: true }).click();
  await page.getByRole("tab", { name: "Impact" }).click();
  await expect(page.getByTestId("impact-total")).toHaveText(
    `${String(expected.total)} files`,
  );
});

test("zod shows which files its tests cover, and why others have no coverage", async ({
  page,
}) => {
  const zod = demos.find((d) => d.meta.id === "zod");
  if (!zod) throw new Error("no zod demo");
  const covered = zod.graph.nodes.find(
    (n) => n.id === "packages/zod/src/v4/locales/ar.ts",
  );
  const uncovered = zod.graph.nodes.find(
    (n) => n.language === "typescript" && n.metrics.coverage === undefined,
  );
  if (covered?.metrics.coverage === undefined || !uncovered)
    throw new Error("the zod demo lost its coverage");
  await page.goto("./demo.html?repo=zod");
  await page
    .getByRole("group", { name: "Color by" })
    .getByRole("button", { name: "Coverage" })
    .click();
  const legend = page.getByTestId("color-legend");
  await expect(legend).toContainText("Test coverage");
  await expect(legend).toContainText("Under 50%");
  await expect(legend).toContainText("No coverage");

  const open = async (id: string) => {
    await page
      .getByRole("button", { name: "Search files and commands" })
      .click();
    await page
      .getByRole("combobox", { name: "Search files and commands" })
      .fill(id);
    await page.getByRole("option", { name: id, exact: true }).click();
  };
  await open(covered.id);
  await expect(page.getByTestId("coverage-value")).toContainText(
    `${(covered.metrics.coverage * 100).toFixed(0)}%`,
  );
  await expect(page.getByTestId("coverage-note")).toHaveCount(0);
  await open(uncovered.id);
  await expect(page.getByTestId("coverage-value")).toContainText("—");
  await expect(page.getByTestId("coverage-note")).toHaveText(
    "Not in the coverage report: its tests may not load this file, or the report is older than it.",
  );
});

test("zod: the most depended-on files, clusters, and the path between two files", async ({
  page,
}) => {
  const zod = demos.find((d) => d.meta.id === "zod");
  if (!zod) throw new Error("no zod demo");
  const hubs = mostDependedOn(zod.graph, 10);
  const [hub] = hubs;
  const [largest] = clusters(zod.graph).clusters;
  const from = "packages/zod/src/v4/classic/schemas.ts";
  const to = "packages/zod/src/v4/core/versions.ts";
  const path = dependencyPath(zod.graph, from, to, {
    mode: "certain",
    includeTypeOnly: true,
  });
  if (!hub || !largest || !path) throw new Error("the zod demo changed");

  await page.goto("./demo.html?repo=zod");
  // Nothing is selected yet: the panel offers the files most others depend on.
  const list = page.getByTestId("hubs");
  await expect(list.getByRole("button")).toHaveCount(hubs.length);
  await expect(list.getByRole("button").first()).toHaveText(
    `${hub.id}${String(hub.metrics.dependents)}`,
  );

  await page
    .getByRole("group", { name: "Color by" })
    .getByRole("button", { name: "Cluster" })
    .click();
  const legend = page.getByTestId("color-legend");
  await expect(legend).toContainText("Clusters");
  await expect(legend).toContainText(
    `${largest.label.split("/").slice(-2).join("/")} · ${String(largest.members.length)}`,
  );

  await page.getByRole("button", { name: "Search files and commands" }).click();
  await page
    .getByRole("combobox", { name: "Search files and commands" })
    .fill(from);
  await page.getByRole("option", { name: from, exact: true }).click();
  await page.getByTestId("path-input").fill("core/versions.ts");
  await page.getByTestId("path").getByRole("button", { name: to }).click();
  const result = page.getByTestId("path-result");
  await expect(result).toContainText(
    `This file depends on it through ${String(path.hops.length)} imports.`,
  );
  for (const id of path.nodes) await expect(result).toContainText(id);

  await result.getByRole("button", { name: "Clear the path" }).click();
  await expect(page.getByTestId("path-input")).toHaveValue("");
});
