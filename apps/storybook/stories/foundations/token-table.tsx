"use client";

import { useEffect, useState } from "react";

/**
 * Foundations pages read their values back out of the DOM instead of restating
 * them, so this layer can never drift from `packages/design-system/styles/
 * globals.css`. A token that gets renamed or dropped shows up here as "not
 * set" rather than as a stale swatch that quietly lies to whoever is reading
 * the page.
 *
 * The read has to happen after mount: the values live on `:root` and change
 * with the light/dark class the theme decorator toggles, so they are not
 * knowable at module scope.
 */
export function useResolvedTokens(tokenNames: readonly string[]) {
  const [values, setValues] = useState<Record<string, string>>({});

  /**
   * Every caller passes a fresh array literal (`TOKENS.map(...)`), so depending
   * on the array's identity re-runs the effect on every render, and the
   * `setValues` inside it schedules the next render. That is an infinite loop:
   * it pegs the CPU on these pages in the browser and hangs the story sweep
   * before it can mount anything. Depend on the CONTENT instead, which is
   * stable across renders as long as the token list is.
   */
  const tokenKey = tokenNames.join(",");

  useEffect(() => {
    const names = tokenKey.length > 0 ? tokenKey.split(",") : [];

    const read = () => {
      const computed = getComputedStyle(document.documentElement);
      const next: Record<string, string> = {};
      for (const name of names) {
        next[name] = computed.getPropertyValue(`--${name}`).trim();
      }
      setValues(next);
    };

    read();

    // The theme decorator swaps a class on <html>, which re-resolves every
    // token without remounting this component. Watch for it so the readout
    // follows the toolbar instead of freezing on whatever loaded first.
    const observer = new MutationObserver(read);
    observer.observe(document.documentElement, {
      attributeFilter: ["class"],
      attributes: true,
    });
    return () => observer.disconnect();
  }, [tokenKey]);

  return values;
}

export function FoundationsPage({
  children,
  description,
  title,
}: Readonly<{
  children: React.ReactNode;
  description: string;
  title: string;
}>) {
  return (
    <div className="mx-auto flex max-w-6xl flex-col gap-10 p-6">
      <header className="space-y-2">
        <p className="font-medium text-muted-foreground text-sm uppercase tracking-[0.2em]">
          Foundations
        </p>
        <h1 className="font-semibold text-3xl tracking-tight">{title}</h1>
        <p className="max-w-3xl text-muted-foreground text-sm">{description}</p>
      </header>
      {children}
    </div>
  );
}

export function TokenSection({
  children,
  note,
  title,
}: Readonly<{
  children: React.ReactNode;
  note?: string;
  title: string;
}>) {
  return (
    <section className="space-y-4">
      <div className="space-y-1">
        <h2 className="font-semibold text-xl tracking-tight">{title}</h2>
        {note ? <p className="text-muted-foreground text-sm">{note}</p> : null}
      </div>
      {children}
    </section>
  );
}

export function ColorSwatchGrid({
  tokens,
}: Readonly<{ tokens: readonly string[] }>) {
  const values = useResolvedTokens(tokens);

  return (
    <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
      {tokens.map((token) => {
        const value = values[token];
        return (
          <div
            className="flex items-center gap-3 rounded-lg border bg-card p-3"
            key={token}
          >
            <div
              className="size-12 shrink-0 rounded-md border"
              style={{ background: `var(--${token})` }}
            />
            <div className="min-w-0 space-y-0.5">
              <p className="truncate font-medium text-sm">--{token}</p>
              <p className="truncate font-mono text-muted-foreground text-xs">
                {value || "not set"}
              </p>
            </div>
          </div>
        );
      })}
    </div>
  );
}

/** A token rendered as text on its paired surface, for foreground pairs. */
export function ColorPairGrid({
  pairs,
}: Readonly<{
  pairs: readonly { readonly bg: string; readonly fg: string }[];
}>) {
  return (
    <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
      {pairs.map(({ bg, fg }) => (
        <div className="overflow-hidden rounded-lg border" key={bg}>
          <div
            className="flex h-20 items-center justify-center px-3 text-center font-medium text-sm"
            style={{
              background: `var(--${bg})`,
              color: `var(--${fg})`,
            }}
          >
            The quick brown fox
          </div>
          <div className="space-y-0.5 bg-card p-3">
            <p className="truncate font-mono text-xs">--{bg}</p>
            <p className="truncate font-mono text-muted-foreground text-xs">
              on --{fg}
            </p>
          </div>
        </div>
      ))}
    </div>
  );
}
