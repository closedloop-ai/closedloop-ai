/**
 * Unit tests for workflow_run event routing and correlation ID validation.
 *
 * Tests the handleWorkflowRun function which:
 * - Filters events by workflow path (symphony-dispatch only)
 * - Extracts and validates correlation ID from run name
 * - Checks environment matching via isCurrentEnvironment
 * - Routes to appropriate handler based on action type
 */
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  type Mock,
  vi,
} from "vitest";
import type { WorkflowRunEvent } from "@/app/webhooks/github/types";

// Mock modules before importing
vi.mock("@repo/observability/log", () => ({
  log: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock("@repo/github", () => ({
  isCurrentEnvironment: vi.fn(),
}));

vi.mock("@/app/webhooks/github/handlers/workflow-status-handler", () => ({
  handleWorkflowStatusUpdate: vi.fn(),
}));

vi.mock("@/app/webhooks/github/handlers/workflow-completion-handler", () => ({
  processWorkflowCompletion: vi.fn(),
}));

// Import after mocking
import { isCurrentEnvironment } from "@repo/github";
import { processWorkflowCompletion } from "@/app/webhooks/github/handlers/workflow-completion-handler";
import { handleWorkflowRun } from "@/app/webhooks/github/handlers/workflow-run-handler";
import { handleWorkflowStatusUpdate } from "@/app/webhooks/github/handlers/workflow-status-handler";

// Type aliases for mocked functions
const mockIsCurrentEnvironment = isCurrentEnvironment as Mock;
const mockHandleWorkflowStatusUpdate = handleWorkflowStatusUpdate as Mock;
const mockProcessWorkflowCompletion = processWorkflowCompletion as Mock;

// Helper for repository object with required custom_properties field
function createRepositoryObject() {
  return {
    id: 1,
    node_id: "R_1",
    name: "test-repo",
    full_name: "owner/test-repo",
    private: false,
    owner: {
      login: "owner",
      id: 1,
      node_id: "U_1",
      avatar_url: "",
      gravatar_id: "",
      url: "",
      html_url: "",
      followers_url: "",
      following_url: "",
      gists_url: "",
      starred_url: "",
      subscriptions_url: "",
      organizations_url: "",
      repos_url: "",
      events_url: "",
      received_events_url: "",
      type: "Organization" as const,
      site_admin: false,
    },
    html_url: "",
    description: null,
    fork: false,
    url: "",
    forks_url: "",
    keys_url: "",
    collaborators_url: "",
    teams_url: "",
    hooks_url: "",
    issue_events_url: "",
    events_url: "",
    assignees_url: "",
    branches_url: "",
    tags_url: "",
    blobs_url: "",
    git_tags_url: "",
    git_refs_url: "",
    trees_url: "",
    statuses_url: "",
    languages_url: "",
    stargazers_url: "",
    contributors_url: "",
    subscribers_url: "",
    subscription_url: "",
    commits_url: "",
    git_commits_url: "",
    comments_url: "",
    issue_comment_url: "",
    contents_url: "",
    compare_url: "",
    merges_url: "",
    archive_url: "",
    downloads_url: "",
    issues_url: "",
    pulls_url: "",
    milestones_url: "",
    notifications_url: "",
    labels_url: "",
    releases_url: "",
    deployments_url: "",
    created_at: "2020-01-01T00:00:00Z",
    updated_at: "2026-02-06T00:00:00Z",
    pushed_at: "2026-02-06T00:00:00Z",
    git_url: "",
    ssh_url: "",
    clone_url: "",
    svn_url: "",
    homepage: null,
    size: 100,
    stargazers_count: 0,
    watchers_count: 0,
    language: "TypeScript",
    has_issues: true,
    has_projects: true,
    has_downloads: true,
    has_wiki: true,
    has_pages: false,
    has_discussions: false,
    forks_count: 0,
    mirror_url: null,
    archived: false,
    disabled: false,
    open_issues_count: 0,
    license: null,
    allow_forking: true,
    is_template: false,
    web_commit_signoff_required: false,
    topics: [],
    visibility: "public" as const,
    forks: 0,
    open_issues: 0,
    watchers: 0,
    default_branch: "main",
    custom_properties: {},
  };
}

// Helper to create minimal workflow_run event
function createWorkflowRunEvent(
  action: "requested" | "in_progress" | "completed",
  workflowPath: string,
  runName: string,
  conclusion?: string
): WorkflowRunEvent {
  const baseEvent = {
    action,
    workflow: {
      id: 123_456,
      node_id: "W_123456",
      name: "Test Workflow",
      path: workflowPath,
      state: "active" as const,
      created_at: "2026-02-06T00:00:00Z",
      updated_at: "2026-02-06T00:00:00Z",
      url: "https://api.github.com/repos/owner/repo/actions/workflows/123456",
      html_url: "https://github.com/owner/repo/actions/workflows/test.yml",
      badge_url: "https://github.com/owner/repo/workflows/test/badge.svg",
    },
    workflow_run: {
      id: 987_654_321,
      name: runName,
      node_id: "WR_123",
      head_branch: "main",
      head_sha: "abc123",
      path: workflowPath,
      display_title: "Test Run",
      run_number: 42,
      event: "workflow_dispatch",
      status: action === "completed" ? "completed" : "in_progress",
      conclusion: conclusion as any,
      workflow_id: 123_456,
      check_suite_id: 111_111,
      check_suite_node_id: "CS_111",
      url: "https://api.github.com/repos/owner/repo/actions/runs/987654321",
      html_url: "https://github.com/owner/repo/actions/runs/987654321",
      pull_requests: [],
      created_at: "2026-02-06T00:00:00Z",
      updated_at: "2026-02-06T00:00:00Z",
      actor: {
        login: "test-user",
        id: 1,
        node_id: "U_1",
        avatar_url: "",
        gravatar_id: "",
        url: "",
        html_url: "",
        followers_url: "",
        following_url: "",
        gists_url: "",
        starred_url: "",
        subscriptions_url: "",
        organizations_url: "",
        repos_url: "",
        events_url: "",
        received_events_url: "",
        type: "User",
        site_admin: false,
      },
      run_attempt: 1,
      referenced_workflows: [],
      run_started_at: "2026-02-06T00:00:00Z",
      triggering_actor: {
        login: "test-user",
        id: 1,
        node_id: "U_1",
        avatar_url: "",
        gravatar_id: "",
        url: "",
        html_url: "",
        followers_url: "",
        following_url: "",
        gists_url: "",
        starred_url: "",
        subscriptions_url: "",
        organizations_url: "",
        repos_url: "",
        events_url: "",
        received_events_url: "",
        type: "User",
        site_admin: false,
      },
      jobs_url: "",
      logs_url: "",
      check_suite_url: "",
      artifacts_url: "",
      cancel_url: "",
      rerun_url: "",
      previous_attempt_url: null,
      workflow_url: "",
      head_commit: {
        id: "abc123",
        tree_id: "tree123",
        message: "Test commit",
        timestamp: "2026-02-06T00:00:00Z",
        author: {
          name: "Test User",
          email: "test@example.com",
        },
        committer: {
          name: "Test User",
          email: "test@example.com",
        },
      },
      repository: {
        id: 1,
        node_id: "R_1",
        name: "test-repo",
        full_name: "owner/test-repo",
        private: false,
        owner: {
          login: "owner",
          id: 1,
          node_id: "U_1",
          avatar_url: "",
          gravatar_id: "",
          url: "",
          html_url: "",
          followers_url: "",
          following_url: "",
          gists_url: "",
          starred_url: "",
          subscriptions_url: "",
          organizations_url: "",
          repos_url: "",
          events_url: "",
          received_events_url: "",
          type: "Organization",
          site_admin: false,
        },
        html_url: "",
        description: null,
        fork: false,
        url: "",
        forks_url: "",
        keys_url: "",
        collaborators_url: "",
        teams_url: "",
        hooks_url: "",
        issue_events_url: "",
        events_url: "",
        assignees_url: "",
        branches_url: "",
        tags_url: "",
        blobs_url: "",
        git_tags_url: "",
        git_refs_url: "",
        trees_url: "",
        statuses_url: "",
        languages_url: "",
        stargazers_url: "",
        contributors_url: "",
        subscribers_url: "",
        subscription_url: "",
        commits_url: "",
        git_commits_url: "",
        comments_url: "",
        issue_comment_url: "",
        contents_url: "",
        compare_url: "",
        merges_url: "",
        archive_url: "",
        downloads_url: "",
        issues_url: "",
        pulls_url: "",
        milestones_url: "",
        notifications_url: "",
        labels_url: "",
        releases_url: "",
        deployments_url: "",
      },
      head_repository: createRepositoryObject(),
    },
    organization: undefined,
    repository: createRepositoryObject(),
    sender: {
      login: "test-user",
      id: 1,
      node_id: "U_1",
      avatar_url: "",
      gravatar_id: "",
      url: "",
      html_url: "",
      followers_url: "",
      following_url: "",
      gists_url: "",
      starred_url: "",
      subscriptions_url: "",
      organizations_url: "",
      repos_url: "",
      events_url: "",
      received_events_url: "",
      type: "User",
      site_admin: false,
    },
    installation: undefined,
  };

  return baseEvent as WorkflowRunEvent;
}

describe("handleWorkflowRun", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Default to current environment
    mockIsCurrentEnvironment.mockReturnValue(true);
    // Default handler responses
    mockHandleWorkflowStatusUpdate.mockResolvedValue(
      Response.json({ result: "status_updated", ok: true })
    );
    mockProcessWorkflowCompletion.mockResolvedValue(
      Response.json({ result: "processed", ok: true })
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("workflow path filtering", () => {
    it("ignores non-symphony-dispatch workflows", async () => {
      const event = createWorkflowRunEvent(
        "requested",
        ".github/workflows/ci.yml",
        "stage-correlation-123"
      );

      const response = await handleWorkflowRun(event);
      const body = await response.json();

      expect(body).toEqual({
        message: "Ignoring workflow: Test Workflow",
        ok: true,
      });
      expect(mockHandleWorkflowStatusUpdate).not.toHaveBeenCalled();
      expect(mockProcessWorkflowCompletion).not.toHaveBeenCalled();
    });

    it("processes workflows with symphony-dispatch in path", async () => {
      const event = createWorkflowRunEvent(
        "requested",
        ".github/workflows/symphony-dispatch.yml",
        "stage-correlation-123"
      );

      await handleWorkflowRun(event);

      expect(mockHandleWorkflowStatusUpdate).toHaveBeenCalledWith(
        "stage-correlation-123",
        "requested",
        987_654_321,
        "https://github.com/owner/repo/actions/runs/987654321"
      );
    });
  });

  describe("correlation ID extraction and validation", () => {
    it("extracts correlation ID from workflow_run.name", async () => {
      const event = createWorkflowRunEvent(
        "requested",
        ".github/workflows/symphony-dispatch.yml",
        "prod-correlation-456"
      );

      await handleWorkflowRun(event);

      expect(mockIsCurrentEnvironment).toHaveBeenCalledWith(
        "prod-correlation-456"
      );
    });

    it("ignores events for different environments", async () => {
      mockIsCurrentEnvironment.mockReturnValue(false);

      const event = createWorkflowRunEvent(
        "requested",
        ".github/workflows/symphony-dispatch.yml",
        "prod-correlation-456"
      );

      const response = await handleWorkflowRun(event);
      const body = await response.json();

      expect(body).toEqual({
        message: "Event for different environment, ignoring",
        ok: true,
      });
      expect(mockHandleWorkflowStatusUpdate).not.toHaveBeenCalled();
      expect(mockProcessWorkflowCompletion).not.toHaveBeenCalled();
    });

    it("processes events for current environment", async () => {
      mockIsCurrentEnvironment.mockReturnValue(true);

      const event = createWorkflowRunEvent(
        "in_progress",
        ".github/workflows/symphony-dispatch.yml",
        "stage-correlation-789"
      );

      await handleWorkflowRun(event);

      expect(mockHandleWorkflowStatusUpdate).toHaveBeenCalledWith(
        "stage-correlation-789",
        "in_progress",
        987_654_321,
        "https://github.com/owner/repo/actions/runs/987654321"
      );
    });
  });

  describe("action routing", () => {
    it("routes 'requested' action to handleWorkflowStatusUpdate", async () => {
      const event = createWorkflowRunEvent(
        "requested",
        ".github/workflows/symphony-dispatch.yml",
        "stage-correlation-123"
      );

      await handleWorkflowRun(event);

      expect(mockHandleWorkflowStatusUpdate).toHaveBeenCalledWith(
        "stage-correlation-123",
        "requested",
        987_654_321,
        "https://github.com/owner/repo/actions/runs/987654321"
      );
      expect(mockProcessWorkflowCompletion).not.toHaveBeenCalled();
    });

    it("routes 'in_progress' action to handleWorkflowStatusUpdate", async () => {
      const event = createWorkflowRunEvent(
        "in_progress",
        ".github/workflows/symphony-dispatch.yml",
        "stage-correlation-456"
      );

      await handleWorkflowRun(event);

      expect(mockHandleWorkflowStatusUpdate).toHaveBeenCalledWith(
        "stage-correlation-456",
        "in_progress",
        987_654_321,
        "https://github.com/owner/repo/actions/runs/987654321"
      );
      expect(mockProcessWorkflowCompletion).not.toHaveBeenCalled();
    });

    it("routes 'completed' action to processWorkflowCompletion", async () => {
      const event = createWorkflowRunEvent(
        "completed",
        ".github/workflows/symphony-dispatch.yml",
        "stage-correlation-789",
        "success"
      );

      await handleWorkflowRun(event);

      expect(mockProcessWorkflowCompletion).toHaveBeenCalledWith(
        event,
        "stage-correlation-789"
      );
      expect(mockHandleWorkflowStatusUpdate).not.toHaveBeenCalled();
    });
  });

  describe("unhandled actions", () => {
    it("ignores unhandled action types", async () => {
      // Create an event with an unhandled action by casting
      const event = createWorkflowRunEvent(
        "requested",
        ".github/workflows/symphony-dispatch.yml",
        "stage-correlation-123"
      );
      // Override action to simulate an unhandled type
      (event as any).action = "unknown_action";

      const response = await handleWorkflowRun(event as any);
      const body = await response.json();

      expect(body).toEqual({
        message: "Ignoring action: unknown_action",
        ok: true,
      });
      expect(mockHandleWorkflowStatusUpdate).not.toHaveBeenCalled();
      expect(mockProcessWorkflowCompletion).not.toHaveBeenCalled();
    });
  });

  describe("integration scenarios", () => {
    it("handles full workflow lifecycle: requested -> in_progress -> completed", async () => {
      const correlationId = "stage-workflow-123";
      const workflowPath = ".github/workflows/symphony-dispatch.yml";

      // 1. requested
      const requestedEvent = createWorkflowRunEvent(
        "requested",
        workflowPath,
        correlationId
      );
      await handleWorkflowRun(requestedEvent);
      expect(mockHandleWorkflowStatusUpdate).toHaveBeenCalledWith(
        correlationId,
        "requested",
        987_654_321,
        expect.any(String)
      );

      vi.clearAllMocks();

      // 2. in_progress
      const inProgressEvent = createWorkflowRunEvent(
        "in_progress",
        workflowPath,
        correlationId
      );
      await handleWorkflowRun(inProgressEvent);
      expect(mockHandleWorkflowStatusUpdate).toHaveBeenCalledWith(
        correlationId,
        "in_progress",
        987_654_321,
        expect.any(String)
      );

      vi.clearAllMocks();

      // 3. completed
      const completedEvent = createWorkflowRunEvent(
        "completed",
        workflowPath,
        correlationId,
        "success"
      );
      await handleWorkflowRun(completedEvent);
      expect(mockProcessWorkflowCompletion).toHaveBeenCalledWith(
        completedEvent,
        correlationId
      );
    });

    it("handles different environments in parallel workflows", async () => {
      const workflowPath = ".github/workflows/symphony-dispatch.yml";

      // Stage environment event (should process)
      mockIsCurrentEnvironment.mockImplementation((id) =>
        id.startsWith("stage-")
      );
      const stageEvent = createWorkflowRunEvent(
        "requested",
        workflowPath,
        "stage-correlation-1"
      );
      await handleWorkflowRun(stageEvent);
      expect(mockHandleWorkflowStatusUpdate).toHaveBeenCalled();

      vi.clearAllMocks();

      // Prod environment event (should ignore if we're in stage)
      mockIsCurrentEnvironment.mockImplementation((id) =>
        id.startsWith("stage-")
      );
      const prodEvent = createWorkflowRunEvent(
        "requested",
        workflowPath,
        "prod-correlation-2"
      );
      const response = await handleWorkflowRun(prodEvent);
      const body = await response.json();

      expect(body).toEqual({
        message: "Event for different environment, ignoring",
        ok: true,
      });
      expect(mockHandleWorkflowStatusUpdate).not.toHaveBeenCalled();
    });
  });
});
