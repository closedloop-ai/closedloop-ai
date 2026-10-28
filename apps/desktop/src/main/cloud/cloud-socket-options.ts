import type { DesktopPopSigner } from "../auth/desktop-pop.js";
import type { DesktopPopUnavailableReporter } from "../auth/desktop-pop-sign-utils.js";
import type { DesktopAccountAdmission } from "../session/desktop-account-admission.js";
import type { ApiKeyProvenance } from "../settings/api-key-store.js";
import type { DesktopAuthFailureEventInput } from "./auth-failure-telemetry.js";
import type {
  CloudSocketStatus,
  DesktopCancelEvent,
  DesktopCommandEvent,
  DesktopCommandStreamAckEvent,
  DesktopHelloAckEvent,
} from "./cloud-protocol.js";

/** Main-process credential availability without exposing key material. */
export type ApiKeyDiagnostic = "available" | "missing" | "undecryptable";

/** Main-process dependencies and callbacks for the authenticated command socket. */
export type CloudSocketOptions = {
  getAccountAdmission?: () => DesktopAccountAdmission | null;
  getRelayOrigin: () => string;
  getApiKey: () => string | null;
  getApiKeyDiagnostic?: () => ApiKeyDiagnostic;
  getApiKeyProvenance?: () => ApiKeyProvenance | null;
  signDesktopRequest?: DesktopPopSigner;
  onDesktopPopUnavailable?: DesktopPopUnavailableReporter;
  getAllowedDirectories: () => string[];
  getCapabilities?: () => Record<string, unknown>;
  getMaxInFlightCommands: () => number;
  getGatewayId?: () => string | null;
  /**
   * Local cloud-command load. The gateway-refresh re-hello (ISS-12032) is sent
   * only when nothing is running or queued; absent reads as busy.
   */
  getCommandWorkStats?: () => { activeCommands: number; queueDepth: number };
  machineName: string;
  pluginVersion: string;
  desktopClientVersion: string;
  gatewayProtocolVersion: string;
  getEnabledOperations: () => string[];
  reportAuthFailure?: (input: DesktopAuthFailureEventInput) => void;
  onStatusChange?: (status: CloudSocketStatus) => void;
  onHelloAck?: (event: DesktopHelloAckEvent) => void;
  onCommand?: (event: DesktopCommandEvent) => void;
  onCancel?: (event: DesktopCancelEvent) => void;
  onCommandEventAck?: (event: DesktopCommandStreamAckEvent) => void;
  onDisconnect?: (reason: string) => void;
};
