const TRAILING_SLASH_REGEX = /\/$/;
const LEADING_DOT_REGEX = /^\./;
const DEFAULT_PREVIEW_SUFFIX = "preview.closedloop-stage.ai";
const LOCALHOST_ORIGIN_REGEX = /^http:\/\/localhost:\d+$/;

function getAllowedOrigins(): Set<string> {
  const origins = new Set<string>(["http://localhost:3000"]);

  const appUrl = process.env.NEXT_PUBLIC_APP_URL;
  if (appUrl) {
    origins.add(appUrl);
    origins.add(appUrl.replace(TRAILING_SLASH_REGEX, ""));
  }

  const webUrl = process.env.NEXT_PUBLIC_WEB_URL;
  if (webUrl) {
    origins.add(webUrl);
    origins.add(webUrl.replace(TRAILING_SLASH_REGEX, ""));
  }

  return origins;
}

function getPreviewSuffix(): string | null {
  const suffix =
    process.env.NEXT_PUBLIC_PREVIEW_DOMAIN ??
    process.env.PREVIEW_DOMAIN ??
    DEFAULT_PREVIEW_SUFFIX;
  const normalized = suffix.replace(LEADING_DOT_REGEX, "").trim().toLowerCase();
  return normalized.length > 0 ? normalized : null;
}

export function isTrustedOrigin(origin: string | null): boolean {
  if (!origin) {
    return false;
  }

  let parsedOrigin: URL;
  try {
    parsedOrigin = new URL(origin);
  } catch {
    return false;
  }

  if (parsedOrigin.origin !== origin) {
    return false;
  }

  const normalizedOrigin = parsedOrigin.origin;
  const hostname = parsedOrigin.hostname.toLowerCase();

  if (getAllowedOrigins().has(normalizedOrigin)) {
    return true;
  }

  if (
    process.env.NODE_ENV !== "production" &&
    LOCALHOST_ORIGIN_REGEX.test(normalizedOrigin)
  ) {
    return true;
  }

  const suffix = getPreviewSuffix();
  if (suffix && (hostname === suffix || hostname.endsWith(`.${suffix}`))) {
    return true;
  }

  return false;
}
