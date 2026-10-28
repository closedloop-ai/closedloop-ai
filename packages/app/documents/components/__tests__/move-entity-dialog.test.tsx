import { ArtifactType } from "@repo/api/src/types/artifact";
import { ArtifactStatusEditSurface } from "@repo/api/src/types/artifact-status-contract";
import {
  ProjectArtifactPlacementKind,
  ProjectArtifactPlacementPosition,
  ProjectArtifactPlacementSource,
} from "@repo/api/src/types/project-artifact-placement";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MoveEntityDialog } from "../move-entity-dialog";

const mockGet = vi.fn();
const mockPost = vi.fn();
const mockToastSuccess = vi.fn();
const mockToastWarning = vi.fn();
const mockToastError = vi.fn();

vi.mock("@repo/app/shared/api/use-api-client", () => ({
  useApiClient: () => ({
    get: (...args: unknown[]) => mockGet(...args),
    post: (...args: unknown[]) => mockPost(...args),
  }),
}));

vi.mock("@repo/app/shared/api/use-api-client-optional", () => ({
  useApiClientOptional: () => ({
    get: (...args: unknown[]) => mockGet(...args),
    post: (...args: unknown[]) => mockPost(...args),
  }),
}));

vi.mock("@repo/design-system/components/ui/sonner", () => ({
  toast: {
    success: (...args: unknown[]) => mockToastSuccess(...args),
    warning: (...args: unknown[]) => mockToastWarning(...args),
    error: (...args: unknown[]) => mockToastError(...args),
  },
}));

const BATCH_MOVE_PATH = "/artifact-links/batch-move";
const PROJECT_PICKER_NAME = "Select destination project";
const SINGLE_DESCRIPTION_REGEX = /move this item to/;
const BULK_DESCRIPTION_REGEX = /move these items to/;

const PROJECTS = [
  { id: "p-alpha", name: "Alpha" },
  { id: "p-beta", name: "Beta" },
  { id: "p-gamma", name: "Gamma" },
];

function renderDialog(ui: ReactNode) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>{ui}</QueryClientProvider>
  );
}

async function openPicker(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole("combobox", { name: PROJECT_PICKER_NAME }));
}

async function pickProject(
  user: ReturnType<typeof userEvent.setup>,
  name: string
) {
  await openPicker(user);
  await user.click(await screen.findByRole("option", { name }));
}

/**
 * The route's real receipt (`BatchMoveArtifactsResult`). The hook now reads it
 * to drive invalidation (ISS-9578), so a fixture that answers with anything
 * else is not exercising the production path.
 */
function movedReceipt(artifactId: string) {
  return { movedArtifacts: [{ id: artifactId, type: ArtifactType.Document }] };
}

function moveButton() {
  return screen.getByRole("button", { name: "Move" });
}

