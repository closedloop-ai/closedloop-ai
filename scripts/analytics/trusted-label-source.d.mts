import type ts from "typescript6";

export function sourceResolver(root: string): {
  source(file: string, contents?: string): ts.SourceFile;
  values(node: ts.Node | undefined): string[] | null;
  dependencies(): string[];
};
export function isProductLabelSource(file: string): boolean;
export function join(
  left: string[] | null,
  right: string[] | null
): string[] | null;
