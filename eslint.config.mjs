// @ts-check
// One flat config for the whole workspace. ESLint looks up the config from each
// linted file's directory, so every package's `eslint .` uses this file.
import js from "@eslint/js";
import comments from "@eslint-community/eslint-plugin-eslint-comments/configs";
import prettier from "eslint-config-prettier/flat";
import { defineConfig, globalIgnores } from "eslint/config";
import tseslint from "typescript-eslint";

// Network guard. CLAUDE.md "Privacy and data flow": every network call goes
// through a single network wrapper, and there is none before M7. Dynamic
// import() and require() are not caught here; M7's zero-network test is the
// real enforcement.
const NETWORK_MESSAGE =
  "Epoch makes network calls only through its single network wrapper (CLAUDE.md, Privacy and data flow).";
const NETWORK_MODULES = ["http", "https", "http2", "net", "tls", "dgram"];

export default defineConfig(
  globalIgnores(["**/dist/", "**/coverage/", "**/.turbo/"]),
  js.configs.recommended,
  tseslint.configs.strictTypeChecked,
  tseslint.configs.stylisticTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },
  comments.recommended,
  {
    linterOptions: { reportUnusedDisableDirectives: "error" },
    rules: {
      // "No `any` without a comment explaining why" (CLAUDE.md Conventions):
      // strictTypeChecked makes no-explicit-any an error, and every disable
      // directive must carry a `-- reason`.
      "@eslint-community/eslint-comments/require-description": "error",
      "@eslint-community/eslint-comments/no-unlimited-disable": "error",

      "no-restricted-imports": [
        "error",
        {
          paths: [
            ...NETWORK_MODULES.flatMap((m) => [m, `node:${m}`]),
            "undici",
          ].map((name) => ({
            name,
            message: NETWORK_MESSAGE,
          })),
        },
      ],
      "no-restricted-globals": [
        "error",
        ...["fetch", "WebSocket", "EventSource"].map((name) => ({
          name,
          message: NETWORK_MESSAGE,
        })),
      ],
      "no-restricted-properties": [
        "error",
        { object: "globalThis", property: "fetch", message: NETWORK_MESSAGE },
      ],
    },
  },
  {
    files: ["**/*.{js,mjs,cjs}"],
    extends: [tseslint.configs.disableTypeChecked],
  },
  prettier,
);
