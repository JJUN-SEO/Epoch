import {
  anthropicTextModel,
  geminiTextModel,
  ollamaTextModel,
  openaiTextModel,
  type TextModel,
} from "@epoch-dev/scorers";
import type { Egress } from "./egress";
import type { SenderLike } from "./summary-service";

/*
 * The model client, loaded by main only when a summary is first sent (a
 * lazy chunk: bundle.test checks main's entry carries no client). Each
 * request builds its client with the key decrypted for that request alone,
 * and goes out through main's one egress (shared with the update check:
 * a session takes one request filter).
 */

export function createSender(egress: Egress): SenderLike {
  return {
    generate(model, apiKey, req) {
      const opts = {
        apiKey: apiKey ?? "",
        model: model.model,
        net: egress.net,
      };
      const client: TextModel =
        model.provider === "anthropic"
          ? anthropicTextModel(opts)
          : model.provider === "openai"
            ? openaiTextModel(opts)
            : model.provider === "gemini"
              ? geminiTextModel(opts)
              : ollamaTextModel({ model: model.model, net: egress.net });
      return client.generate(req);
    },
    abortAll() {
      egress.net.abortInFlight();
    },
  };
}
