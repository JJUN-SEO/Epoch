import * as tokenizers from "@huggingface/tokenizers";

/*
 * @huggingface/tokenizers 0.2.0 ships declarations whose relative imports
 * have no file extension, which "nodenext" resolution cannot follow, so its
 * classes come through untyped. This is the part Epoch uses, typed by hand
 * from those declarations (types/core/Tokenizer.d.ts, types/static/types.d.ts).
 */

export interface HfTokenizer {
  encode(
    text: string,
    options: { readonly add_special_tokens: boolean },
  ): { readonly ids: number[] };
  token_to_id(token: string): number | undefined;
}

/** Builds a tokenizer from a model's parsed tokenizer.json and tokenizer_config.json. */
export const Tokenizer = tokenizers.Tokenizer as unknown as new (
  tokenizer: object,
  config: object,
) => HfTokenizer;
