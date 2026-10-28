"use client";

import { Button } from "@repo/design-system/components/ui/button";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@repo/design-system/components/ui/collapsible";
import { Input } from "@repo/design-system/components/ui/input";
import { Label } from "@repo/design-system/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@repo/design-system/components/ui/select";
import { Textarea } from "@repo/design-system/components/ui/textarea";
import { ChevronDownIcon, PaletteIcon, PlusIcon } from "lucide-react";
import { useEffect, useState } from "react";
import { ColorPaletteSelector } from "./style-browser-color-controls";
import {
  type StyleTaxonomyGroup,
  StyleTaxonomyGroupKind,
  StyleTokenScope,
  TokenCategory,
  type TokenDefinition,
} from "./style-browser-editor-data";
import type { AddedTokenDefinition } from "./style-browser-token-operations";

export function AddTokenForm({
  group,
  tokensById,
  onAddToken,
}: {
  group: StyleTaxonomyGroup;
  tokensById: Readonly<Record<string, TokenDefinition>>;
  onAddToken: (token: AddedTokenDefinition, value: string) => void;
}) {
  const [name, setName] = useState(defaultTokenName(group));
  const [scope, setScope] = useState<StyleTokenScope>(StyleTokenScope.Root);
  const [value, setValue] = useState(defaultTokenValue(group.kind));
  const [error, setError] = useState<string | null>(null);
  const [isOpen, setIsOpen] = useState(false);

  useEffect(() => {
    setName(defaultTokenName(group));
    setScope(StyleTokenScope.Root);
    setValue(defaultTokenValue(group.kind));
    setError(null);
    setIsOpen(false);
  }, [group]);

  const submitToken = () => {
    const cssName = normalizeTokenName(name);
    if (!tokenNamePattern.test(cssName)) {
      setError(
        "Use lowercase letters, numbers, and hyphens. Start with a letter."
      );
      return;
    }
    const id = `${scope}:${cssName}`;
    if (tokensById[id]) {
      setError(`--${cssName} already exists in ${scope}.`);
      return;
    }
    const nextValue = value.trim();
    if (nextValue.length === 0) {
      setError("Add a token value before creating it.");
      return;
    }
    const token = {
      category: tokenCategoryForGroup(group.kind),
      cssName,
      groupId: group.id,
      id,
      initialValue: nextValue,
      label: toLabel(cssName),
      scope,
    };
    onAddToken(token, nextValue);
    setName(defaultTokenName(group));
    setValue(defaultTokenValue(group.kind));
    setError(null);
    setIsOpen(false);
  };

  return (
    <Collapsible
      className="group rounded-md border bg-muted/20"
      onOpenChange={setIsOpen}
      open={isOpen}
    >
      <CollapsibleTrigger asChild>
        <Button
          className="style-lab-control h-auto w-full justify-between rounded-none px-3 py-2 text-left font-medium text-sm"
          type="button"
          variant="ghost"
        >
          <span className="flex min-w-0 items-center gap-2">
            <PlusIcon />
            Add new token
          </span>
          <ChevronDownIcon className="size-4 transition-transform group-data-[state=open]:rotate-180" />
        </Button>
      </CollapsibleTrigger>
      <CollapsibleContent>
        <div className="grid gap-3 border-t bg-background p-3">
          <p className="text-muted-foreground text-xs">
            Creates a canvas specimen in {group.label} and exports an add
            operation for that group.
          </p>
          <div className="grid gap-2">
            <Label htmlFor="new-token-name">Name</Label>
            <Input
              className="style-lab-control"
              id="new-token-name"
              onChange={(event) => setName(event.target.value)}
              value={name}
            />
          </div>
          <div className="grid gap-2">
            <Label htmlFor="new-token-scope">Scope</Label>
            <Select
              onValueChange={(nextScope) =>
                setScope(parseStyleTokenScope(nextScope))
              }
              value={scope}
            >
              <SelectTrigger
                className="style-lab-control w-full"
                id="new-token-scope"
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={StyleTokenScope.Root}>:root</SelectItem>
                <SelectItem value={StyleTokenScope.Theme}>
                  @theme inline
                </SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="grid gap-2">
            <Label htmlFor="new-token-value">Value</Label>
            <Textarea
              className="style-lab-control min-h-16 resize-none text-sm"
              id="new-token-value"
              onChange={(event) => setValue(event.target.value)}
              value={value}
            />
          </div>
          {tokenCategoryForGroup(group.kind) === TokenCategory.Color ? (
            <ColorValueTools onSelectValue={setValue} />
          ) : null}
          {error ? <p className="text-destructive text-xs">{error}</p> : null}
          <Button
            className="style-lab-control w-full"
            onClick={submitToken}
            type="button"
            variant="outline"
          >
            <PlusIcon />
            Add to {group.label}
          </Button>
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}

export function ColorValueTools({
  onSelectValue,
}: {
  onSelectValue: (value: string) => void;
}) {
  const [isOpen, setIsOpen] = useState(false);
  return (
    <Collapsible
      className="group rounded-md border bg-muted/20"
      onOpenChange={setIsOpen}
      open={isOpen}
    >
      <CollapsibleTrigger asChild>
        <Button
          className="style-lab-control h-auto w-full justify-between rounded-none px-3 py-2 text-left font-medium text-sm"
          type="button"
          variant="ghost"
        >
          <span className="flex min-w-0 items-center gap-2">
            <PaletteIcon />
            Set color
          </span>
          <ChevronDownIcon className="size-4 transition-transform group-data-[state=open]:rotate-180" />
        </Button>
      </CollapsibleTrigger>
      <CollapsibleContent>
        <div className="border-t bg-background p-3">
          <ColorPaletteSelector onSelectValue={onSelectValue} />
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}

function defaultTokenName(group: StyleTaxonomyGroup): string {
  return `${group.id}-token`;
}

function defaultTokenValue(kind: StyleTaxonomyGroupKind): string {
  switch (kind) {
    case StyleTaxonomyGroupKind.Asset:
    case StyleTaxonomyGroupKind.Catalog:
    case StyleTaxonomyGroupKind.Color:
    case StyleTaxonomyGroupKind.Logo:
    case StyleTaxonomyGroupKind.Reconciliation:
      return "oklch(0.62 0.18 267)";
    case StyleTaxonomyGroupKind.Grid:
    case StyleTaxonomyGroupKind.Layout:
      return "1rem";
    case StyleTaxonomyGroupKind.Icon:
      return "1.25rem";
    case StyleTaxonomyGroupKind.Shape:
      return "0.75rem";
    case StyleTaxonomyGroupKind.Type:
      return "1rem";
    default: {
      const exhaustiveCheck: never = kind;
      return exhaustiveCheck;
    }
  }
}

function tokenCategoryForGroup(kind: StyleTaxonomyGroupKind): TokenCategory {
  switch (kind) {
    case StyleTaxonomyGroupKind.Asset:
    case StyleTaxonomyGroupKind.Catalog:
    case StyleTaxonomyGroupKind.Color:
    case StyleTaxonomyGroupKind.Logo:
    case StyleTaxonomyGroupKind.Reconciliation:
      return TokenCategory.Color;
    case StyleTaxonomyGroupKind.Grid:
    case StyleTaxonomyGroupKind.Layout:
      return TokenCategory.Layout;
    case StyleTaxonomyGroupKind.Icon:
      return TokenCategory.Icon;
    case StyleTaxonomyGroupKind.Shape:
      return TokenCategory.Shape;
    case StyleTaxonomyGroupKind.Type:
      return TokenCategory.Type;
    default: {
      const exhaustiveCheck: never = kind;
      return exhaustiveCheck;
    }
  }
}

function normalizeTokenName(value: string): string {
  return value
    .trim()
    .replace(leadingCssVariablePrefixPattern, "")
    .toLowerCase();
}

function parseStyleTokenScope(value: string): StyleTokenScope {
  if (value === StyleTokenScope.Theme) {
    return StyleTokenScope.Theme;
  }
  return StyleTokenScope.Root;
}

function toLabel(name: string): string {
  return name
    .split("-")
    .map((part) => {
      if (part === "ai") {
        return "AI";
      }
      return `${part.charAt(0).toUpperCase()}${part.slice(1)}`;
    })
    .join(" ");
}

const leadingCssVariablePrefixPattern = /^--/;
const tokenNamePattern = /^[a-z][a-z0-9-]*$/;
