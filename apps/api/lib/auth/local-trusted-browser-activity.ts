import type { BrowserSessionActivity } from "@repo/api/src/types/browser-session";

/**
 * ISS-12135: the device facts a local-trusted vibe session can substantiate
 * about itself, read from the request's own `User-Agent`, in the raw shape
 * Clerk's `latestActivity` uses (`deviceType` is the UA platform token such as
 * `Macintosh`, not a curated class). There is no provider to ask for a city or
 * country, so those stay absent. Every field the header does not carry is
 * omitted, per `BrowserSessionActivity`.
 */
export function browserActivityFromUserAgent(
  userAgent: string | undefined
): BrowserSessionActivity | null {
  const header = userAgent?.trim();
  if (!header) {
    return null;
  }
  const deviceType = PLATFORM_TOKEN.exec(header)?.[1]?.trim();
  const browser = BROWSER_PATTERNS.map(({ name, pattern }) => {
    const version = pattern.exec(header)?.[1];
    return version ? { name, version } : null;
  }).find((match) => match !== null);
  return {
    ...(browser && {
      browserName: browser.name,
      browserVersion: browser.version,
    }),
    ...(deviceType && { deviceType }),
    isMobile: MOBILE_TOKEN.test(header),
  };
}

/** The first token of the first parenthesized group: `(Macintosh; Intel …)`. */
const PLATFORM_TOKEN = /\(([^;)]+)/;
const MOBILE_TOKEN = /Mobi/;

/**
 * Most specific first: Edge and Opera also carry `Chrome/`, and Chrome also
 * carries `Safari/`, so the first match is the browser that sent the header.
 */
const BROWSER_PATTERNS = [
  { name: "Edge", pattern: /Edg(?:e|A|iOS)?\/([\d.]+)/ },
  { name: "Opera", pattern: /OPR\/([\d.]+)/ },
  { name: "Firefox", pattern: /Firefox\/([\d.]+)/ },
  { name: "Chrome", pattern: /(?:Chrome|CriOS)\/([\d.]+)/ },
  { name: "Safari", pattern: /Version\/([\d.]+).*Safari\// },
] as const;