describe("MoveEntityDialog", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGet.mockResolvedValue(PROJECTS);
    mockPost.mockResolvedValue(movedReceipt("doc-1"));
  });

  afterEach(() => {
    cleanup();
  });

  it("excludes the entity's own project, preferring it over currentProjectId", async () => {
    const user = userEvent.setup({ delay: null });
    renderDialog(
      <MoveEntityDialog
        currentProjectId="p-beta"
        entity={{ id: "doc-1", projectId: "p-alpha" }}
        onOpenChange={vi.fn()}
        open
      />
    );

    await waitFor(() => expect(mockGet).toHaveBeenCalled());
    await openPicker(user);

    expect(await screen.findByRole("option", { name: "Beta" })).toBeVisible();
    expect(screen.getByRole("option", { name: "Gamma" })).toBeVisible();
    expect(screen.queryByRole("option", { name: "Alpha" })).toBeNull();
  });

  it("falls back to currentProjectId when the entity has no project", async () => {
    const user = userEvent.setup({ delay: null });
    renderDialog(
      <MoveEntityDialog
        currentProjectId="p-beta"
        entity={{ id: "doc-1", projectId: null }}
        onOpenChange={vi.fn()}
        open
      />
    );

    await waitFor(() => expect(mockGet).toHaveBeenCalled());
    await openPicker(user);

    expect(await screen.findByRole("option", { name: "Alpha" })).toBeVisible();
    expect(screen.queryByRole("option", { name: "Beta" })).toBeNull();
  });

  it("offers a disabled placeholder and keeps Move disabled when no other project exists", async () => {
    const user = userEvent.setup({ delay: null });
    mockGet.mockResolvedValue([{ id: "p-alpha", name: "Alpha" }]);
    renderDialog(
      <MoveEntityDialog
        entity={{ id: "doc-1", projectId: "p-alpha" }}
        onOpenChange={vi.fn()}
        open
      />
    );

    await waitFor(() => expect(mockGet).toHaveBeenCalled());
    expect(moveButton()).toBeDisabled();
    await openPicker(user);

    const placeholder = await screen.findByRole("option", {
      name: "No available projects",
    });
    expect(placeholder).toHaveAttribute("aria-disabled", "true");
  });

  it("moves a single entity with its downstream items and closes on success", async () => {
    const user = userEvent.setup({ delay: null });
    const onOpenChange = vi.fn();
    const onSuccess = vi.fn();
    renderDialog(
      <MoveEntityDialog
        entities={[]}
        entity={{ id: "doc-1", projectId: "p-alpha" }}
        onOpenChange={onOpenChange}
        onSuccess={onSuccess}
        open
      />
    );

    // An empty `entities` array falls through to the single `entity`.
    expect(screen.getByText(SINGLE_DESCRIPTION_REGEX)).toBeInTheDocument();

    await waitFor(() => expect(mockGet).toHaveBeenCalled());
    // Nothing is chosen yet even though destinations are now available.
    await waitFor(() =>
      expect(
        screen.getByRole("combobox", { name: PROJECT_PICKER_NAME })
      ).toHaveTextContent("Choose a project")
    );
    expect(moveButton()).toBeDisabled();

    await pickProject(user, "Beta");
    expect(moveButton()).toBeEnabled();
    await user.click(moveButton());

    await waitFor(() =>
      expect(mockToastSuccess).toHaveBeenCalledWith(
        "Moved with all downstream items"
      )
    );
    expect(mockPost).toHaveBeenCalledTimes(1);
    expect(mockPost).toHaveBeenCalledWith(BATCH_MOVE_PATH, {
      artifactId: "doc-1",
      targetProjectId: "p-beta",
      includeDownstream: true,
      surface: ArtifactStatusEditSurface.RowAction,
    });
    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(onSuccess).toHaveBeenCalledTimes(1);
    // The choice is cleared, so re-opening does not re-arm the last target.
    await waitFor(() =>
      expect(
        screen.getByRole("combobox", { name: PROJECT_PICKER_NAME })
      ).toHaveTextContent("Choose a project")
    );
    expect(moveButton()).toBeDisabled();
  });

  it("does not post when there is no entity to move", async () => {
    const user = userEvent.setup({ delay: null });
    const onOpenChange = vi.fn();
    renderDialog(<MoveEntityDialog onOpenChange={onOpenChange} open />);

    await waitFor(() => expect(mockGet).toHaveBeenCalled());
    await pickProject(user, "Beta");
    await user.click(moveButton());

    expect(mockPost).not.toHaveBeenCalled();
    expect(onOpenChange).not.toHaveBeenCalled();
  });

  it("reports a fully successful bulk move with one summary toast", async () => {
    const user = userEvent.setup({ delay: null });
    const onOpenChange = vi.fn();
    const onSuccess = vi.fn();
    renderDialog(
      <MoveEntityDialog
        entities={[
          { id: "doc-1", projectId: "p-alpha" },
          { id: "doc-2", projectId: "p-alpha" },
        ]}
        onOpenChange={onOpenChange}
        onSuccess={onSuccess}
        open
      />
    );

    expect(screen.getByText(BULK_DESCRIPTION_REGEX)).toBeInTheDocument();
    await waitFor(() => expect(mockGet).toHaveBeenCalled());
    await pickProject(user, "Gamma");
    await user.click(moveButton());

    await waitFor(() =>
      expect(mockToastSuccess).toHaveBeenCalledWith(
        "Moved 2 items successfully"
      )
    );
    expect(mockPost.mock.calls.map((call) => call[1])).toEqual([
      {
        artifactId: "doc-1",
        targetProjectId: "p-gamma",
        includeDownstream: true,
        surface: ArtifactStatusEditSurface.Bulk,
      },
      {
        artifactId: "doc-2",
        targetProjectId: "p-gamma",
        includeDownstream: true,
        surface: ArtifactStatusEditSurface.Bulk,
      },
    ]);
    expect(mockToastWarning).not.toHaveBeenCalled();
    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(onSuccess).toHaveBeenCalledTimes(1);
    await waitFor(() =>
      expect(
        screen.getByRole("combobox", { name: PROJECT_PICKER_NAME })
      ).toHaveTextContent("Choose a project")
    );
  });

  it("moves a hierarchy selection to an empty destination with one atomic Root placement", async () => {
    const user = userEvent.setup({ delay: null });
    const onOpenChange = vi.fn();
    const onSuccess = vi.fn();
    mockGet.mockImplementation((path: string) => {
      if (path === "/projects") {
        return Promise.resolve(PROJECTS);
      }
      const projectId = path.split("/")[2] ?? "";
      return Promise.resolve({
        externalParents: [],
        nodes: [],
        projectId,
        projectVersion: `${projectId}-v1`,
      });
    });
    mockPost.mockResolvedValue({
      placed: true,
      transactionId: "45cbbaf2-b0d2-4431-9dd9-6b066796cdbb",
      affectedArtifactIds: ["root-a", "child-b"],
      affectedProjectIds: ["p-alpha", "p-gamma"],
      projectVersions: { "p-alpha": "v2", "p-gamma": "v2" },
      placement: {
        sourceArtifactIds: ["root-a", "child-b"],
        destinationProjectId: "p-gamma",
        position: ProjectArtifactPlacementPosition.Root,
      },
      replayed: false,
      undoAvailable: true,
    });
    renderDialog(
      <MoveEntityDialog
        currentProjectId="p-alpha"
        entities={[{ id: "root-a" }, { id: "child-b" }]}
        onOpenChange={onOpenChange}
        onSuccess={onSuccess}
        open
        placementSourceProjectId="p-alpha"
      />
    );

    await waitFor(() => expect(mockGet).toHaveBeenCalledWith("/projects"));
    await pickProject(user, "Gamma");
    await user.click(moveButton());

    await waitFor(() => expect(onSuccess).toHaveBeenCalledTimes(1));
    expect(mockPost).toHaveBeenCalledTimes(1);
    expect(mockPost).toHaveBeenCalledWith(
      "/projects/p-alpha/artifacts/placement",
      expect.objectContaining({
        kind: ProjectArtifactPlacementKind.Place,
        sourceArtifactIds: ["root-a", "child-b"],
        destinationProjectId: "p-gamma",
        position: ProjectArtifactPlacementPosition.Root,
        source: ProjectArtifactPlacementSource.Api,
      })
    );
    expect(mockPost).not.toHaveBeenCalledWith(
      BATCH_MOVE_PATH,
      expect.anything()
    );
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("warns with the split when only some items move, and still closes", async () => {
    const user = userEvent.setup({ delay: null });
    const onOpenChange = vi.fn();
    const onSuccess = vi.fn();
    mockPost.mockImplementation(
      (_path: string, input: { artifactId: string }) =>
        input.artifactId === "doc-2"
          ? Promise.reject(new Error("nope"))
          : Promise.resolve(movedReceipt(input.artifactId))
    );
    renderDialog(
      <MoveEntityDialog
        entities={[
          { id: "doc-1", projectId: "p-alpha" },
          { id: "doc-2", projectId: "p-alpha" },
        ]}
        onOpenChange={onOpenChange}
        onSuccess={onSuccess}
        open
      />
    );

    await waitFor(() => expect(mockGet).toHaveBeenCalled());
    await pickProject(user, "Beta");
    await user.click(moveButton());

    await waitFor(() =>
      expect(mockToastWarning).toHaveBeenCalledWith(
        "Moved 1 of 2 items. 1 failed."
      )
    );
    expect(mockToastSuccess).not.toHaveBeenCalled();
    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(onSuccess).toHaveBeenCalledTimes(1);
  });

  it("reports an error and stays open when every bulk item fails", async () => {
    const user = userEvent.setup({ delay: null });
    const onOpenChange = vi.fn();
    const onSuccess = vi.fn();
    mockPost.mockRejectedValue(new Error("down"));
    renderDialog(
      <MoveEntityDialog
        entities={[
          { id: "doc-1", projectId: "p-alpha" },
          { id: "doc-2", projectId: "p-alpha" },
        ]}
        onOpenChange={onOpenChange}
        onSuccess={onSuccess}
        open
      />
    );

    await waitFor(() => expect(mockGet).toHaveBeenCalled());
    await pickProject(user, "Beta");
    await user.click(moveButton());

    await waitFor(() =>
      expect(mockToastError).toHaveBeenCalledWith(
        "Failed to move items. Please try again."
      )
    );
    expect(onOpenChange).not.toHaveBeenCalled();
    expect(onSuccess).not.toHaveBeenCalled();
    // The pending state clears in `finally`, so the user can retry.
    await waitFor(() => expect(moveButton()).toBeEnabled());
  });

  it("shows a pending state and disables both actions while a move is in flight", async () => {
    const user = userEvent.setup({ delay: null });
    let resolvePost: (value: unknown) => void = () => undefined;
    mockPost.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolvePost = resolve;
        })
    );
    renderDialog(
      <MoveEntityDialog
        entity={{ id: "doc-1", projectId: "p-alpha" }}
        onOpenChange={vi.fn()}
        open
      />
    );

    await waitFor(() => expect(mockGet).toHaveBeenCalled());
    await pickProject(user, "Beta");
    await user.click(moveButton());

    const pending = await screen.findByRole("button", { name: "Moving..." });
    expect(pending).toBeDisabled();
    expect(screen.getByRole("button", { name: "Cancel" })).toBeDisabled();

    resolvePost(movedReceipt("doc-1"));
    await waitFor(() => expect(mockToastSuccess).toHaveBeenCalled());
  });

  it("Cancel requests close without moving", async () => {
    const user = userEvent.setup({ delay: null });
    const onOpenChange = vi.fn();
    renderDialog(
      <MoveEntityDialog
        entity={{ id: "doc-1", projectId: "p-alpha" }}
        onOpenChange={onOpenChange}
        open
      />
    );

    await user.click(screen.getByRole("button", { name: "Cancel" }));

    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(mockPost).not.toHaveBeenCalled();
  });

  it("clears the chosen project when the dialog is dismissed", async () => {
    const user = userEvent.setup({ delay: null });
    const onOpenChange = vi.fn();
    renderDialog(
      <MoveEntityDialog
        entity={{ id: "doc-1", projectId: "p-alpha" }}
        onOpenChange={onOpenChange}
        open
      />
    );

    await waitFor(() => expect(mockGet).toHaveBeenCalled());
    await pickProject(user, "Beta");
    expect(
      screen.getByRole("combobox", { name: PROJECT_PICKER_NAME })
    ).toHaveTextContent("Beta");

    await user.keyboard("{Escape}");

    expect(onOpenChange).toHaveBeenCalledWith(false);
    await waitFor(() =>
      expect(
        screen.getByRole("combobox", { name: PROJECT_PICKER_NAME })
      ).toHaveTextContent("Choose a project")
    );
    expect(moveButton()).toBeDisabled();
  });
  it("reads the destination list for the entity's own team", async () => {
    renderDialog(
      <MoveEntityDialog
        entity={{ id: "doc-1", projectId: "p-alpha" }}
        onOpenChange={vi.fn()}
        open
        teamId="team-7"
      />
    );

    await waitFor(() =>
      expect(mockGet).toHaveBeenCalledWith("/projects?teamId=team-7")
    );
  });

  it("offers nothing to move to until the destination list has loaded", async () => {
    mockGet.mockImplementation(() => new Promise(() => undefined));
    const user = userEvent.setup({ delay: null });
    renderDialog(
      <MoveEntityDialog
        entity={{ id: "doc-1", projectId: "p-alpha" }}
        onOpenChange={vi.fn()}
        open
      />
    );

    await openPicker(user);

    expect(
      await screen.findByRole("option", { name: "No available projects" })
    ).toBeInTheDocument();
    expect(screen.queryByRole("option", { name: "Beta" })).toBeNull();
  });
});
