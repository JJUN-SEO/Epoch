import { anthropicTextModel, ollamaTextModel } from "@epoch-dev/scorers";
import { createEgress } from "./egress";
import type { SenderLike } from "./summary-service";

/*
 * The model client, loaded by main only when a summary is first sent (a
 * lazy chunk: bundle.test checks main's entry carries no client). Each
 * request builds its client with the key decrypted for that request alone,
 * and goes out through the egress.
 */

export function createSender(offline: () => boolean): SenderLike {
  const egress = createEgress(offline);
  return {
    generate(model, apiKey, req) {
      const client =
        model.provider === "anthropic"
          ? anthropicTextModel({
              apiKey: apiKey ?? "",
              model: model.model,
              net: egress.net,
            })
          : ollamaTextModel({ model: model.model, net: egress.net });
      return client.generate(req);
    },
    abortAll() {
      egress.net.abortInFlight();
    },
  };
}
