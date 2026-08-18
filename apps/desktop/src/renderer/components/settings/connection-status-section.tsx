import { Section } from "@closedloop-ai/design-system/components/ui/layout/section";
import { z } from "zod";
import type { CloudSyncBacklog } from "../../../shared/cloud-read-readiness-contract";
import { ConnectionSecurityMode } from "../../../shared/connection-security";
import type {
  CloudStatus,
  CloudSyncProgress,
  CloudSyncStatusTone,
} from "../../hooks/use-ingest-progress";
import {
  CloudStatusKind,
  describeCloudSyncStatus,
} from "../../hooks/use-ingest-progress";

type ConnectionStatusSectionProps = {
  cloudConnectionEnabled: boolean | null;
  cloudStatus: CloudStatus | null;
  cloudSyncProgress: CloudSyncProgress | null;
  /**
   * ISS-5768: the whole-app, all-lanes backlog. Required, because it — not
   * `cloudSyncProgress.caughtUp`, which is one of five lanes — is what decides
   * whether the History Sync cell may claim "Up to date".
   */
  cloudSyncBacklog: CloudSyncBacklog;
  /**
   * ISS-5310 (stage cid 3726701537): the gateway health signals behind the
   * Connected / Needs Attention / Offline rollup. `serverAlive` is reachability
   * (is the local gateway server listening); `gatewayHealthy` is health (has
   * recovery/liveness confirmed it). Both `unknown` because they arrive from the
   * untyped `getRuntimeStatus()` IPC record, like `gatewayPort` and `security`.
   */
  gatewayHealthy: unknown;
  gatewayPort: unknown;
  remoteCommandsPaused: boolean;
  /**
   * The gateway's `connectionSecurity` status object.
   *
   * ISS-5310: this cell used to be fed `runtimeStatus.security`, a field
   * `GetRuntimeStatus` has never returned — so it rendered the "..." placeholder
   * permanently while the real value sat on `connectionSecurity`, shown only by
   * the Labs Gateway Health card. Folding that card in here (stage cid
   * 3726701537) would otherwise have deleted the one surface that displayed it.
   */
  security: unknown;
  serverAlive: unknown;
};

const CloudConnectionTone = {
  Danger: "danger",
  Muted: "muted",
  Success: "success",
} as const;

type CloudConnectionTone =
  (typeof CloudConnectionTone)[keyof typeof CloudConnectionTone];

const CLOUD_CONNECTION_TONE_CLASS: Record<CloudConnectionTone, string> = {
  danger: "text-[var(--destructive)]",
  muted: "text-[var(--muted-foreground)]",
  success: "text-[var(--success)]",
};

const CLOUD_SYNC_TONE_CLASS: Record<CloudSyncStatusTone, string> = {
  pending: "text-[var(--warning)]",
  success: "text-[var(--success)]",
  warning: "text-[var(--warning)]",
  muted: "text-[var(--muted-foreground)]",
};

