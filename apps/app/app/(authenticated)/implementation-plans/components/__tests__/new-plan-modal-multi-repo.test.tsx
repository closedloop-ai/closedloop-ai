import type {
  AdditionalRepoRef,
  InheritedAdditionalRepos,
} from "@repo/api/src/types/loop";
import { LoopCommand } from "@repo/api/src/types/loop";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NewPlanModal } from "../new-plan-modal";
import type { PlanSource } from "../plan-source";

// PLN-462: pre-fill behaviour for the new-plan modal's additionalRepos picker.
// The selection logic (latest COMPLETED PLAN > non-failed terminal PLAN >
// latest COMPLETED GENERATE_PRD > non-failed terminal GENERATE_PRD > none)
// lives in `loopsService.findInheritedAdditionalRepos` and is exercised by
// its own unit test. These tests stub the response and verify the modal
// surfaces it correctly.

// ---- Module-level mocks ----

const mockUseRouter = vi.fn();
const mockUseDocuments = vi.fn();
const mockUseCreateDocument = vi.fn();
const mockUseCreateAndGenerateDocument = vi.fn();
const mockUseProjects = vi.fn();
const mockUseProject = vi.fn();
const mockUsePreLoopGate = vi.fn();
const mockUseMultiRepoExecuteEnabled = vi.fn();
const mockUseInheritedAdditionalRepos = vi.fn();

vi.mock("next/navigation", () => ({
  useRouter: () => mockUseRouter(),
}));

vi.mock("@/hooks/queries/use-documents", () => ({
  useDocuments: () => mockUseDocuments(),
  useCreateDocument: () => mockUseCreateDocument(),
  useCreateAndGenerateDocument: () => mockUseCreateAndGenerateDocument(),
}));

vi.mock("@repo/api/src/types/project", async () => {
  const actual = await vi.importActual("@repo/api/src/types/project");
  return {
    ...actual,
    getProjectSettings: () => ({}),
  };
});

vi.mock("@/hooks/queries/use-projects", () => ({
  useProject: (...args: unknown[]) => mockUseProject(...args),
  useProjects: () => mockUseProjects(),
}));

vi.mock("@/lib/system-check/pre-loop-system-check-provider", () => ({
  useOptionalPreLoopSystemCheckGate: () => mockUsePreLoopGate(),
}));

vi.mock("@/hooks/use-multi-repo-execute-enabled", () => ({
  useMultiRepoExecuteEnabled: () => mockUseMultiRepoExecuteEnabled(),
}));

vi.mock("@/hooks/queries/use-loops", () => ({
  useInheritedAdditionalRepos: (...args: unknown[]) =>
    mockUseInheritedAdditionalRepos(...args),
}));

vi.mock("@/hooks/queries/use-github-integration", () => ({
  useGitHubIntegrationStatus: () => ({
    data: { connected: false },
    isLoading: false,
  }),
  useGitHubRepositories: () => ({ data: [], isLoading: false }),
  useGitHubBranches: () => ({ data: undefined, isLoading: false }),
}));

// Capture each render's initialValue + the latest onChange so tests can drive
// edits without standing up the full picker UI (which depends on GitHub APIs).
type PickerSnapshot = {
  initialValue: AdditionalRepoRef[];
  onChange: (repos: AdditionalRepoRef[]) => void;
};
const pickerSnapshots: PickerSnapshot[] = [];
function recordPicker(snapshot: PickerSnapshot): void {
  pickerSnapshots.push(snapshot);
}

vi.mock("../additional-repos-picker", () => ({
  AdditionalReposPicker: ({
    initialValue,
    onChange,
  }: {
    initialValue: AdditionalRepoRef[];
    onChange: (repos: AdditionalRepoRef[]) => void;
    onIncompleteChange?: (hasIncomplete: boolean) => void;
    targetRepo: string;
  }) => {
    recordPicker({ initialValue, onChange });
    return (
      <div
        data-initial-value={JSON.stringify(initialValue)}
        data-testid="additional-repos-picker"
      />
    );
  },
}));

