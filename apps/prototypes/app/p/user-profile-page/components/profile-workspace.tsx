"use client";

import {
  ToggleGroup,
  ToggleGroupItem,
} from "@repo/design-system/components/ui/toggle-group";
import { useState } from "react";
import { ProfilePage } from "./profile-page";
import { PublicSharePage } from "./public-share-page";
import { ShareDialog } from "./share-dialog";

// The prototype toggles between the two mocked views so a reviewer can compare
// them side by side: the authenticated in-app profile page, and the
// public /p/<uuid> share page. The toggle itself is prototype chrome, not part
// of either production surface.

const View = {
  InApp: "in-app",
  Public: "public",
} as const;
type View = (typeof View)[keyof typeof View];

export function ProfilePageWorkspace() {
  const [view, setView] = useState<View>(View.InApp);
  const [shareOpen, setShareOpen] = useState(false);

  return (
    <div className="min-h-svh bg-background">
      <header className="sticky top-0 z-10 flex h-12 items-center justify-between gap-4 border-border border-b bg-background/95 px-4 backdrop-blur">
        <span className="font-medium text-muted-foreground text-sm">
          User profile page
        </span>
        <ToggleGroup
          aria-label="Choose view"
          onValueChange={(value) => {
            if (value) {
              setView(value as View);
            }
          }}
          type="single"
          value={view}
          variant="outline"
        >
          <ToggleGroupItem value={View.InApp}>In-app profile</ToggleGroupItem>
          <ToggleGroupItem value={View.Public}>
            Public share page
          </ToggleGroupItem>
        </ToggleGroup>
      </header>

      {view === View.InApp ? (
        <ProfilePage onShare={() => setShareOpen(true)} />
      ) : (
        <PublicSharePage onBack={() => setView(View.InApp)} />
      )}

      <ShareDialog
        onOpenChange={setShareOpen}
        onPreviewPublic={() => setView(View.Public)}
        open={shareOpen}
      />
    </div>
  );
}
