"use client";

import { Switch } from "@repo/design-system/components/ui/switch";
import { useEffect, useState } from "react";

export type ConnectionState = "connected" | "disconnected" | "pending";

export function SettingsSection({
  children,
  description,
  title,
}: {
  children: React.ReactNode;
  description: string;
  title: string;
}) {
  const id = `settings-${title.toLowerCase().replaceAll(" ", "-")}`;
  return (
    <section aria-labelledby={id}>
      <div className="mb-4">
        <h2 className="font-semibold text-lg tracking-tight" id={id}>
          {title}
        </h2>
        <p className="mt-1 text-muted-foreground text-sm">{description}</p>
      </div>
      {children}
    </section>
  );
}

export function ToggleSetting({
  defaultChecked = false,
  description,
  label,
}: {
  defaultChecked?: boolean;
  description: string;
  label: string;
}) {
  return (
    <div className="flex items-start justify-between gap-5 p-4">
      <div>
        <p className="font-medium text-sm">{label}</p>
        <p className="mt-1 text-muted-foreground text-sm">{description}</p>
      </div>
      <Switch aria-label={label} defaultChecked={defaultChecked} />
    </div>
  );
}

export function useSettingsAnnotationsVisible() {
  const [visible, setVisible] = useState(true);

  useEffect(() => {
    const syncVisibility = () => {
      setVisible(
        globalThis.document.documentElement.dataset.prototypeAnnotations !==
          "hide"
      );
    };

    syncVisibility();
    globalThis.window.addEventListener(
      "prototype-annotations-change",
      syncVisibility
    );
    return () =>
      globalThis.window.removeEventListener(
        "prototype-annotations-change",
        syncVisibility
      );
  }, []);

  return visible;
}