// ---- Helpers ----

function createMockSource(overrides?: Partial<PlanSource>): PlanSource {
  return {
    id: "prd-1",
    title: "Multi-repo PRD",
    targetRepo: "org/primary",
    targetBranch: "main",
    ...overrides,
  } as PlanSource;
}

function setupInherited(
  response: InheritedAdditionalRepos | undefined,
  isFetched = true
): void {
  mockUseInheritedAdditionalRepos.mockReturnValue({
    data: response,
    isFetched,
  });
}

const PEERS_FROM_BACKEND: AdditionalRepoRef[] = [
  { fullName: "org/peer-a", branch: "main" },
  { fullName: "org/peer-b", branch: "main" },
];

const GENERATE_PLAN_REGEX = /generate plan/i;

function setupBaseMocks(): void {
  mockUseRouter.mockReturnValue({ push: vi.fn() });
  mockUseDocuments.mockReturnValue({
    data: [],
    isLoading: false,
    error: null,
  });
  mockUseCreateDocument.mockReturnValue({
    mutate: vi.fn(),
    isPending: false,
  });
  mockUseCreateAndGenerateDocument.mockReturnValue({
    mutate: vi.fn(),
    isPending: false,
  });
  mockUseProjects.mockReturnValue({
    data: [],
    isLoading: false,
    error: null,
  });
  mockUseProject.mockReturnValue({ data: null, isLoading: false });
  mockUsePreLoopGate.mockReturnValue(null);
  mockUseMultiRepoExecuteEnabled.mockReturnValue(true);
  setupInherited({ additionalRepos: [], source: null });
}

// ---- Tests ----

