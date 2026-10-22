export function benchPath(name: string): string {
  return import.meta.resolve(`./bench/${name}`);
}
