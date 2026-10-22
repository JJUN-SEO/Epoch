import type { Tree } from "web-tree-sitter";
import type { AdapterRegistration } from "@epoch-dev/core";
import { goRegistration } from "@epoch-dev/adapter-go";
import { pythonRegistration } from "@epoch-dev/adapter-python";
import { typescriptRegistration } from "@epoch-dev/adapter-typescript";

/** Every built-in adapter. Parse workers know exactly these, by adapter id. */
export const DEFAULT_REGISTRATIONS: readonly AdapterRegistration<Tree>[] = [
  typescriptRegistration,
  pythonRegistration,
  goRegistration,
];
