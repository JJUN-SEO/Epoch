const NAMES: Readonly<Record<string, string>> = {
  typescript: "TypeScript",
  javascript: "JavaScript",
  python: "Python",
  go: "Go",
};

/** A GraphNode.language for display: "TypeScript", or a file type such as "css". */
export const languageName = (language: string): string =>
  NAMES[language] ?? language;
