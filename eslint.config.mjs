// @ts-check
// One flat config for the whole workspace. ESLint looks up the config from each
// linted file's directory, so every package's `eslint .` uses this file.
import js from "@eslint/js";
import comments from "@eslint-community/eslint-plugin-eslint-comments/configs";
import prettier from "eslint-config-prettier/flat";
import { defineConfig, globalIgnores } from "eslint/config";
import tseslint from "typescript-eslint";

// Network guard. CLAUDE.md "Privacy and data flow": every network call goes
// through a single network wrapper, and there is none before M7. This is a
// backstop, not a proof: it cannot see dynamic import(), require(), computed
// property access or other packages that open sockets. M7's zero-network test
// is the real enforcement. Type-only imports are allowed: they are erased.
const NETWORK_MESSAGE =
  "Epoch makes network calls only through its single network wrapper (CLAUDE.md, Privacy and data flow).";
const NETWORK_MODULES = [
  "http",
  "https",
  "http2",
  "net",
  "tls",
  "dgram",
  "dns",
  "dns/promises",
];
const NETWORK_GLOBALS = ["fetch", "WebSocket", "EventSource"];

const RENDER_AS_TEXT_MESSAGE =
  "Render repository-derived strings as text, never as HTML (CLAUDE.md, Electron security).";

export default defineConfig(
  globalIgnores([
    "**/dist/",
    "**/coverage/",
    "**/.turbo/",
    // Electron build output, packaged apps and Playwright artifacts.
    "**/out/",
    "**/release/",
    "**/test-results/",
  ]),
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

      // Allow deliberately unused names when they start with "_" (interface
      // parameters a stage does not use yet, discarded destructuring keys).
      "@typescript-eslint/no-unused-vars": [
        "error",
        {
          argsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
          caughtErrorsIgnorePattern: "^_",
          ignoreRestSiblings: true,
        },
      ],

      "no-restricted-imports": [
        "error",
        {
          paths: [
            ...NETWORK_MODULES.flatMap((m) => [m, `node:${m}`]),
            "undici",
          ].map((name) => ({
            name,
            message: NETWORK_MESSAGE,
            allowTypeImports: true,
          })),
          patterns: [
            {
              group: ["undici/*"],
              message: NETWORK_MESSAGE,
              allowTypeImports: true,
            },
          ],
        },
      ],
      "no-restricted-globals": [
        "error",
        ...NETWORK_GLOBALS.map((name) => ({ name, message: NETWORK_MESSAGE })),
      ],
      "no-restricted-properties": [
        "error",
        ...["globalThis", "global"].flatMap((object) =>
          NETWORK_GLOBALS.map((property) => ({
            object,
            property,
            message: NETWORK_MESSAGE,
          })),
        ),
      ],
    },
  },
  {
    // The renderer shows strings from untrusted repositories (file names,
    // flag names, evidence): render them as text, never as HTML (CLAUDE.md
    // "Electron security"). It also never imports Node or Electron modules.
    files: ["packages/ui/src/**/*.{ts,tsx}"],
    rules: {
      "no-restricted-syntax": [
        "error",
        ...[
          "JSXAttribute[name.name='dangerouslySetInnerHTML']",
          "MemberExpression[property.name=/^(innerHTML|outerHTML)$/]",
          "CallExpression[callee.property.name=/^(insertAdjacentHTML|createContextualFragment|write|writeln)$/]",
        ].map((selector) => ({ selector, message: RENDER_AS_TEXT_MESSAGE })),
      ],
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              regex: "^(node:|electron$|electron/)",
              message: "The renderer has no Node.js or Electron access.",
            },
            {
              regex: `^(node:)?(${NETWORK_MODULES.join("|")}|undici)(/|$)`,
              message: NETWORK_MESSAGE,
            },
          ],
        },
      ],
    },
  },
  {
    files: ["**/*.{js,mjs,cjs}"],
    extends: [tseslint.configs.disableTypeChecked],
  },
  prettier,
);
