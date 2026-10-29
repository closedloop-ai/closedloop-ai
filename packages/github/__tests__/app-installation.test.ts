import { createAppAuth } from "@octokit/auth-app";
import { Octokit } from "@octokit/rest";
import { log } from "@repo/observability/log";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  GitHubAppInstallationLookupStatus,
  getAppInstallation,
} from "../app-installation";
import { boundedFetch } from "../bounded-fetch";

const { mockGetInstallation } = vi.hoisted(() => ({
  mockGetInstallation: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("@repo/observability/log", () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock("@octokit/auth-app", () => ({ createAppAuth: vi.fn() }));
vi.mock("@octokit/rest", () => ({
  Octokit: vi.fn(function octokitMock() {
    return { apps: { getInstallation: mockGetInstallation } };
  }),
}));
vi.mock("../keys", () => ({
  keys: () => ({
    GITHUB_APP_ID: "123",
    GITHUB_APP_PRIVATE_KEY: "private-key",
  }),
}));

const WIRE_INSTALLATION = {
  id: 100,
  account: { id: 7, login: "acme", type: "Organization" },
  permissions: { contents: "read" },
  events: ["push"],
  repository_selection: "all",
};

describe("getAppInstallation", () => {
  const fetchInstallation = vi.fn();

  beforeEach(() => {
    fetchInstallation.mockReset();
  });

  it("maps a found installation onto the camelCase shape", async () => {
    fetchInstallation.mockResolvedValue(WIRE_INSTALLATION);

    const result = await getAppInstallation("100", { fetchInstallation });

    expect(result).toEqual({
      status: GitHubAppInstallationLookupStatus.Found,
      installation: {
        id: 100,
        account: { id: 7, login: "acme", type: "Organization" },
        permissions: { contents: "read" },
        events: ["push"],
        repositorySelection: "all",
      },
    });
    expect(fetchInstallation).toHaveBeenCalledWith(100);
  });

  it("treats an account-less installation as unsupported", async () => {
    fetchInstallation.mockResolvedValue({
      ...WIRE_INSTALLATION,
      account: null,
    });

    const result = await getAppInstallation("100", { fetchInstallation });

    expect(result).toEqual({
      status: GitHubAppInstallationLookupStatus.Unsupported,
    });
  });

  it("treats an Enterprise account as unsupported, not a wire regression", async () => {
    // An Enterprise account carries `slug`/`name` and neither `login` nor
    // `type`. It is an ordinary installation this flow cannot claim — not the
    // schema break the `Error` status (and its error-level log) is for.
    fetchInstallation.mockResolvedValue({
      ...WIRE_INSTALLATION,
      account: { id: 7, slug: "acme-enterprise", name: "Acme Enterprise" },
    });

    const result = await getAppInstallation("100", { fetchInstallation });

    expect(result).toEqual({
      status: GitHubAppInstallationLookupStatus.Unsupported,
    });
  });

  // cr-66737 domain_0_f0: a schema-parse failure is a wire-format regression
  // and must stay distinguishable from an ordinary unclaimable installation.
  it("maps a malformed payload onto error, never unsupported or a crash", async () => {
    fetchInstallation.mockResolvedValue({ id: "not-a-number" });

    const result = await getAppInstallation("100", { fetchInstallation });

    expect(result).toEqual({
      status: GitHubAppInstallationLookupStatus.Error,
    });
  });

  it("maps a 404 onto not_found", async () => {
    fetchInstallation.mockRejectedValue(
      Object.assign(new Error("Not Found"), { status: 404 })
    );

    const result = await getAppInstallation("100", { fetchInstallation });

    expect(result).toEqual({
      status: GitHubAppInstallationLookupStatus.NotFound,
    });
  });

  it("maps other provider failures onto error", async () => {
    fetchInstallation.mockRejectedValue(
      Object.assign(new Error("boom"), { status: 500 })
    );

    const result = await getAppInstallation("100", { fetchInstallation });

    expect(result).toEqual({
      status: GitHubAppInstallationLookupStatus.Error,
    });
  });

  it("rejects a non-numeric id without calling GitHub", async () => {
    const result = await getAppInstallation("not-a-number", {
      fetchInstallation,
    });

    expect(result).toEqual({
      status: GitHubAppInstallationLookupStatus.NotFound,
    });
    expect(fetchInstallation).not.toHaveBeenCalled();
  });

  it("defaults permissions, events and repositorySelection when the wire omits them", async () => {
    fetchInstallation.mockResolvedValue({
      id: 100,
      account: WIRE_INSTALLATION.account,
    });

    const result = await getAppInstallation("100", { fetchInstallation });

    expect(result).toEqual({
      status: GitHubAppInstallationLookupStatus.Found,
      installation: {
        id: 100,
        account: WIRE_INSTALLATION.account,
        permissions: {},
        events: [],
        repositorySelection: null,
      },
    });
  });

  it("logs Unknown error when the provider rejects with a non-Error value", async () => {
    fetchInstallation.mockRejectedValue("boom");

    const result = await getAppInstallation("100", { fetchInstallation });

    expect(result).toEqual({
      status: GitHubAppInstallationLookupStatus.Error,
    });
    expect(log.error).toHaveBeenCalledWith(
      "[github/app] Failed to fetch installation",
      { installationId: "100", error: "Unknown error" }
    );
  });

  it("looks the installation up through a bounded App-authenticated Octokit by default", async () => {
    mockGetInstallation.mockResolvedValue({ data: WIRE_INSTALLATION });

    const result = await getAppInstallation("100");

    expect(result.status).toBe(GitHubAppInstallationLookupStatus.Found);
    expect(mockGetInstallation).toHaveBeenCalledWith({ installation_id: 100 });
    expect(vi.mocked(Octokit)).toHaveBeenCalledWith({
      authStrategy: createAppAuth,
      auth: { appId: "123", privateKey: "private-key" },
      request: { fetch: boundedFetch },
    });
  });
});
