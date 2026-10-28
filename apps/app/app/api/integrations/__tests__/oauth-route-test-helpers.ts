/**
 * Shared helpers for the OAuth init/callback route tests under
 * `app/api/integrations/*`. Both provider suites clear the same cookies on the
 * same paths, so the Set-Cookie reader lives here rather than once per file.
 */

const COOKIE_ATTRIBUTE_SEPARATOR = "; ";

/**
 * One Set-Cookie entry, reduced to what a route test needs to tell a cleared
 * cookie from a live one.
 *
 * `expired` is derived rather than exposed as a raw attribute because a
 * deletion is equally valid as `Max-Age=0` or as an `Expires` in the past, and
 * a test should not break when the framework switches spelling.
 */
export type SetCookieState = {
  expired: boolean;
  path: string | null;
  value: string;
};

/**
 * Read one named cookie off a response, or null when it was never set.
 *
 * `headers.get("set-cookie")` folds every entry into one comma-joined string,
 * so a substring check against it cannot tell `name=value` (a live cookie)
 * from `name=` (a cleared one) — the assertion passes either way. Splitting the
 * entries and parsing the attributes is what makes "this cookie was cleared"
 * a claim that can fail.
 */
export function readSetCookie(
  response: Response,
  name: string
): SetCookieState | null {
  const entry = setCookieEntries(response).find((candidate) =>
    candidate.startsWith(`${name}=`)
  );
  if (!entry) {
    return null;
  }

  const [pair, ...attributes] = entry.split(COOKIE_ATTRIBUTE_SEPARATOR);
  const value = pair.slice(name.length + 1);
  const maxAge = attributeValue(attributes, "Max-Age");
  const expires = attributeValue(attributes, "Expires");
  const expiresAtMs = expires === null ? Number.NaN : Date.parse(expires);

  return {
    expired: maxAge === "0" || expiresAtMs <= 0,
    path: attributeValue(attributes, "Path"),
    value,
  };
}

function setCookieEntries(response: Response): string[] {
  const headers = response.headers as Headers & {
    getSetCookie?: () => string[];
  };
  return headers.getSetCookie?.() ?? [];
}

function attributeValue(attributes: string[], name: string): string | null {
  const prefix = `${name.toLowerCase()}=`;
  const match = attributes.find((attribute) =>
    attribute.toLowerCase().startsWith(prefix)
  );
  return match ? match.slice(prefix.length) : null;
}