export function ConnectionStatusSection({
  cloudConnectionEnabled,
  cloudStatus,
  cloudSyncBacklog,
  cloudSyncProgress,
  gatewayHealthy,
  gatewayPort,
  remoteCommandsPaused,
  security,
  serverAlive,
}: ConnectionStatusSectionProps) {
  const cloudConnection = describeCloudConnectionStatus(
    cloudConnectionEnabled,
    cloudStatus
  );
  const cloudSyncStatus = describeCloudSyncStatus(
    cloudSyncProgress,
    cloudSyncBacklog
  );
  const gatewayHealth = describeGatewayHealth(gatewayHealthy, serverAlive);

  return (
    <Section
      description="A live snapshot of the gateway's health and port, the cloud link, remote-command state, and security mode. Check here to confirm the desktop is reachable when remote sessions won't connect."
      title="Connection Status"
    >
      <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-6">
        {/* ISS-5310 (stage cid 3726701537): the Connected / Needs Attention /
            Offline rollup, moved here from Settings → Labs. It is not an
            experiment, and behind a gate that ships off it was invisible to
            exactly the person who needs it — someone whose desktop will not
            connect. It sits first because it is the headline the rest of this
            row qualifies. */}
        <div>
          <p className="text-[var(--muted-foreground)] text-xs">Gateway</p>
          <p
            className="flex items-center gap-1.5 font-semibold text-sm"
            title={gatewayHealth.detail}
          >
            {/* The tone rides a decorative dot rather than the label, because
                --success / --warning / --destructive are fill colors: as text on
                this card they measure 3.18 / 1.71 / 3.91, all under WCAG 1.4.3's
                4.5:1 for normal text. The label keeps the card foreground
                (16.24:1) and already names the state in words, so the dot is
                purely redundant and stays out of the accessibility tree. */}
            <span
              aria-hidden="true"
              className={`size-2 shrink-0 rounded-full ${GATEWAY_HEALTH_TONE_CLASS[gatewayHealth.tone]}`}
            />
            {gatewayHealth.label}
          </p>
        </div>
        <div>
          <p className="text-[var(--muted-foreground)] text-xs">Gateway Port</p>
          <p className="font-semibold text-sm">
            {formatRuntimeStatusValue(gatewayPort)}
          </p>
        </div>
        <div>
          <p className="text-[var(--muted-foreground)] text-xs">
            Cloud Connection
          </p>
          <p
            className={`font-semibold text-sm ${CLOUD_CONNECTION_TONE_CLASS[cloudConnection.tone]}`}
            title={cloudConnection.detail}
          >
            {cloudConnection.label}
          </p>
          {cloudConnection.reason ? (
            <p className="mt-1 text-[var(--destructive)] text-xs">
              {cloudConnection.reason}
            </p>
          ) : null}
        </div>
        <div>
          <p className="text-[var(--muted-foreground)] text-xs">
            Remote Commands
          </p>
          <p
            className={`font-semibold text-sm ${remoteCommandsPaused ? "text-[var(--warning)]" : "text-[var(--success)]"}`}
          >
            {remoteCommandsPaused ? "Paused" : "Active"}
          </p>
        </div>
        <div>
          <p className="text-[var(--muted-foreground)] text-xs">Security</p>
          <p className="font-semibold text-sm">
            {formatConnectionSecurityValue(security)}
          </p>
        </div>
        <div>
          <p className="text-[var(--muted-foreground)] text-xs">History Sync</p>
          <p
            className={`font-semibold text-sm ${CLOUD_SYNC_TONE_CLASS[cloudSyncStatus.tone]}`}
            title={cloudSyncStatus.detail}
          >
            {cloudSyncStatus.label}
          </p>
        </div>
      </div>
    </Section>
  );
}

type CloudConnectionDescription = {
  detail: string;
  label: string;
  reason?: string;
  tone: CloudConnectionTone;
};

function describeCloudConnectionStatus(
  connectionEnabled: boolean | null,
  cloudStatus: CloudStatus | null
): CloudConnectionDescription {
  if (connectionEnabled === false) {
    return {
      detail: "Cloud relay connections are disabled in Desktop settings.",
      label: "Disabled",
      tone: CloudConnectionTone.Muted,
    };
  }
  if (cloudStatus?.kind === CloudStatusKind.Online) {
    return {
      detail: "The desktop cloud socket is connected.",
      label: "Connected",
      tone: CloudConnectionTone.Success,
    };
  }
  if (cloudStatus?.kind === CloudStatusKind.Degraded) {
    return {
      detail: cloudStatus.error,
      label: "Connection failed",
      reason: cloudStatus.error,
      tone: CloudConnectionTone.Danger,
    };
  }
  if (cloudStatus?.kind === CloudStatusKind.Unknown) {
    return {
      detail: "The desktop reported an unrecognized cloud socket status.",
      label: "Unknown",
      tone: CloudConnectionTone.Muted,
    };
  }
  if (cloudStatus === null) {
    return {
      detail: "Live cloud socket status is unavailable.",
      label: "Status unavailable",
      tone: CloudConnectionTone.Muted,
    };
  }
  return {
    detail:
      connectionEnabled === true
        ? "The cloud connection is enabled, but the socket is idle."
        : "The cloud socket is idle.",
    label: "Idle",
    tone: CloudConnectionTone.Muted,
  };
}

