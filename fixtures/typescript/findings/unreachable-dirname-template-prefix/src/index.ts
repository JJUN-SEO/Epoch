import path from "node:path";

export function fixturePath(name: string): string {
  return path.join(__dirname, "fixtures", `${name}.ts`);
}
