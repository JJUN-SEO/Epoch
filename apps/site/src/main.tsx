import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { Graph } from "@epoch-dev/core";
import { App } from "@epoch-dev/ui/app";
import { createStaticApi } from "@epoch-dev/ui/api";
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
/** What site-data.mjs records next to each graph (data/<id>.meta.json). */
interface DemoMeta {
  readonly name: string;
  readonly url: string;
  readonly commit: string;
  readonly commitDate: string;
  readonly license: string;
  readonly copyright: string;
  readonly licenseFile: string;
}

const element = document.getElementById("root");
if (!element) throw new Error("demo.html has no #root element");
const root = createRoot(element);

const param = new URLSearchParams(location.search).get("repo");
const id: DemoId = param === "flask" || param === "cli" ? param : "zod";

demos[id]()
  .then(([graphModule, metaModule]) => {
    const graph = Graph.parse(graphModule.default);
    const meta = metaModule.default as DemoMeta;
    const project = { root: `/demo/${id}`, name: meta.name };
    const api = createStaticApi(project, graph);
    document.title = `${meta.name} · Epoch demo`;
    root.render(
      <StrictMode>
        <div className="demo-attribution" data-testid="attribution">
          <strong>Epoch demo</strong>
          <span>
            Precomputed graph of{" "}
            <a href={meta.url} rel="noopener noreferrer" target="_blank">
              {meta.name}
            </a>{" "}
            at{" "}
            <a
              href={`${meta.url}/tree/${meta.commit}`}
              rel="noopener noreferrer"
              target="_blank"
            >
              {meta.commit.slice(0, 12)}
            </a>{" "}
            ({meta.commitDate.slice(0, 10)}). {meta.copyright},{" "}
            <a href={`./data/${meta.licenseFile}`}>{meta.license}</a>.
          </span>
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
  })
  .catch((error: unknown) => {
    console.error(error);
    root.render(
      <p className="demo-error" role="alert">
        This demo could not load. <a href="./">Back to Epoch</a>
      </p>,
    );
  });
