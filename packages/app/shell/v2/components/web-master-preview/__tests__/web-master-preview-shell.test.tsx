import { createMemoryNavigation } from "@repo/navigation/memory-adapter";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { WebMasterHostImageProps } from "../components/web-master-host-image";
import { useWebMasterHostImage } from "../components/web-master-host-image";
import { WEB_MASTER_BASE_PATH } from "../mock";
import { findProject } from "../projects/project-model";
import { WebMasterProjectDetailRoute } from "../routes/web-master-page-routes";
import { WebMasterPreviewShell } from "../web-master-preview-shell";

const HOST_IMAGE_TEST_ID = "host-image";

function HostImage({ alt, src }: WebMasterHostImageProps) {
  return (
    <span data-alt={alt} data-src={src} data-testid={HOST_IMAGE_TEST_ID} />
  );
}

function ImageConsumer() {
  useWebMasterHostImage();
  return null;
}

beforeEach(() => {
  globalThis.localStorage.clear();
});

afterEach(cleanup);

describe("WebMasterPreviewShell", () => {
  it("renders the route inside the shell and draws its logos with the host image component", () => {
    const navigation = createMemoryNavigation({
      initialPath: `${WEB_MASTER_BASE_PATH}/dashboard`,
    });

    render(
      <WebMasterPreviewShell
        imageComponent={HostImage}
        navigationAdapter={navigation.adapter}
      >
        <p>Route content</p>
      </WebMasterPreviewShell>
    );

    expect(screen.getByText("Route content")).toBeInTheDocument();
    expect(screen.getAllByTestId(HOST_IMAGE_TEST_ID).length).toBeGreaterThan(0);
  });

  it("sends an unfinished onboarding back to the dashboard through the host navigation adapter", async () => {
    const navigation = createMemoryNavigation({
      initialPath: `${WEB_MASTER_BASE_PATH}/settings`,
    });

    render(
      <WebMasterPreviewShell
        imageComponent={HostImage}
        navigationAdapter={navigation.adapter}
      >
        <p>Route content</p>
      </WebMasterPreviewShell>
    );

    await waitFor(() =>
      expect(navigation.getCurrentHref()).toBe(
        `${WEB_MASTER_BASE_PATH}/dashboard`
      )
    );
  });

  it("refuses to render a logo without a host image component", () => {
    expect(() => render(<ImageConsumer />)).toThrow(
      "Web Master preview images require a WebMasterPreviewShell host image component."
    );
  });
});

describe("WebMasterProjectDetailRoute", () => {
  it.each([
    ["sprint-0810", findProject("sprint-0810")?.name ?? "missing fixture"],
    ["unknown-project", "Project not found"],
  ])("reads project %s from the host route params", (projectId, heading) => {
    const navigation = createMemoryNavigation({
      initialPath: `${WEB_MASTER_BASE_PATH}/projects/${projectId}`,
      routeParams: { projectId },
    });

    render(
      <WebMasterPreviewShell
        imageComponent={HostImage}
        navigationAdapter={navigation.adapter}
      >
        <WebMasterProjectDetailRoute />
      </WebMasterPreviewShell>
    );

    // The onboarding gate leaves the route inert, so read text, not roles.
    expect(screen.getAllByText(heading).length).toBeGreaterThan(0);
  });
});