describe("NewPlanModal additionalRepos pre-fill (PLN-462)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    pickerSnapshots.length = 0;
    setupBaseMocks();
  });

  afterEach(() => {
    cleanup();
  });

  it("seeds the picker with the inherited peer set the backend returns", async () => {
    setupInherited({
      additionalRepos: PEERS_FROM_BACKEND,
      source: { loopId: "loop-1", command: LoopCommand.GeneratePrd },
    });

    render(<NewPlanModal open={true} source={createMockSource()} />);

    await waitFor(() => {
      const pickerEl = screen.getByTestId("additional-repos-picker");
      expect(
        JSON.parse(pickerEl.getAttribute("data-initial-value") ?? "[]")
      ).toEqual(PEERS_FROM_BACKEND);
    });
  });

  it("leaves the picker empty when the backend returns no inheritable source", async () => {
    setupInherited({ additionalRepos: [], source: null });

    render(<NewPlanModal open={true} source={createMockSource()} />);

    await waitFor(() => {
      expect(screen.getByTestId("additional-repos-picker")).toBeInTheDocument();
    });

    for (const snapshot of pickerSnapshots) {
      expect(snapshot.initialValue).toEqual([]);
    }
  });

  it("re-seeds when the source PRD changes within an open modal", async () => {
    const PEERS_FROM_PRD_A: AdditionalRepoRef[] = [
      { fullName: "org/peer-from-a-1", branch: "main" },
      { fullName: "org/peer-from-a-2", branch: "main" },
    ];
    const PEERS_FROM_PRD_B: AdditionalRepoRef[] = [
      { fullName: "org/peer-from-b", branch: "develop" },
    ];

    setupInherited({
      additionalRepos: PEERS_FROM_PRD_A,
      source: { loopId: "loop-a", command: LoopCommand.GeneratePrd },
    });
    const sourceA = createMockSource({ id: "prd-a" });
    const { rerender } = render(<NewPlanModal open={true} source={sourceA} />);

    await waitFor(() => {
      expect(pickerSnapshots.at(-1)?.initialValue).toEqual(PEERS_FROM_PRD_A);
    });

    // User changes the source PRD in the dropdown — the modal stays mounted
    // but the source prop swaps. The inherit hook must drop PRD-A's stale
    // peers and re-seed from PRD-B once the new query lands.
    setupInherited({
      additionalRepos: PEERS_FROM_PRD_B,
      source: { loopId: "loop-b", command: LoopCommand.GeneratePrd },
    });
    const sourceB = createMockSource({ id: "prd-b" });
    rerender(<NewPlanModal open={true} source={sourceB} />);

    await waitFor(() => {
      expect(pickerSnapshots.at(-1)?.initialValue).toEqual(PEERS_FROM_PRD_B);
    });
  });

  it("clears stale peers when switching to a single-repo source", async () => {
    setupInherited({
      additionalRepos: PEERS_FROM_BACKEND,
      source: { loopId: "loop-a", command: LoopCommand.GeneratePrd },
    });
    const sourceA = createMockSource({ id: "prd-a" });
    const { rerender } = render(<NewPlanModal open={true} source={sourceA} />);

    await waitFor(() => {
      expect(pickerSnapshots.at(-1)?.initialValue).toEqual(PEERS_FROM_BACKEND);
    });

    // Switch to a single-repo PRD whose backend response has no peers. The
    // picker must reflect the new source's empty peer set, not retain the
    // previous source's list.
    setupInherited({ additionalRepos: [], source: null });
    const sourceB = createMockSource({ id: "prd-b" });
    rerender(<NewPlanModal open={true} source={sourceB} />);

    await waitFor(() => {
      expect(pickerSnapshots.at(-1)?.initialValue).toEqual([]);
    });
  });

  it("does not overwrite user edits made before the query resolves", async () => {
    // Open the modal with the query still pending.
    setupInherited(undefined, false);

    const { rerender } = render(
      <NewPlanModal open={true} source={createMockSource()} />
    );

    // User makes an edit before the query resolves.
    const userEdits: AdditionalRepoRef[] = [
      { fullName: "org/user-edit", branch: "feature" },
    ];
    act(() => {
      pickerSnapshots.at(-1)?.onChange(userEdits);
    });

    // Late-arriving response would otherwise seed the picker.
    setupInherited({
      additionalRepos: PEERS_FROM_BACKEND,
      source: { loopId: "loop-1", command: LoopCommand.GeneratePrd },
    });
    rerender(<NewPlanModal open={true} source={createMockSource()} />);

    await waitFor(() => {
      expect(pickerSnapshots.length).toBeGreaterThan(1);
    });

    // The latest picker mount carries the user's edits, not the inherited
    // peers — the hasInitialized ref blocks the late seed.
    const last = pickerSnapshots.at(-1);
    expect(last?.initialValue).toEqual(userEdits);
  });

  it("submits the user's edited list, not the seeded list, on Generate Plan", async () => {
    const mockCreateAndGenerate = vi.fn();
    mockUseCreateAndGenerateDocument.mockReturnValue({
      mutate: mockCreateAndGenerate,
      isPending: false,
    });
    setupInherited({
      additionalRepos: PEERS_FROM_BACKEND,
      source: { loopId: "loop-1", command: LoopCommand.GeneratePrd },
    });

    render(<NewPlanModal open={true} source={createMockSource()} />);

    await waitFor(() => {
      expect(pickerSnapshots.length).toBeGreaterThan(0);
    });

    const edited: AdditionalRepoRef[] = [
      { fullName: "org/peer-a", branch: "main" },
      { fullName: "org/added-by-user", branch: "develop" },
    ];
    act(() => {
      pickerSnapshots.at(-1)?.onChange(edited);
    });

    fireEvent.click(screen.getByRole("button", { name: GENERATE_PLAN_REGEX }));

    await waitFor(() => {
      expect(mockCreateAndGenerate).toHaveBeenCalled();
    });

    expect(mockCreateAndGenerate.mock.calls[0][0].additionalRepos).toEqual(
      edited
    );
  });
});