/** What every cell here shows when the gateway has not reported a value. */
const UNKNOWN_STATUS_VALUE = "...";

const gatewayPortSchema = z.number().int().min(1).max(65_535);

/**
 * ISS-5310 — port validation carried over from the Labs Gateway Health card
 * this section absorbed (stage cid 3726701537). The generic formatter that used
 * to feed this cell printed any finite number and any non-empty string, so a
 * `0`, a `65536`, or a stringified port would have been rendered as if the
 * gateway were really listening there. An unusable port is not a port; say
 * nothing rather than say something false.
 */
function formatRuntimeStatusValue(value: unknown): string {
  const parsed = gatewayPortSchema.safeParse(value);
  return parsed.success ? parsed.data.toString() : UNKNOWN_STATUS_VALUE;
}

const connectionSecuritySchema = z
  .object({
    detail: z.string().optional().catch(undefined),
    mode: z
      .union([
        z.literal(ConnectionSecurityMode.Enhanced),
        z.literal(ConnectionSecurityMode.SigningUnavailable),
        z.literal(ConnectionSecurityMode.Standard),
        z.literal(ConnectionSecurityMode.Unconfigured),
      ])
      .optional()
      .catch(undefined),
  })
  .passthrough();

/**
 * ISS-5310 — moved verbatim from the Labs Gateway Health card: prefer the
 * human-readable `detail`, fall back to the machine `mode` with its underscores
 * opened up, and otherwise leave the cell on the shared "..." placeholder rather
 * than inventing a security posture the gateway never reported.
 */
function formatConnectionSecurityValue(value: unknown): string {
  const parsed = connectionSecuritySchema.safeParse(value);
  if (!parsed.success) {
    return UNKNOWN_STATUS_VALUE;
  }
  if (parsed.data.detail && parsed.data.detail.trim().length > 0) {
    return parsed.data.detail;
  }
  if (parsed.data.mode) {
    return parsed.data.mode.replaceAll("_", " ");
  }
  return formatRuntimeStatusValue(undefined);
}

const GatewayHealthTone = {
  Danger: "danger",
  Success: "success",
  Warning: "warning",
} as const;

type GatewayHealthTone =
  (typeof GatewayHealthTone)[keyof typeof GatewayHealthTone];

/** Fill colors for the decorative status dot — see the render site for why the label does not take them. */
const GATEWAY_HEALTH_TONE_CLASS: Record<GatewayHealthTone, string> = {
  danger: "bg-[var(--destructive)]",
  success: "bg-[var(--success)]",
  warning: "bg-[var(--warning)]",
};

const OFFLINE_GATEWAY_HEALTH = {
  detail: "The local gateway server is not reachable.",
  label: "Offline",
  tone: GatewayHealthTone.Danger,
} as const;

/**
 * ISS-5310 — the gateway health rollup, relocated verbatim from the Labs tab's
 * `GatewayHealthCard` (stage cid 3726701537). The three buckets and the order
 * they are tested in are unchanged; only the presentation moved onto this
 * section's tone-class idiom, so the cell reads like its Cloud Connection
 * neighbour instead of carrying a status dot no other cell has.
 *
 *   - Offline: the server is confirmed down, or there is no status at all
 *     (unreachable / gateway down / the read has not resolved).
 *   - Connected: reachable and healthy.
 *   - Needs Attention: reachable but not healthy (recovering, liveness probe
 *     failing) — degraded rather than fully offline.
 */
function describeGatewayHealth(
  gatewayHealthy: unknown,
  serverAlive: unknown
): { detail: string; label: string; tone: GatewayHealthTone } {
  if (serverAlive === false) {
    return OFFLINE_GATEWAY_HEALTH;
  }
  if (gatewayHealthy === true) {
    return {
      detail: "The local gateway is reachable and healthy.",
      label: "Connected",
      tone: GatewayHealthTone.Success,
    };
  }
  if (gatewayHealthy === false) {
    return {
      detail: "The local gateway is reachable but not reporting healthy.",
      label: "Needs Attention",
      tone: GatewayHealthTone.Warning,
    };
  }
  return OFFLINE_GATEWAY_HEALTH;
}
