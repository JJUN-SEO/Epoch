/*
 * The only places Epoch's model features send requests (CLAUDE.md "Privacy
 * and data flow"): the Anthropic API and TypeSafe's Jev API, each with the
 * user's own key, and an Ollama server on this machine. No model client
 * here, so the app's egress can name them without loading one.
 */

export const ANTHROPIC_ORIGIN = "https://api.anthropic.com";
export const OLLAMA_ORIGIN = "http://127.0.0.1:11434";
export const JEV_ORIGIN = "https://api.typesafe.ai";
