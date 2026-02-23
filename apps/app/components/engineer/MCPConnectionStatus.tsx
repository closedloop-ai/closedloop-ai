"use client";

import { cn } from "@repo/design-system/lib/utils";
import {
  AlertCircle,
  CheckCircle2,
  Loader2,
  type LucideIcon,
  Wifi,
} from "lucide-react";

type MCPState =
  | "discovering"
  | "connecting"
  | "loading"
  | "ready"
  | "error"
  | "disconnected";

type MCPConnectionStatusProps = {
  state: MCPState;
  error?: string | null;
  className?: string;
  showLabel?: boolean;
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
    label: "Connected to Linear MCP",
    color: "text-green-500",
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
}: Readonly<MCPConnectionStatusProps>) {
  const config = STATUS_CONFIGS[state] || DEFAULT_CONFIG;
  const Icon = config.icon;
  const label = state === "error" && error ? error : config.label;

  return (
    <div className={cn("flex items-center gap-2", className)}>
      <Icon
        className={cn("size-4", config.color, config.animate && "animate-spin")}
      />
      {showLabel && (
        <span className={cn("text-sm", config.color)}>{label}</span>
      )}
    </div>
  );
}
