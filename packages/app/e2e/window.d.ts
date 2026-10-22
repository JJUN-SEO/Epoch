import type { DesktopBridge } from "@epoch-dev/ui/bridge";

// What the preload exposes, for page.evaluate() callbacks in the e2e tests.
declare global {
  interface Window {
    epoch: DesktopBridge;
  }
}
