"use client";

import {
  ToggleGroup,
  ToggleGroupItem,
} from "@repo/design-system/components/ui/toggle-group";
import { useState } from "react";
import { PageState, Viewer } from "../mock";
import { AdminView } from "./admin-view";
import { AppShell } from "./app-shell";
import { MemberView } from "./member-view";

// Prototype-only controls: the production page picks the viewer from org
// capability and derives the state from data + request status. Here they're
// toggles so /design-review can walk every treatment and state on one route.
const ViewerControls = ({
  viewer,
  onViewerChange,
  state,
  onStateChange,
}: {
  viewer: Viewer;
  onViewerChange: (value: Viewer) => void;
  state: PageState;
  onStateChange: (value: PageState) => void;
}) => (
  <>
    <ToggleGroup
      aria-label="Viewer"
      onValueChange={(value) => {
        if (value) {
          onViewerChange(value as Viewer);
        }
      }}
      size="sm"
      type="single"
      value={viewer}
      variant="outline"
    >
      <ToggleGroupItem value={Viewer.Admin}>Admin</ToggleGroupItem>
      <ToggleGroupItem value={Viewer.Member}>Member</ToggleGroupItem>
    </ToggleGroup>
    <ToggleGroup
      aria-label="Page state"
      onValueChange={(value) => {
        if (value) {
          onStateChange(value as PageState);
        }
      }}
      size="sm"
      type="single"
      value={state}
      variant="outline"
    >
      <ToggleGroupItem value={PageState.Populated}>Populated</ToggleGroupItem>
      <ToggleGroupItem value={PageState.Loading}>Loading</ToggleGroupItem>
      <ToggleGroupItem value={PageState.Empty}>Empty</ToggleGroupItem>
    </ToggleGroup>
  </>
);

export const PacksPage = () => {
  const [viewer, setViewer] = useState<Viewer>(Viewer.Admin);
  const [state, setState] = useState<PageState>(PageState.Populated);

  return (
    <AppShell
      controls={
        <ViewerControls
          onStateChange={setState}
          onViewerChange={setViewer}
          state={state}
          viewer={viewer}
        />
      }
      title="Packs"
    >
      {viewer === Viewer.Admin ? (
        <AdminView state={state} />
      ) : (
        <MemberView state={state} />
      )}
    </AppShell>
  );
};
