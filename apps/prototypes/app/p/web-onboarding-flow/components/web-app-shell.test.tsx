// @vitest-environment jsdom

import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { WebAppShell } from "./web-app-shell";

const DOWNLOAD_ROW_NAME = /Download the desktop app/i;

describe("WebAppShell setup checklist", () => {
  it("ticks the download step off when its row is clicked", () => {
    render(
      <WebAppShell projectName="Web app" workspaceName="Acme Engineering" />
    );

    // Team + project arrive done from the wizard; the rest are open.
    expect(screen.getByText("2 of 6 tasks completed")).toBeTruthy();

    // The whole download row is a link straight to the latest universal .dmg.
    const downloadRow = screen.getByRole("link", {
      name: DOWNLOAD_ROW_NAME,
    });
    expect(downloadRow.getAttribute("href")).toContain(
      "releases/download/desktop-latest/Closedloop-universal.dmg"
    );
    expect(downloadRow.getAttribute("target")).toBe("_blank");

    fireEvent.click(downloadRow);

    // Clicking the row completes the step: the count advances and the row is no
    // longer an actionable link.
    expect(screen.getByText("3 of 6 tasks completed")).toBeTruthy();
    expect(screen.queryByRole("link", { name: DOWNLOAD_ROW_NAME })).toBeNull();
  });
});
