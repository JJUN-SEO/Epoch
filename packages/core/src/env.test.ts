import { describe, expect, it } from "vitest";
import { withoutSecrets } from "./env.js";

describe("withoutSecrets", () => {
  it("drops keys, tokens, secrets and passwords, whatever their case", () => {
    const env = withoutSecrets({
      PATH: "/usr/bin",
      HOME: "/home/me",
      GIT_DIR: ".git",
      ANTHROPIC_API_KEY: "k",
      ANTHROPIC_AUTH_TOKEN: "t",
      ANTHROPIC_CUSTOM_HEADERS: "X: y",
      EPOCH_JEV_API_KEY: "j",
      OPENAI_APIKEY: "o",
      GITHUB_TOKEN: "g",
      npm_config_authtoken: "n",
      AWS_SECRET_ACCESS_KEY: "s",
      DB_PASSWORD: "p",
      GOOGLE_APPLICATION_CREDENTIALS: "c",
      SystemRoot: "C:\\Windows",
      UNSET: undefined,
    });
    expect(env).toEqual({
      PATH: "/usr/bin",
      HOME: "/home/me",
      GIT_DIR: ".git",
      SystemRoot: "C:\\Windows",
    });
  });
});
