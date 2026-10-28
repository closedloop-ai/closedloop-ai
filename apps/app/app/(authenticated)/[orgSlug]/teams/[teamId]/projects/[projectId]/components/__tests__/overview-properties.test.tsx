import { Priority } from "@repo/api/src/types/common";
import { SettingsPanelId } from "@repo/api/src/types/settings-panel";
import { buildSettingsPanelRoute } from "@repo/api/src/types/settings-route-links";
import { ARTIFACT_PRIORITY_UNSET_FLAG_KEY } from "@repo/app/documents/lib/artifact-priority-unset-flag";
import { PRIORITY_LABELS } from "@repo/app/shared/lib/priority-constants";
import { UNASSIGNED_ASSIGNEE_LABEL } from "@repo/app/shared/lib/user-utils";
import { makeProject } from "@repo/app/shared/test-fixtures/project";
import type { TeamRepoWithTeamId } from "@repo/app/teams/hooks/use-team-repositories-union";
import { PRIORITY_LABEL_NONE } from "@repo/design-system/lib/priority-order";
import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ComponentProps } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { installPointerCaptureShims } from "@/__tests__/helpers/pointer-capture-shims";
import { OverviewProperties } from "../overview-properties";

installPointerCaptureShims();

const mockUseTeamMembers = vi.fn();
const mockUseGitHubIntegrationStatus = vi.fn();
const mockUseTeamRepositoriesUnion = vi.fn();
const mockUseFeatureFlagEnabledOptional = vi.fn();
const mockPriorityIconRender = vi.fn();

vi.mock(
  "@repo/app/shared/feature-flags/use-feature-flag-enabled",
  async (importOriginal) => ({
    ...(await importOriginal<
      typeof import("@repo/app/shared/feature-flags/use-feature-flag-enabled")
    >()),
    useFeatureFlagEnabledOptional: (key: string) =>
      mockUseFeatureFlagEnabledOptional(key),
  })
);

// Records every priority handed to the real icon, so a `null` reaching it is
// observable rather than merely rendering nothing. That includes every closed
// option's icon, which Radix Select renders into a detached fragment, so an
// assertion about what the TRIGGER shows reads the tagged glyph inside it.
vi.mock(
  "@repo/design-system/components/ui/priority-icon",
  async (importOriginal) => {
    const actual =
      await importOriginal<
        typeof import("@repo/design-system/components/ui/priority-icon")
      >();
    return {
      ...actual,
      PriorityIcon: (props: ComponentProps<typeof actual.PriorityIcon>) => {
        mockPriorityIconRender(props.priority);
        return (
          <actual.PriorityIcon
            {...props}
            data-priority={props.priority}
            data-testid={PRIORITY_ICON_TEST_ID}
          />
        );
      },
    };
  }
);

vi.mock("@repo/app/teams/hooks/use-team-members", () => ({
  useTeamMembers: (...args: unknown[]) => mockUseTeamMembers(...args),
}));

vi.mock("@repo/app/github/hooks/use-github-integration", () => ({
  useGitHubIntegrationStatus: (...args: unknown[]) =>
    mockUseGitHubIntegrationStatus(...args),
}));

vi.mock("@repo/app/teams/hooks/use-team-repositories-union", async () => {
  const actual = await vi.importActual<
    typeof import("@repo/app/teams/hooks/use-team-repositories-union")
  >("@repo/app/teams/hooks/use-team-repositories-union");
  return {
    ...actual,
    useTeamRepositoriesUnion: (...args: unknown[]) =>
      mockUseTeamRepositoriesUnion(...args),
  };
});

