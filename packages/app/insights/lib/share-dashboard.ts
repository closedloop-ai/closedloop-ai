import { fromBase64Url, toBase64Url } from "@repo/api/src/types/base64url";
import { z } from "zod";
import {
  gridPositionSchema,
  type SharedDashboard,
  tileSettingsSchema,
} from "./dashboard-schema";

/**
 * Query-string parameter carrying a shared Insights dashboard snapshot (pinned
 * tiles + grid layout + per-tile settings). Present only on links produced by
 * the Insights Share button while the `emergent` flag is on; absent otherwise.
 */
export const SHARE_DASHBOARD_PARAM = "dash";

// Compact wire shape for the shared snapshot. Keys are single letters so the
// serialized `?dash=` value stays short even for busy dashboards.
const sharedDashboardWireSchema = z.object({
  t: z.array(z.string()),
  l: z.record(z.string(), gridPositionSchema),
  s: z.record(z.string(), tileSettingsSchema).optional(),
});

/**
 * Serialize a dashboard snapshot into the compact, URL-safe token used by the
 * `?dash=` share param. base64url keeps the token opaque and free of characters
 * that would need extra escaping inside a query string.
 */
export function encodeSharedDashboard(snapshot: SharedDashboard): string {
  const payload = {
    t: snapshot.tiles,
    l: snapshot.layout,
    s: snapshot.settings,
  };
  return toBase64Url(JSON.stringify(payload));
}

/**
 * Reverse of {@link encodeSharedDashboard}. Returns `null` for any absent,
 * malformed, or schema-invalid token so callers fall back to the recipient's
 * own stored (or default) dashboard rather than throwing.
 */
export function decodeSharedDashboard(
  raw: string | null | undefined
): SharedDashboard | null {
  if (!raw) {
    return null;
  }
  const json = fromBase64Url(raw);
  if (json === null) {
    return null;
  }
  let value: unknown;
  try {
    value = JSON.parse(json);
  } catch {
    return null;
  }
  const parsed = sharedDashboardWireSchema.safeParse(value);
  if (!parsed.success) {
    return null;
  }
  return {
    tiles: parsed.data.t,
    layout: parsed.data.l,
    settings: parsed.data.s ?? {},
  };
}
