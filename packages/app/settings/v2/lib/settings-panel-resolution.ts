/**
 * @file settings-panel-resolution.ts
 * @description Turns a requested panel plus the host and the actor's capability
 * projection into exactly one of six DISTINCT outcomes (ISS-8362 AC1). The
 * point of this module is what it refuses to collapse: an unrecognised link, a
 * panel this host does not offer, a denial, a capability read still in flight,
 * and a capability read that FAILED are five different facts, and PRD-692
 * forbids folding any of them into another. A failed or pending read never
 * becomes a denial, and never becomes an authorization.
 *
 * `fallbackPanelId` is what keeps a bad deep link from blanking Settings: it
 * names a panel this actor really can open, so the surface can offer a way
 * forward instead of an empty frame.
 */
import { LOCALLY_AUTHORITATIVE_SETTINGS_PANEL_IDS } from "@repo/api/src/types/settings-domain";
import {
  DEFAULT_SETTINGS_PANEL_ID,
  isSettingsPanelId,
  SETTINGS_PANEL_IDS,
  type SettingsActorCapabilities,
  SettingsActorCapabilityStatus,
  type SettingsPanelHost,
  type SettingsPanelId,
  SettingsPanelResolutionStatus,
} from "@repo/api/src/types/settings-panel";
import type { SettingsPanelRegistry } from "./settings-panel-registry";

export type SettingsPanelResolution = {
  status: SettingsPanelResolutionStatus;
  /** Raw value the link asked for; null when it named no panel. */
  requestedPanel: string | null;
  /** The request when it is a known id, else null. */
  requestedPanelId: SettingsPanelId | null;
  /**
   * The known panel this outcome is ABOUT — the request, or the default when
   * the link named nothing. Null only when the link named something we do not
   * have. Settings names this panel in every non-ready screen, so a plain visit
   * that is denied says which panel was denied instead of "that panel".
   */
  evaluatedPanelId: SettingsPanelId | null;
  /** The body to mount. Non-null only when `status` is ready. */
  panelId: SettingsPanelId | null;
  /** A panel this actor can open, offered as recovery. Null when none can be. */
  fallbackPanelId: SettingsPanelId | null;
};

export type ResolveSettingsPanelInput = {
  registry: SettingsPanelRegistry;
  requestedPanel: string | null;
  host: SettingsPanelHost;
  capabilities: SettingsActorCapabilities;
};

export type SettingsPanelContext = Omit<
  ResolveSettingsPanelInput,
  "requestedPanel"
>;

/**
 * Precedence, highest first: unknown, unavailable, pending, capability-error,
 * forbidden, ready. Unknown and unavailable outrank the capability axis because
 * neither needs it — a panel that does not exist here cannot become reachable
 * by learning more about the actor. `unreadable` outranks `grants` for the
 * mirror-image reason: a stale grant must not paper over a read that failed.
 *
 * A panel no server is the authority on ({@link
 * LOCALLY_AUTHORITATIVE_SETTINGS_PANEL_IDS}) sits OFF the capability axis
 * entirely: the pending, capability-error and unreadable rungs are skipped for
 * it, and an absent grant is not a denial. See the comment at that branch.
 */
