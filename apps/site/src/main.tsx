import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { Graph } from "@epoch-dev/core";
import { App } from "@epoch-dev/ui/app";
import { createStaticApi } from "@epoch-dev/ui/api";
import repos from "../data/repos.json";
import "./demo.css";

const demos = {
  zod: () =>
    Promise.all([
      import("../data/zod.graph.json"),
      import("../data/zod.meta.json"),
    ]),
  flask: () =>
    Promise.all([
      import("../data/flask.graph.json"),
      import("../data/flask.meta.json"),
    ]),
  cli: () =>
    Promise.all([
      import("../data/cli.graph.json"),
      import("../data/cli.meta.json"),
    ]),
} as const;

type DemoId = keyof typeof demos;
interface DemoMeta {
  readonly name: string;
  readonly url: string;
  readonly commit: string;
  readonly license: string;
}

const root = document.getElementById("root");
if (!root) throw new Error("demo.html has no #root element");

const param = new URLSearchParams(location.search).get("repo");
const id: DemoId = param === "flask" || param === "cli" ? param : "zod";

void demos[id]().then(([graphModule, metaModule]) => {
  const graph = Graph.parse(graphModule.default);
  const meta = metaModule.default as DemoMeta;
  const project = { root: `/demo/${id}`, name: meta.name };
  const api = createStaticApi(project, graph);
  const commitUrl = `${meta.url}/tree/${meta.commit}`;
  const upstream = repos.find((repo) => repo.id === id);
  if (!upstream) throw new Error(`No attribution for ${id}`);
  const licenseUrl = `${meta.url}/blob/${meta.commit}/${upstream.licenseFile}`;
  document.title = `${meta.name} · Epoch demo`;
  createRoot(root).render(
    <StrictMode>
      <div className="demo-attribution" data-testid="attribution">
        <strong>Epoch demo</strong>
        <span>Precomputed graph of {meta.name}</span>
        <a href={commitUrl} rel="noopener noreferrer" target="_blank">
          {meta.commit.slice(0, 12)}
        </a>
        <a href={licenseUrl} rel="noopener noreferrer" target="_blank">
          {meta.license}
        </a>
        <span>No source code or model features in this demo.</span>
        <a className="push" href="./">
          About Epoch
        </a>
      </div>
      <div className="demo-app">
        <App api={api} initial={{ project, graph }} />
      </div>
    </StrictMode>,
  );
});
