import type { BadgeProps } from "@repo/design-system/components/ui/badge";
import type { Tone } from "./types";

export const badgeClassName =
  "rounded-md px-1.5 py-0.5 font-medium text-[10px]";

export function getBadgeVariant(
  tone: Tone = "muted"
): NonNullable<BadgeProps["variant"]> {
  if (tone === "success") {
    return "success";
  }
  if (tone === "warning") {
    return "warning";
  }
  if (tone === "danger") {
    return "destructive";
  }
  if (tone === "info") {
    return "info";
  }
  if (tone === "accent") {
    return "accent";
  }
  if (tone === "default") {
    return "outline";
  }
  return "muted";
}

export function formatCurrency(value: number) {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 2,
  }).format(value);
}

export function formatRelativeLabel(iso: string) {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) {
    return iso;
  }

  const diffMs = date.getTime() - Date.now();
  const diffMinutes = Math.round(diffMs / 60_000);
  const absoluteMinutes = Math.abs(diffMinutes);

  if (absoluteMinutes < 1) {
    return "just now";
  }
  if (absoluteMinutes < 60) {
    return `${absoluteMinutes}m ${diffMinutes >= 0 ? "from now" : "ago"}`;
  }

  const absoluteHours = Math.round(absoluteMinutes / 60);
  if (absoluteHours < 24) {
    return `${absoluteHours}h ${diffMinutes >= 0 ? "from now" : "ago"}`;
  }

  const absoluteDays = Math.round(absoluteHours / 24);
  return `${absoluteDays}d ${diffMinutes >= 0 ? "from now" : "ago"}`;
}

export function formatDateTime(iso: string) {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) {
    return iso;
  }
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(date);
}

export function truncateMiddle(value: string, max = 32) {
  if (value.length <= max) {
    return value;
  }
  const visible = max - 3;
  if (visible <= 0) {
    return "...";
  }
  const head = Math.ceil(visible / 2);
  const tail = Math.floor(visible / 2);
  const suffix = tail > 0 ? value.slice(-tail) : "";
  return `${value.slice(0, head)}...${suffix}`;
}

export function formatDurationSeconds(value: number) {
  if (!Number.isFinite(value) || value <= 0) {
    return "0s";
  }

  const hours = Math.floor(value / 3600);
  const minutes = Math.floor((value % 3600) / 60);
  const seconds = Math.round(value % 60);

  if (hours > 0) {
    return `${hours}h ${minutes}m`;
  }
  if (minutes > 0) {
    return seconds > 0 ? `${minutes}m ${seconds}s` : `${minutes}m`;
  }
  return `${seconds}s`;
}

export function formatCompactNumber(value: number) {
  return new Intl.NumberFormat("en-US", {
    notation: "compact",
    maximumFractionDigits: 1,
  }).format(value);
}

export function formatTokenCount(count: number) {
  const BILLION = 1_000_000_000;
  const MILLION = 1_000_000;
  const THOUSAND = 1000;

  if (count >= BILLION) {
    return `${(count / BILLION).toFixed(2)}B`;
  }
  if (count >= MILLION) {
    const divided = count / MILLION;
    if (divided >= 999.995) {
      return `${(count / BILLION).toFixed(2)}B`;
    }
    return `${divided.toFixed(2)}M`;
  }
  if (count >= THOUSAND) {
    const divided = count / THOUSAND;
    if (divided >= 999.995) {
      return `${(count / MILLION).toFixed(2)}M`;
    }
    return `${divided.toFixed(2)}k`;
  }
  return count.toString();
}

export function formatLocalTime(iso: string) {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) {
    return "";
  }

  return date.toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit",
  });
}

/**
 * Return the last segment of a filesystem-style path, handling both POSIX (`/`)
 * and Windows (`\`) separators. Null-safe: returns null for null/empty input,
 * and falls back to the original string when it contains no separators.
 */
export function lastPathSegment(path: string | null): string | null {
  if (!path) {
    return null;
  }
  const segments = path.split(/[/\\]/).filter(Boolean);
  return segments.at(-1) ?? path;
}
