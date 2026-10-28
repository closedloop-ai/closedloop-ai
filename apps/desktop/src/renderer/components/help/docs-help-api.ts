export type DocsHelpApi = NonNullable<Window["desktopApi"]>["docsHelp"];

export function getDocsHelpApi(): DocsHelpApi | null {
  return globalThis.window?.desktopApi?.docsHelp ?? null;
}