export function evaluateSettingsPanelStatus(
  id: SettingsPanelId,
  context: SettingsPanelContext
): SettingsPanelResolutionStatus {
  const descriptor = context.registry.get(id);
  if (descriptor === undefined) {
    return SettingsPanelResolutionStatus.Unknown;
  }
  if (!descriptor.hosts.includes(context.host)) {
    return SettingsPanelResolutionStatus.Unavailable;
  }
  // A PANEL NO SERVER ANSWERS FOR IS OFF THIS AXIS (ISS-10286). Its controls
  // read and write the local Electron main process on the machine the actor is
  // sitting at, so `GET /settings/view-model` can neither grant nor withhold
  // them, and its state — in flight, failed, or unreadable — says nothing about
  // whether this panel may open.
  //
  // THE DEFAULT GUEST DESKTOP IS OFFLINE (operator ruling, 2026-09-17), and
  // that is what makes this load-bearing rather than tidy: with no cloud
  // session and no network the view-model read FAILS, which used to give every
  // panel `capability-error` — so the user with no other way to reach Auth
  // Mode, the sandbox root or the CLI paths got an error screen instead of the
  // controls. Waiting or retrying could never change the answer, so rendering
  // the panel is the honest state, not an optimistic one.
  const locallyAuthoritative =
    LOCALLY_AUTHORITATIVE_SETTINGS_PANEL_IDS.includes(id);
  if (!locallyAuthoritative) {
    if (context.capabilities.status === SettingsActorCapabilityStatus.Pending) {
      return SettingsPanelResolutionStatus.Pending;
    }
    if (context.capabilities.status === SettingsActorCapabilityStatus.Error) {
      return SettingsPanelResolutionStatus.CapabilityError;
    }
    if (context.capabilities.unreadable?.includes(id)) {
      return SettingsPanelResolutionStatus.CapabilityError;
    }
  }
  const grants = context.capabilities.grants?.[id];
  // VERSION SKEW, not a denial (davetho #4038745930). `apps/api` and the
  // Desktop build deploy separately, so a settled view-model response written
  // before a panel existed simply has no entry for it — the API is older, never
  // that access was withheld. Scoped to an ABSENT entry: a present grant set
  // that withholds the capability is an answer, and is honoured even here.
  if (grants === undefined && locallyAuthoritative) {
    return SettingsPanelResolutionStatus.Ready;
  }
  return (grants ?? []).includes(descriptor.requiredCapability)
    ? SettingsPanelResolutionStatus.Ready
    : SettingsPanelResolutionStatus.Forbidden;
}

function findFallbackPanelId(
  context: SettingsPanelContext
): SettingsPanelId | null {
  const candidates: readonly SettingsPanelId[] = [
    DEFAULT_SETTINGS_PANEL_ID,
    ...SETTINGS_PANEL_IDS,
  ];
  return (
    candidates.find(
      (id) =>
        evaluateSettingsPanelStatus(id, context) ===
        SettingsPanelResolutionStatus.Ready
    ) ?? null
  );
}

export function resolveSettingsPanel(
  input: ResolveSettingsPanelInput
): SettingsPanelResolution {
  const { requestedPanel, ...context } = input;
  const requestedPanelId = isSettingsPanelId(requestedPanel)
    ? requestedPanel
    : null;

  // A link that named nothing is a plain visit and asks for the default. A link
  // that named something we do not have is NOT, and keeps `requestedPanel` set
  // so Settings can say which link failed rather than quietly redirecting.
  if (requestedPanel !== null && requestedPanelId === null) {
    return {
      status: SettingsPanelResolutionStatus.Unknown,
      requestedPanel,
      requestedPanelId: null,
      evaluatedPanelId: null,
      panelId: null,
      fallbackPanelId: findFallbackPanelId(context),
    };
  }

  const targetId = requestedPanelId ?? resolvePlainVisitTarget(context);
  const status = evaluateSettingsPanelStatus(targetId, context);

  if (status === SettingsPanelResolutionStatus.Ready) {
    return {
      status,
      requestedPanel,
      requestedPanelId,
      evaluatedPanelId: targetId,
      panelId: targetId,
      fallbackPanelId: targetId,
    };
  }

  return {
    status,
    requestedPanel,
    requestedPanelId,
    evaluatedPanelId: targetId,
    panelId: null,
    fallbackPanelId: findFallbackPanelId(context),
  };
}

/**
 * Where a link that named NO panel lands (ISS-8370 D8).
 *
 * The default is Profile, which is web-only, so on desktop a plain `#/settings`
 * would open on "Profile isn't available here" — a denial screen shown to a
 * user who followed no link. When the default is unavailable on this host, the
 * target is the first id in contract navigation order the host offers, and
 * that panel is then evaluated exactly as the default would have been: a
 * pending or failed capability read, or a denial, still reports itself. A link
 * that NAMES Profile on desktop is not a plain visit and keeps the unavailable
 * screen, because it asked. A host with nothing on offer keeps the default.
 */
function resolvePlainVisitTarget(
  context: SettingsPanelContext
): SettingsPanelId {
  if (
    evaluateSettingsPanelStatus(DEFAULT_SETTINGS_PANEL_ID, context) !==
    SettingsPanelResolutionStatus.Unavailable
  ) {
    return DEFAULT_SETTINGS_PANEL_ID;
  }
  return (
    SETTINGS_PANEL_IDS.find((id) =>
      context.registry.get(id)?.hosts.includes(context.host)
    ) ?? DEFAULT_SETTINGS_PANEL_ID
  );
}