vi.mock("@repo/navigation/link", () => ({
  Link: ({
    href,
    children,
    ...rest
  }: {
    href: string;
    children: React.ReactNode;
  }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));

vi.mock("next/navigation", () => ({
  useParams: () => ({ orgSlug: "acme" }),
}));

vi.mock("@repo/app/projects/components/detail/repo-override-picker", () => ({
  RepoOverridePicker: ({ projectId }: { projectId: string }) => (
    <div data-project-id={projectId} data-testid="repo-override-picker" />
  ),
}));

function teamRepo(
  overrides: Partial<TeamRepoWithTeamId> = {}
): TeamRepoWithTeamId {
  return {
    id: "team-repo-1",
    teamId: "team-1",
    installationRepositoryId: "install-repo-1",
    isDefaultSelected: true,
    isPrimary: true,
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    updatedAt: new Date("2026-01-01T00:00:00.000Z"),
    repository: {
      id: "install-repo-1",
      installationId: "installation-1",
      githubRepoId: "1",
      fullName: "closedloop-ai/closedloop-ai",
      name: "closedloop-ai",
      owner: "closedloop-ai",
      private: true,
    },
    ...overrides,
  };
}

function setDefaultMocks() {
  mockUseTeamMembers.mockReturnValue({
    members: [],
    isLoading: false,
    error: null,
  });
  mockUseGitHubIntegrationStatus.mockReturnValue({
    data: { connected: false },
  });
  mockUseTeamRepositoriesUnion.mockReturnValue({
    repositories: [],
    isLoading: false,
    error: null,
  });
  mockUseFeatureFlagEnabledOptional.mockReturnValue(false);
}

function enableUnsetPriority() {
  mockUseFeatureFlagEnabledOptional.mockImplementation(
    (key: string) => key === ARTIFACT_PRIORITY_UNSET_FLAG_KEY
  );
}

describe("OverviewProperties", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setDefaultMocks();
  });

  it("renders the Properties heading and field labels", () => {
    render(
      <OverviewProperties
        onUpdateAssignee={vi.fn()}
        onUpdatePriority={vi.fn()}
        onUpdateTargetDate={vi.fn()}
        project={makeProject()}
      />
    );

    expect(screen.getByText("Properties")).toBeInTheDocument();
    expect(screen.getByText("Priority")).toBeInTheDocument();
    expect(screen.getByText("Assignee")).toBeInTheDocument();
    expect(screen.getByText("Due Date")).toBeInTheDocument();
    expect(screen.getByText("Repos")).toBeInTheDocument();
  });

  it("shows the project's current priority label", () => {
    render(
      <OverviewProperties
        onUpdateAssignee={vi.fn()}
        onUpdatePriority={vi.fn()}
        onUpdateTargetDate={vi.fn()}
        project={makeProject({ priority: Priority.High })}
      />
    );

    expect(screen.getByText("High")).toBeInTheDocument();
  });

  it("calls onUpdatePriority with the newly selected priority", async () => {
    const onUpdatePriority = vi.fn();
    render(
      <OverviewProperties
        onUpdateAssignee={vi.fn()}
        onUpdatePriority={onUpdatePriority}
        onUpdateTargetDate={vi.fn()}
        project={makeProject({ priority: Priority.Medium })}
      />
    );

    screen.getByRole("combobox").click();
    await waitFor(() => {
      screen.getByText("Urgent").click();
    });

    expect(onUpdatePriority).toHaveBeenCalledWith(Priority.Urgent);
  });

  describe("unset priority (artifact-priority-unset)", () => {
    it("flag off: displays an unset priority as Medium, what the project always showed", () => {
      render(
        <OverviewProperties
          onUpdateAssignee={vi.fn()}
          onUpdatePriority={vi.fn()}
          onUpdateTargetDate={vi.fn()}
          project={makeProject({ priority: null })}
        />
      );

      expect(screen.getByRole("combobox")).toHaveTextContent(
        PRIORITY_LABELS[Priority.Medium]
      );
      expect(screen.queryByText(PRIORITY_LABEL_NONE)).not.toBeInTheDocument();
      expect(triggerPriorityIcon()).toHaveAttribute(
        "data-priority",
        Priority.Medium
      );
    });

    /**
     * ISS-9441 swaps this cell's control, flag ON only, from the `Select` to the
     * ISS-9307 champion — the only control that can offer the clear. So the
     * flag-ON cases read a menu trigger rather than a combobox. The unset state
     * keeps the mark-plus-"No priority" treatment PR 1 shipped here, because the
     * champion's absent path now honours the variant's own `label: Always`
     * declaration (see `paintsArtifactPriorityAbsentLabel`) rather than branching
     * on the shell alone — the projects grid's dense cell still paints the mark
     * alone.
     *
     * The trigger is therefore named by that word and not by
     * `priorityTriggerLabel`, which is WCAG 2.5.3 (ISS-9441): the accessible name
     * of a control has to contain what the reader can see on it.
     */
    it("flag on: displays an unset priority as the mark plus No priority, and never hands null to PriorityIcon", () => {
      enableUnsetPriority();

      render(
        <OverviewProperties
          onUpdateAssignee={vi.fn()}
          onUpdatePriority={vi.fn()}
          onUpdateTargetDate={vi.fn()}
          project={makeProject({ priority: null })}
        />
      );

      const trigger = championPriorityTrigger(PRIORITY_LABEL_NONE);
      expect(trigger).toBeInTheDocument();
      expect(trigger).toHaveTextContent("—");
      expect(trigger).toHaveTextContent(PRIORITY_LABEL_NONE);
      expect(trigger).not.toHaveTextContent(PRIORITY_LABELS[Priority.Medium]);
      expect(mockPriorityIconRender).not.toHaveBeenCalledWith(null);
    });

    it("flag on: a project that HAS a priority still shows its icon and label", () => {
      enableUnsetPriority();

      render(
        <OverviewProperties
          onUpdateAssignee={vi.fn()}
          onUpdatePriority={vi.fn()}
          onUpdateTargetDate={vi.fn()}
          project={makeProject({ priority: Priority.High })}
        />
      );

      const trigger = championPriorityTrigger(
        `Priority: ${PRIORITY_LABELS[Priority.High]}`
      );
      expect(trigger).toHaveTextContent(PRIORITY_LABELS[Priority.High]);
      expect(
        within(trigger).getByTestId(PRIORITY_ICON_TEST_ID)
      ).toHaveAttribute("data-priority", Priority.High);
    });

    it("flag on: offers No priority and clears through onUpdatePriority", async () => {
      enableUnsetPriority();
      const onUpdatePriority = vi.fn();

      render(
        <OverviewProperties
          onUpdateAssignee={vi.fn()}
          onUpdatePriority={onUpdatePriority}
          onUpdateTargetDate={vi.fn()}
          project={makeProject({ priority: Priority.High })}
        />
      );

      const user = userEvent.setup();
      await user.click(
        championPriorityTrigger(`Priority: ${PRIORITY_LABELS[Priority.High]}`)
      );
      await user.click(
        await screen.findByRole("menuitem", { name: PRIORITY_LABEL_NONE })
      );

      // `null` is what PUT /projects/[id] reads as the clear. This is the whole
      // point of the swap: the `Select` could only ever emit one of four members,
      // so a project that acquired a priority could never lose it again.
      expect(onUpdatePriority).toHaveBeenCalledWith(null);
    });

    it("flag off: the control offers the four members and no clear", async () => {
      render(
        <OverviewProperties
          onUpdateAssignee={vi.fn()}
          onUpdatePriority={vi.fn()}
          onUpdateTargetDate={vi.fn()}
          project={makeProject({ priority: Priority.High })}
        />
      );

      fireEvent.click(screen.getByRole("combobox"));

      expect(
        await screen.findByRole("option", {
          name: PRIORITY_LABELS[Priority.Urgent],
        })
      ).toBeInTheDocument();
      expect(
        screen.queryByRole("option", { name: PRIORITY_LABEL_NONE })
      ).toBeNull();
      expect(
        screen.queryByRole("menuitem", { name: PRIORITY_LABEL_NONE })
      ).toBeNull();
    });
  });

  it("shows Unassigned with the placeholder icon when there is no assignee", () => {
    render(
      <OverviewProperties
        onUpdateAssignee={vi.fn()}
        onUpdatePriority={vi.fn()}
        onUpdateTargetDate={vi.fn()}
        project={makeProject({ assignee: undefined })}
      />
    );

    expect(screen.getByText(UNASSIGNED_ASSIGNEE_LABEL)).toBeInTheDocument();
  });

  it("shows the assignee's display name and initials when assigned", () => {
    render(
      <OverviewProperties
        onUpdateAssignee={vi.fn()}
        onUpdatePriority={vi.fn()}
        onUpdateTargetDate={vi.fn()}
        project={makeProject({
          assignee: {
            id: "user-1",
            email: "ada@example.com",
            firstName: "Ada",
            lastName: "Lovelace",
            avatarUrl: null,
          },
        })}
      />
    );

    expect(screen.getByText("Ada Lovelace")).toBeInTheDocument();
    expect(
      screen.queryByText(UNASSIGNED_ASSIGNEE_LABEL)
    ).not.toBeInTheDocument();
  });

  it("shows the Set date placeholder when there is no target date", () => {
    render(
      <OverviewProperties
        onUpdateAssignee={vi.fn()}
        onUpdatePriority={vi.fn()}
        onUpdateTargetDate={vi.fn()}
        project={makeProject({ targetDate: null })}
      />
    );

    expect(screen.getByText("Set date")).toBeInTheDocument();
  });

  it("shows a Connect GitHub call-to-action when GitHub is not connected", () => {
    mockUseGitHubIntegrationStatus.mockReturnValue({
      data: { connected: false },
    });

    render(
      <OverviewProperties
        onUpdateAssignee={vi.fn()}
        onUpdatePriority={vi.fn()}
        onUpdateTargetDate={vi.fn()}
        project={makeProject()}
      />
    );

    const connectLink = screen.getByRole("link");
    expect(connectLink).toHaveAttribute(
      "href",
      `/acme${buildSettingsPanelRoute({ panel: SettingsPanelId.Profile })}`
    );
  });

  it("hides the Connect GitHub call-to-action once GitHub is connected", () => {
    mockUseGitHubIntegrationStatus.mockReturnValue({
      data: { connected: true },
    });
    mockUseTeamRepositoriesUnion.mockReturnValue({
      repositories: [teamRepo()],
      isLoading: false,
      error: null,
    });

    render(
      <OverviewProperties
        onUpdateAssignee={vi.fn()}
        onUpdatePriority={vi.fn()}
        onUpdateTargetDate={vi.fn()}
        project={makeProject()}
      />
    );

    expect(screen.queryByRole("link")).not.toBeInTheDocument();
  });

  it("shows a loading label in the Repos cell while the team-repository union loads", () => {
    mockUseGitHubIntegrationStatus.mockReturnValue({
      data: { connected: true },
    });
    mockUseTeamRepositoriesUnion.mockReturnValue({
      repositories: [],
      isLoading: true,
      error: null,
    });

    render(
      <OverviewProperties
        onUpdateAssignee={vi.fn()}
        onUpdatePriority={vi.fn()}
        onUpdateTargetDate={vi.fn()}
        project={makeProject()}
      />
    );

    expect(screen.getByText("Loading…")).toBeInTheDocument();
  });

  it("shows 'Set defaults' when GitHub is connected but no default repo is resolved", () => {
    mockUseGitHubIntegrationStatus.mockReturnValue({
      data: { connected: true },
    });
    mockUseTeamRepositoriesUnion.mockReturnValue({
      // The union across the project's two teams yields a single repo that is
      // neither primary nor default-selected, so no default repo resolves.
      repositories: [teamRepo({ isPrimary: false, isDefaultSelected: false })],
      isLoading: false,
      error: null,
    });

    render(
      <OverviewProperties
        onUpdateAssignee={vi.fn()}
        onUpdatePriority={vi.fn()}
        onUpdateTargetDate={vi.fn()}
        project={makeProject({
          teams: [
            { id: "team-1", name: "Team One" },
            { id: "team-2", name: "Team Two" },
          ],
        })}
      />
    );

    expect(screen.getByText("Set defaults")).toBeInTheDocument();
  });

  it("shows just the primary repo name when there are no additional selected repos", () => {
    mockUseGitHubIntegrationStatus.mockReturnValue({
      data: { connected: true },
    });
    mockUseTeamRepositoriesUnion.mockReturnValue({
      repositories: [teamRepo({ isPrimary: true, isDefaultSelected: true })],
      isLoading: false,
      error: null,
    });

    render(
      <OverviewProperties
        onUpdateAssignee={vi.fn()}
        onUpdatePriority={vi.fn()}
        onUpdateTargetDate={vi.fn()}
        project={makeProject({ teams: [{ id: "team-1", name: "Team One" }] })}
      />
    );

    expect(screen.getByText("closedloop-ai/closedloop-ai")).toBeInTheDocument();
  });

  it("shows the primary repo plus a count of additional selected repos", () => {
    mockUseGitHubIntegrationStatus.mockReturnValue({
      data: { connected: true },
    });
    mockUseTeamRepositoriesUnion.mockReturnValue({
      repositories: [
        teamRepo({
          installationRepositoryId: "install-repo-1",
          isPrimary: true,
          isDefaultSelected: true,
        }),
        teamRepo({
          installationRepositoryId: "install-repo-2",
          isPrimary: false,
          isDefaultSelected: true,
          repository: {
            id: "install-repo-2",
            installationId: "installation-1",
            githubRepoId: "2",
            fullName: "closedloop-ai/other-repo",
            name: "other-repo",
            owner: "closedloop-ai",
            private: true,
          },
        }),
      ],
      isLoading: false,
      error: null,
    });

    render(
      <OverviewProperties
        onUpdateAssignee={vi.fn()}
        onUpdatePriority={vi.fn()}
        onUpdateTargetDate={vi.fn()}
        project={makeProject({ teams: [{ id: "team-1", name: "Team One" }] })}
      />
    );

    expect(
      screen.getByText("closedloop-ai/closedloop-ai +1")
    ).toBeInTheDocument();
  });

  it("opens a popover exposing the RepoOverridePicker for the current project", async () => {
    mockUseGitHubIntegrationStatus.mockReturnValue({
      data: { connected: true },
    });
    mockUseTeamRepositoriesUnion.mockReturnValue({
      repositories: [teamRepo()],
      isLoading: false,
      error: null,
    });

    render(
      <OverviewProperties
        onUpdateAssignee={vi.fn()}
        onUpdatePriority={vi.fn()}
        onUpdateTargetDate={vi.fn()}
        project={makeProject({ id: "project-42" })}
      />
    );

    fireEvent.click(screen.getByText("closedloop-ai/closedloop-ai"));

    const picker = await screen.findByTestId("repo-override-picker");
    expect(picker).toHaveAttribute("data-project-id", "project-42");
  });

  it("fetches team members and repositories scoped to the project's team ids", () => {
    render(
      <OverviewProperties
        onUpdateAssignee={vi.fn()}
        onUpdatePriority={vi.fn()}
        onUpdateTargetDate={vi.fn()}
        project={makeProject({
          teams: [
            { id: "team-1", name: "Team One" },
            { id: "team-2", name: "Team Two" },
          ],
        })}
      />
    );

    expect(mockUseTeamMembers).toHaveBeenCalledWith({
      teamIds: ["team-1", "team-2"],
    });
    expect(mockUseTeamRepositoriesUnion).toHaveBeenCalledWith(
      expect.objectContaining({ teamIds: ["team-1", "team-2"] })
    );
  });
});

const PRIORITY_ICON_TEST_ID = "priority-icon";

/** The flag-OFF control: the `Select` this cell shipped with. */
function triggerPriorityIcon() {
  return within(screen.getByRole("combobox")).getByTestId(
    PRIORITY_ICON_TEST_ID
  );
}

/**
 * The flag-ON control: the champion's whole-cell trigger, which is a menu
 * button rather than a combobox and is named by the value it currently shows —
 * by its own `aria-label` for a value that is set, and by the word it paints
 * for one that is not (WCAG 2.5.3, ISS-9441). Looked up BY THAT NAME so a
 * trigger that stopped naming itself fails here instead of being found by role
 * alone.
 */
function championPriorityTrigger(name: string) {
  return screen.getByRole("button", { name });
}
