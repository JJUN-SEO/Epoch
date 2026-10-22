declare const OpenFeature: { getClient(): { getBooleanValue(k: string, d: boolean): Promise<boolean> } };

const client = OpenFeature.getClient();

export async function checkout(key: string): Promise<number> {
  if (await client.getBooleanValue("new-checkout", false)) { // @C
    return 1;
  }
  return 0;
}
