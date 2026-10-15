import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { createIpcApi } from "./api";
import { App } from "./App";
import type { DesktopBridge } from "./bridge";
import "./styles.css";

const root = document.getElementById("root");
if (!root) throw new Error("index.html has no #root element");

// The desktop app's preload exposes window.epoch; the static demo site (M8)
// renders App with createStaticApi() instead.
const bridge = (window as { epoch?: DesktopBridge }).epoch;
const props = bridge ? createIpcApi(bridge) : undefined;

createRoot(root).render(
  <StrictMode>
    {props ? (
      <App api={props.api} shell={props.shell} />
    ) : (
      <main className="p-8">This page needs the Epoch desktop app.</main>
    )}
  </StrictMode>,
);
