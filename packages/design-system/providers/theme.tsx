"use client";

import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";

const COLOR_SCHEME_THEMES = new Set(["dark", "light"]);
const DEFAULT_THEMES = ["light", "dark"];
const THEME_MEDIA_QUERY = "(prefers-color-scheme: dark)";

type SetTheme = (theme: string | ((theme: string) => string)) => void;

type ThemeContextValue = {
  forcedTheme?: string;
  resolvedTheme?: string;
  setTheme: SetTheme;
  systemTheme?: string;
  theme?: string;
  themes: string[];
};

export type ThemeProviderProperties = {
  attribute?: string | string[];
  children: ReactNode;
  defaultTheme?: string;
  disableTransitionOnChange?: boolean;
  enableColorScheme?: boolean;
  enableSystem?: boolean;
  forcedTheme?: string;
  nonce?: string;
  scriptProps?: Record<string, unknown>;
  storageKey?: string;
  themes?: string[];
  value?: Record<string, string>;
};

const DEFAULT_THEME_CONTEXT: ThemeContextValue = {
  setTheme: () => {},
  themes: [],
};

const ThemeContext = createContext<ThemeContextValue | undefined>(undefined);

function getSystemTheme() {
  if (typeof globalThis.matchMedia !== "function") {
    return "light";
  }
  return globalThis.matchMedia(THEME_MEDIA_QUERY).matches ? "dark" : "light";
}

function getStoredTheme(storageKey: string) {
  try {
    return globalThis.localStorage?.getItem(storageKey) ?? undefined;
  } catch {
    return undefined;
  }
}

function setStoredTheme(storageKey: string, theme: string) {
  try {
    globalThis.localStorage?.setItem(storageKey, theme);
  } catch {
    // Storage can be unavailable in private windows, tests, or sandboxed frames.
  }
}

function disableTransitions(nonce?: string) {
  if (typeof globalThis.document === "undefined") {
    return () => {};
  }

  const style = globalThis.document.createElement("style");
  if (nonce) {
    style.setAttribute("nonce", nonce);
  }
  style.appendChild(
    globalThis.document.createTextNode(
      "*,*::before,*::after{transition:none!important}"
    )
  );
  globalThis.document.head.appendChild(style);

  return () => {
    globalThis.getComputedStyle(globalThis.document.body);
    globalThis.setTimeout(() => style.remove(), 1);
  };
}

function getThemeAttributeValue(
  theme: string,
  value: Record<string, string> | undefined
) {
  return value?.[theme] ?? theme;
}

function getThemeValuesToRemove(
  themes: string[],
  value: Record<string, string> | undefined
) {
  const values = new Set([...DEFAULT_THEMES, ...themes]);
  for (const mappedValue of Object.values(value ?? {})) {
    values.add(mappedValue);
  }
  return [...values];
}

function applyTheme({
  attribute,
  disableTransitionOnChange,
  enableColorScheme,
  nonce,
  theme,
  themes,
  value,
}: {
  attribute: string | string[];
  disableTransitionOnChange: boolean;
  enableColorScheme: boolean;
  nonce?: string;
  theme: string | undefined;
  themes: string[];
  value?: Record<string, string>;
}) {
  if (typeof globalThis.document === "undefined") {
    return;
  }

  const restoreTransitions = disableTransitionOnChange
    ? disableTransitions(nonce)
    : undefined;
  const root = globalThis.document.documentElement;
  const attributes = Array.isArray(attribute) ? attribute : [attribute];
  const themeValue = theme ? getThemeAttributeValue(theme, value) : undefined;
  const valuesToRemove = getThemeValuesToRemove(themes, value);

  for (const name of attributes) {
    if (name === "class") {
      root.classList.remove(...valuesToRemove);
      if (themeValue) {
        root.classList.add(...themeValue.split(" "));
      }
      continue;
    }

    if (themeValue) {
      root.setAttribute(name, themeValue);
    } else {
      root.removeAttribute(name);
    }
  }

  if (enableColorScheme && theme && COLOR_SCHEME_THEMES.has(theme)) {
    root.style.colorScheme = theme;
  } else {
    root.style.removeProperty("color-scheme");
  }

  restoreTransitions?.();
}

export function ThemeProvider({
  attribute = "class",
  children,
  defaultTheme,
  disableTransitionOnChange = false,
  enableColorScheme = true,
  enableSystem = true,
  forcedTheme,
  nonce,
  scriptProps: _scriptProps,
  storageKey = "theme",
  themes = DEFAULT_THEMES,
  value,
}: ThemeProviderProperties) {
  const fallbackTheme = defaultTheme ?? (enableSystem ? "system" : "light");
  const [theme, setThemeState] = useState(fallbackTheme);
  const [systemTheme, setSystemTheme] = useState<string>();

  useEffect(() => {
    setThemeState(getStoredTheme(storageKey) ?? fallbackTheme);
  }, [fallbackTheme, storageKey]);

  useEffect(() => {
    setSystemTheme(getSystemTheme());
    if (typeof globalThis.matchMedia !== "function") {
      return;
    }

    const media = globalThis.matchMedia(THEME_MEDIA_QUERY);
    const handleChange = () => setSystemTheme(getSystemTheme());
    media.addEventListener("change", handleChange);
    return () => media.removeEventListener("change", handleChange);
  }, []);

  const setTheme = useCallback<SetTheme>(
    (nextTheme) => {
      setThemeState((currentTheme) => {
        const themeValue =
          typeof nextTheme === "function" ? nextTheme(currentTheme) : nextTheme;
        setStoredTheme(storageKey, themeValue);
        return themeValue;
      });
    },
    [storageKey]
  );

  const activeTheme = forcedTheme ?? theme;
  const resolvedTheme =
    activeTheme === "system" && enableSystem ? systemTheme : activeTheme;

  useEffect(() => {
    applyTheme({
      attribute,
      disableTransitionOnChange,
      enableColorScheme,
      nonce,
      theme: resolvedTheme,
      themes,
      value,
    });
  }, [
    attribute,
    disableTransitionOnChange,
    enableColorScheme,
    nonce,
    resolvedTheme,
    themes,
    value,
  ]);

  const contextValue = useMemo<ThemeContextValue>(
    () => ({
      forcedTheme,
      resolvedTheme,
      setTheme,
      systemTheme,
      theme,
      themes: enableSystem ? [...themes, "system"] : themes,
    }),
    [
      enableSystem,
      forcedTheme,
      resolvedTheme,
      setTheme,
      systemTheme,
      theme,
      themes,
    ]
  );

  return (
    <ThemeContext.Provider value={contextValue}>
      {children}
    </ThemeContext.Provider>
  );
}

export function useTheme() {
  return useContext(ThemeContext) ?? DEFAULT_THEME_CONTEXT;
}
