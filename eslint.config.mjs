// @ts-check
// One flat config for the whole workspace. ESLint looks up the config from each
// linted file's directory, so every package's `eslint .` uses this file.
import js from "@eslint/js";
import comments from "@eslint-community/eslint-plugin-eslint-comments/configs";
import prettier from "eslint-config-prettier/flat";
import { defineConfig, globalIgnores } from "eslint/config";
import tseslint from "typescript-eslint";

// Network guard. CLAUDE.md "Privacy and data flow": every network call goes
// through a single network wrapper, packages/scorers/src/net.ts (M6: opt-in
// model scorers; M7 makes it app-wide), the one file exempt below. This is a
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

const NETWORK_IMPORT_PATHS = [
  ...NETWORK_MODULES.flatMap((m) => [m, `node:${m}`]),
  "undici",
].map((name) => ({ name, message: NETWORK_MESSAGE, allowTypeImports: true }));
const NETWORK_IMPORT_PATTERNS = [
  { group: ["undici/*"], message: NETWORK_MESSAGE, allowTypeImports: true },
];
const EGRESS_MESSAGE =
  "Main sends only through its egress, packages/app/src/main/egress.ts (ADR-016).";

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
        { paths: NETWORK_IMPORT_PATHS, patterns: NETWORK_IMPORT_PATTERNS },
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
    // The single network wrapper: an origin allowlist and an offline switch
    // in front of fetch. And the build-time model download, which runs on
    // the build machine and in CI, never in Epoch (docs/privacy.md).
    files: ["packages/scorers/src/net.ts", "scripts/fetch-model.mjs"],
    rules: {
      "no-restricted-globals": "off",
      "no-restricted-properties": "off",
    },
  },
  {
    // The app's main process sends model requests through one egress: an
    // Electron session of its own behind the network wrapper. Electron's net
    // module and any session's fetch belong to that file alone.
    files: ["packages/app/src/**/*.ts"],
    ignores: ["packages/app/src/main/egress.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          paths: [
            ...NETWORK_IMPORT_PATHS,
            {
              name: "electron",
              importNames: ["net"],
              message: EGRESS_MESSAGE,
              allowTypeImports: true,
            },
          ],
          patterns: NETWORK_IMPORT_PATTERNS,
        },
      ],
      "no-restricted-syntax": [
        "error",
        {
          selector: "CallExpression[callee.property.name='fetch']",
          message: EGRESS_MESSAGE,
        },
      ],
    },
  },
  {
    // The tripwire replaces the network functions of a process that must
    // never use the network, so it names them; its test and the
    // zero-network test's canary make real attempts it must refuse.
    files: [
      "packages/scorers/src/tripwire.ts",
      "packages/scorers/src/tripwire.test.ts",
      "scripts/no-network.mjs",
      "scripts/no-network-canary.mjs",
    ],
    rules: {
      "no-restricted-imports": "off",
      "no-restricted-globals": "off",
      "no-restricted-properties": "off",
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
