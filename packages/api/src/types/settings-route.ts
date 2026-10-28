/**
 * @file settings-route.ts
 * @description The zod half of the Settings v2 deep-link contract: turning an
 * untrusted search-parameter bag into typed route state. The builders, the
 * params shape, and the in-app path guard live in the zod-free
 * `./settings-route-links.ts`, and the vocabulary in `./settings-panel.ts`.
 *
 * `parseSettingsRouteParams` never throws and never guesses. An ABSENT panel
 * and an UNRECOGNIZED panel are returned as different facts (`requestedPanel`
 * distinguishes them) because Settings renders them differently: the first is a
 * plain visit, the second is a link that named something we do not have. A
 * RETIRED id is neither: it is read as its successor
 * (`RETIRED_SETTINGS_PANEL_SUCCESSOR`), so the link opens the panel that now
 * owns its subject.
 */
import { z } from "zod";
import {
  DEFAULT_SETTINGS_PANEL_INTENT,
  isSettingsPanelId,
  resolveRetiredSettingsPanelId,
  SETTINGS_INTENT_PARAM,
  SETTINGS_PANEL_PARAM,
  SETTINGS_RETURN_TO_PARAM,
  type SettingsPanelIntent,
  SettingsPanelIntent as SettingsPanelIntentValues,
} from "./settings-panel.ts";
import {
  isInternalReturnTo,
  type SettingsRouteParams,
} from "./settings-route-links.ts";

const searchParamValueSchema = z
  .union([z.string(), z.array(z.string())])
  .optional();

function firstParamValue(raw: string | readonly string[]): string | null {
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length === 0 ? null : trimmed;
}

/**
 * Each key is validated on its OWN, so a malformed `returnTo` cannot discard a
 * perfectly good `panel`: one field's failure would otherwise collapse the
 * whole link into "named nothing", which is a different fact that Settings
 * renders differently. Own properties only, so a crafted `__proto__` key in a
 * deserialized bag cannot serve an inherited value as if the link carried it.
 */
function readParam(bag: unknown, key: string): string | null {
  if (typeof bag !== "object" || bag === null) {
    return null;
  }
  const parsed = searchParamValueSchema.safeParse(
    Object.getOwnPropertyDescriptor(bag, key)?.value
  );
  if (!(parsed.success && parsed.data !== undefined)) {
    return null;
  }
  return firstParamValue(parsed.data);
}

/**
 * `URLSearchParams` — and Next's `ReadonlyURLSearchParams`, which extends it —
 * keeps its values in internal slots, so it passes the `typeof === "object"`
 * check and then yields NOTHING to an own-property read. Left unhandled, the
 * most natural call in the app (`parseSettingsRouteParams(useSearchParams())`)
 * reads every parameter as absent and renders the default panel, silently, with
 * no error to notice: a deep link that named a panel becomes "the link named
 * nothing", which is precisely the distinction this parser exists to keep.
 *
 * `getAll` rather than an entries spread, so a repeated key keeps its list and
 * takes the same first-value path a plain array-valued bag takes.
 */
function toParamBag(raw: unknown): unknown {
  if (!(raw instanceof URLSearchParams)) {
    return raw;
  }
  const bag: Record<string, readonly string[]> = Object.create(null);
  for (const key of new Set(raw.keys())) {
    bag[key] = raw.getAll(key);
  }
  return bag;
}

export function parseSettingsRouteParams(input: unknown): SettingsRouteParams {
  const raw = toParamBag(input);
  const rawPanel = readParam(raw, SETTINGS_PANEL_PARAM);
  // The successor replaces `requestedPanel` too, not only `panel`: the shell
  // resolves from `requestedPanel`, so a retired id left there would still
  // render as an unknown panel.
  const requestedPanel =
    rawPanel === null ? null : resolveRetiredSettingsPanelId(rawPanel);
  const requestedIntent = readParam(raw, SETTINGS_INTENT_PARAM);
  const requestedReturnTo = readParam(raw, SETTINGS_RETURN_TO_PARAM);

  const intentIsKnown =
    requestedIntent !== null &&
    (Object.values(SettingsPanelIntentValues) as string[]).includes(
      requestedIntent
    );

  return {
    panel: isSettingsPanelId(requestedPanel) ? requestedPanel : null,
    requestedPanel,
    intent: intentIsKnown
      ? (requestedIntent as SettingsPanelIntent)
      : DEFAULT_SETTINGS_PANEL_INTENT,
    returnTo:
      requestedReturnTo !== null && isInternalReturnTo(requestedReturnTo)
        ? requestedReturnTo
        : null,
  };
}
