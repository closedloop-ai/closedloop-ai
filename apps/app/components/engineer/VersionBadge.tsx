"use client";

import { useEffect, useState } from "react";

type VersionBadgeProps = {
  onClick: () => void;
};

export function VersionBadge({ onClick }: Readonly<VersionBadgeProps>) {
  const [version, setVersion] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/gateway/version")
      .then((res) => res.json())
      .then((data) => {
        if (data.version) {
          setVersion(data.version);
        }
      })
      .catch(() => {
        // Silently fail - version badge is non-critical
      });
  }, []);

  if (!version) {
    return null;
  }

  return (
    <button
      className="group flex cursor-pointer items-center gap-1.5 font-mono text-[11px] text-muted-foreground/50 transition-colors hover:text-muted-foreground"
      onClick={onClick}
      title="View changelog"
    >
      <span className="size-1.5 rounded-full bg-emerald-500/60 transition-colors group-hover:bg-emerald-500" />
      <span>v{version}</span>
    </button>
  );
}
