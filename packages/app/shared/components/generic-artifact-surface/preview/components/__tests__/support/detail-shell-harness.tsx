import { screen } from "@testing-library/react";
import { type ComponentProps, useCallback, useState } from "react";
import { genericArtifacts } from "../../../fixtures";
import { GenericArtifactDetailShell } from "../../generic-artifact-detail-shell";

type ShellProps = ComponentProps<typeof GenericArtifactDetailShell>;

export const shellArtifact = genericArtifacts[0]!;
export const otherShellArtifact = genericArtifacts[1]!;

// The fourth tab is Activity (ISS-10789; renamed from Trace/Revisions by
// ISS-10843 v11 and ISS-10790).
export const ACTIVITY_PANEL = "Activity panel";

export const lightPanels = {
  details: <p>Details panel</p>,
  sessions: <p>Sessions panel</p>,
  activity: <p>{ACTIVITY_PANEL}</p>,
};

/** Owns `commentsOpen` the way a host surface does, with a button to reopen the rail. */
export function ShellHarness({
  initialOpen = false,
  onCommentsOpenChange,
  ...props
}: Partial<Omit<ShellProps, "commentsOpen">> & { initialOpen?: boolean }) {
  const [open, setOpen] = useState(initialOpen);
  const handleOpenChange = useCallback(
    (next: boolean) => {
      setOpen(next);
      onCommentsOpenChange?.(next);
    },
    [onCommentsOpenChange]
  );
  return (
    <>
      <button onClick={() => setOpen(true)} type="button">
        Open rail
      </button>
      <GenericArtifactDetailShell
        artifact={shellArtifact}
        commentsOpen={open}
        onCommentsOpenChange={handleOpenChange}
        panels={lightPanels}
        {...props}
      />
    </>
  );
}

export function commentsRail() {
  return screen.queryByRole("complementary", { hidden: true });
}

export function commentsLayoutMode() {
  return (
    screen
      // `hidden`: an open narrow-layout Sheet makes the page behind it inert.
      .getByRole("tablist", { hidden: true, name: "Artifact detail sections" })
      .closest("[data-comments-layout]")
      ?.getAttribute("data-comments-layout")
  );
}
