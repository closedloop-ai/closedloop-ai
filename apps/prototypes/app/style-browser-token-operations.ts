import type { CSSProperties } from "react";
import {
  StyleTokenScope,
  type TokenDefinition,
  type TokenEdits,
} from "./style-browser-editor-data";

export const StyleTokenOperation = {
  Add: "add",
  Remove: "remove",
  Update: "update",
} as const;

export type StyleTokenOperation =
  (typeof StyleTokenOperation)[keyof typeof StyleTokenOperation];

export type AddedTokenDefinition = TokenDefinition & {
  groupId: string;
};

export type StyleTokenChange =
  | {
      operation: typeof StyleTokenOperation.Add;
      token: AddedTokenDefinition;
      currentValue: string;
    }
  | {
      operation: typeof StyleTokenOperation.Remove;
      token: TokenDefinition;
      previousValue: string;
    }
  | {
      operation: typeof StyleTokenOperation.Update;
      token: TokenDefinition;
      currentValue: string;
      previousValue: string;
    };

export function buildTokenChanges({
  baseTokens,
  addedTokens,
  edits,
  removedTokenIds,
}: {
  baseTokens: readonly TokenDefinition[];
  addedTokens: readonly AddedTokenDefinition[];
  edits: TokenEdits;
  removedTokenIds: ReadonlySet<string>;
}): StyleTokenChange[] {
  const updates: StyleTokenChange[] = [];
  for (const token of baseTokens) {
    if (removedTokenIds.has(token.id)) {
      updates.push({
        operation: StyleTokenOperation.Remove,
        previousValue: token.initialValue,
        token,
      });
      continue;
    }
    const currentValue = edits[token.id];
    if (currentValue === undefined) {
      continue;
    }
    updates.push({
      currentValue,
      operation: StyleTokenOperation.Update,
      previousValue: token.initialValue,
      token,
    });
  }
  const additions: StyleTokenChange[] = addedTokens.map((token) => ({
    currentValue: edits[token.id] ?? token.initialValue,
    operation: StyleTokenOperation.Add,
    token,
  }));
  return [...updates, ...additions];
}

export function buildPreviewStyle(
  changes: readonly StyleTokenChange[]
): CSSProperties {
  return Object.fromEntries(
    changes.flatMap((change) => {
      if (change.operation === StyleTokenOperation.Remove) {
        return [];
      }
      return [[`--${change.token.cssName}`, change.currentValue]];
    })
  ) as CSSProperties;
}

export function buildGeneratedSpec(
  changes: readonly StyleTokenChange[]
): string {
  if (changes.length === 0) {
    return "/* Add, edit, or remove tokens in the inspector to generate a CSS variable patch. */";
  }
  return [StyleTokenScope.Root, StyleTokenScope.Theme]
    .flatMap((scope) => {
      const scopedChanges = changes.filter((change) => {
        return change.token.scope === scope;
      });
      if (scopedChanges.length === 0) {
        return [];
      }
      const lines = scopedChanges.map((change) => {
        if (change.operation === StyleTokenOperation.Remove) {
          return `  /* remove --${change.token.cssName}; was ${change.previousValue} */`;
        }
        const prefix =
          change.operation === StyleTokenOperation.Add ? "  /* add */ " : "  ";
        return `${prefix}--${change.token.cssName}: ${change.currentValue};`;
      });
      return [[scopeSelector(scope), ...lines, "}"].join("\n")];
    })
    .join("\n\n");
}

export function buildExportPayload(
  changes: readonly StyleTokenChange[]
): string {
  return `${JSON.stringify(
    {
      version: 1,
      source: "Closedloop prototype Style Lab",
      targetFile: "packages/design-system/styles/globals.css",
      scope: "per-token",
      tokens: changes.map((change) => {
        if (change.operation === StyleTokenOperation.Remove) {
          return {
            id: change.token.id,
            label: change.token.label,
            name: change.token.cssName,
            operation: change.operation,
            previousValue: change.previousValue,
            scope: change.token.scope,
          };
        }
        return {
          id: change.token.id,
          label: change.token.label,
          name: change.token.cssName,
          operation: change.operation,
          previousValue:
            change.operation === StyleTokenOperation.Update
              ? change.previousValue
              : undefined,
          scope: change.token.scope,
          value: change.currentValue,
        };
      }),
      validation: [
        "pnpm --filter @repo/design-system test",
        "pnpm -C apps/prototypes typecheck",
        "pnpm -C apps/prototypes test",
      ],
    },
    null,
    2
  )}\n`;
}

function scopeSelector(scope: StyleTokenScope): string {
  if (scope === StyleTokenScope.Root) {
    return ":root {";
  }
  return "@theme inline {";
}
