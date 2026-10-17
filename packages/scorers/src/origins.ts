/*
 * The only places Epoch's model features send requests (CLAUDE.md "Privacy
 * and data flow"): the Anthropic API with the user's key, and an Ollama
 * server on this machine. No model client here, so the app's egress can
 * name them without loading one.
 */

export const ANTHROPIC_ORIGIN = "https://api.anthropic.com";
export const OLLAMA_ORIGIN = "http://127.0.0.1:11434";
