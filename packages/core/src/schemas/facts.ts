import { z } from "zod";

/** 1-based source line number. */
export const Line = z.number().int().positive();

/** `imported`: "*" = namespace/all, "default" = default export. */
export const ImportedName = z.strictObject({
  imported: z.string().min(1),
  exportedAs: z.string().min(1).exactOptional(),
});
export type ImportedName = z.infer<typeof ImportedName>;

export const RawImportKind = z.enum([
  "static",
  "dynamic",
  "require",
  "reexport",
  "side-effect",
]);
export type RawImportKind = z.infer<typeof RawImportKind>;

export const RawImport = z.strictObject({
  kind: RawImportKind,
  /** null when the specifier is not a string literal. */
  specifier: z.string().nullable(),
  /** Literal prefix of a template/concat specifier, e.g. "./pages/". */
  dynamicPrefix: z.string().exactOptional(),
  typeOnly: z.boolean(),
  names: z.array(ImportedName),
  line: Line,
});
export type RawImport = z.infer<typeof RawImport>;

/** `from` is set for re-exports. */
export const ExportInfo = z.strictObject({
  name: z.string().min(1),
  from: z
    .strictObject({ specifier: z.string(), imported: z.string().min(1) })
    .exactOptional(),
});
export type ExportInfo = z.infer<typeof ExportInfo>;

export const FlagUsage = z.strictObject({
  /** null when the key is not a string literal (cannot be assessed). */
  flagName: z.string().nullable(),
  line: Line,
  endLine: Line,
  detection: z.enum(["sdk-call", "wrapper-call", "env-read"]),
  strength: z.enum(["strong", "weak"]),
  provider: z.string().exactOptional(),
  patternId: z.string().exactOptional(),
});
export type FlagUsage = z.infer<typeof FlagUsage>;

export const ConstantCondition = z.strictObject({
  /** null for literal conditions such as `if (false)`. */
  name: z.string().nullable(),
  value: z.boolean(),
  scope: z.enum(["literal", "local", "module", "exported"]),
  line: Line,
  endLine: Line,
  deadBranch: z.enum(["then", "else"]),
});
export type ConstantCondition = z.infer<typeof ConstantCondition>;

/** The cached unit: a pure function of file content + adapter + extractor config. */
export const FileFacts = z.strictObject({
  imports: z.array(RawImport),
  exports: z.array(ExportInfo),
  /** Specifiers of `export * from`. */
  exportAllFrom: z.array(z.string()),
  flagUsages: z.array(FlagUsage),
  constantConditions: z.array(ConstantCondition),
  /** A generated-file marker was found. */
  isGenerated: z.boolean(),
  loc: z.number().int().nonnegative(),
});
export type FileFacts = z.infer<typeof FileFacts>;
