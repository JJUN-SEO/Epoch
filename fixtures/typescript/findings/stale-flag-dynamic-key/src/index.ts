import { OpenFeature } from "@openfeature/server-sdk";

const client = OpenFeature.getClient();

export async function checkout(key: string): Promise<number> {
  if (await client.getBooleanValue(key, false)) { // @C
    return 1;
  }
  return 0;
}
