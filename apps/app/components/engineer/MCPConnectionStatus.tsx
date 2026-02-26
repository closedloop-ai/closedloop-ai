"use client";

import { Button } from "@repo/design-system/components/ui/button";
import { cn } from "@repo/design-system/lib/utils";
import {
  AlertCircle,
  CheckCircle2,
  Loader2,
  LogIn,
  type LucideIcon,
  Wifi,
} from "lucide-react";

type MCPState =
  | "discovering"
  | "pending_auth"
  | "authenticating"
  | "connecting"
  | "loading"
  | "ready"
  | "failed"
  | "error"
  | "disconnected";

type MCPConnectionStatusProps = {
  state: MCPState;
  error?: string | null;
  className?: string;
  showLabel?: boolean;
  onAuthenticate?: () => void;
};

type StatusConfig = {
  icon: LucideIcon;
  label: string;
  color: string;
  animate: boolean;
};

const STATUS_CONFIGS: Record<MCPState, StatusConfig> = {
  discovering: {
    icon: Loader2,
    label: "Discovering MCP server...",
    color: "text-blue-500",
    animate: true,
  },
  pending_auth: {
    icon: LogIn,
    label: "Authentication required",
    color: "text-amber-500",
    animate: false,
  },
  authenticating: {
    icon: Loader2,
    label: "Authenticating (check for popup)...",
    color: "text-blue-500",
    animate: true,
  },
  connecting: {
    icon: Loader2,
    label: "Connecting to MCP server...",
    color: "text-blue-500",
    animate: true,
  },
  loading: {
    icon: Loader2,
    label: "Loading MCP resources...",
    color: "text-blue-500",
    animate: true,
  },
  ready: {
    icon: CheckCircle2,
    label: "Connected to Symphony MCP",
    color: "text-green-500",
    animate: false,
  },
  failed: {
    icon: AlertCircle,
    label: "MCP connection failed",
    color: "text-destructive",
    animate: false,
  },
  error: {
    icon: AlertCircle,
    label: "MCP connection error",
    color: "text-destructive",
    animate: false,
  },
  disconnected: {
    icon: Wifi,
    label: "Disconnected from MCP",
    color: "text-muted-foreground",
    animate: false,
  },
};

const DEFAULT_CONFIG: StatusConfig = {
  icon: Wifi,
  label: "Unknown connection status",
  color: "text-muted-foreground",
  animate: false,
};

/**
 * Component that displays the current MCP connection status
 * Shows appropriate icon and text based on connection state
 */
export function MCPConnectionStatus({
  state,
  error,
  className,
  showLabel = true,
  onAuthenticate,
}: Readonly<MCPConnectionStatusProps>) {
  const config = STATUS_CONFIGS[state] || DEFAULT_CONFIG;
  const Icon = config.icon;
  const label =
    (state === "error" || state === "failed") && error ? error : config.label;

  return (
    <div className={cn("flex items-center gap-2", className)}>
      <Icon
        className={cn("size-4", config.color, config.animate && "animate-spin")}
      />
      {showLabel && (
        <span className={cn("text-sm", config.color)}>{label}</span>
      )}
      {state === "pending_auth" && onAuthenticate && (
        <Button onClick={onAuthenticate} size="sm" variant="outline">
          Connect
        </Button>
      )}
    </div>
  );
}
