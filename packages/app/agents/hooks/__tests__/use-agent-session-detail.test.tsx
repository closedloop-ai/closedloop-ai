import type { AgentSessionDetail } from "@repo/api/src/types/agent-session";
import { render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { AppCoreStoryProviders } from "../../../shared/storybook/decorators";
import {
  createAgentSessionDetailFixture,
  populatedAgentSessionDetailFixture,
} from "../../components/detail/agent-session-detail-fixtures";
import { AgentSessionDetailView } from "../../components/detail/agent-session-detail-view";
import type { AgentSessionsDataSource } from "../../data-source/agent-sessions-data-source";
import { AgentSessionsDataSourceProvider } from "../../data-source/provider";
import { agentSessionKeys, useAgentSessionDetail } from "../use-agent-sessions";

const UNSAFE_DETAIL_TEXT_PATTERN = /Invalid Date|undefined|NaN/;

describe("useAgentSessionDetail", () => {
  it("keeps the exact query key/API path and renders revived dates through the shared detail view", async () => {
    const requests: string[] = [];
    let releaseDetail!: (session: AgentSessionDetail) => void;

    render(
      <AppCoreStoryProviders
        apiRoutes={[
          {
            method: "GET",
            path: "/agent-sessions/session-detail-1",
            respond: ({ pathname }) => {
              requests.push(pathname);
              return new Promise((resolve) => {
                releaseDetail = resolve;
              });
            },
          },
        ]}
      >
        <DetailProbe id="session-detail-1" />
      </AppCoreStoryProviders>
    );

    expect(agentSessionKeys.detail("http", "session-detail-1")).toEqual([
      "agent-sessions",
      "detail",
      "http",
      "session-detail-1",
    ]);

    expect(document.querySelector(".animate-pulse")).toBeInTheDocument();
    await waitFor(() =>
      expect(requests).toEqual(["/agent-sessions/session-detail-1"])
    );

    releaseDetail(populatedAgentSessionDetailFixture);
    expect(
      await screen.findByText("Desktop implementation session")
    ).toBeInTheDocument();
    expect(screen.getByText("Session Trace")).toBeInTheDocument();
    expect(requests).toEqual(["/agent-sessions/session-detail-1"]);
    expect(detailBodyText()).not.toMatch(UNSAFE_DETAIL_TEXT_PATTERN);
  });

  it("disables absent ids and renders the safe not-found state without invalid requests", () => {
    const requests: string[] = [];

    render(
      <AppCoreStoryProviders
        apiRoutes={[
          {
            method: "GET",
            path: "/agent-sessions/*",
            respond: ({ pathname }) => {
              requests.push(pathname);
              return createAgentSessionDetailFixture();
            },
          },
        ]}
      >
        <DetailProbe id="" />
      </AppCoreStoryProviders>
    );

    expect(screen.getByText("Session not found")).toBeInTheDocument();
    expect(requests).toEqual([]);
    expect(detailBodyText()).not.toMatch(UNSAFE_DETAIL_TEXT_PATTERN);
  });

  it("keeps cached detail visible while a stale detail query refetches", async () => {
    const requests: string[] = [];
    let releaseRefetch!: (session: AgentSessionDetail) => void;

    render(
      <AppCoreStoryProviders
        apiRoutes={[
          {
            method: "GET",
            path: "/agent-sessions/session-detail-1",
            respond: ({ pathname }) => {
              requests.push(pathname);
              return new Promise((resolve) => {
                releaseRefetch = resolve;
              });
            },
          },
        ]}
        queryData={[
          [
            agentSessionKeys.detail("http", "session-detail-1"),
            populatedAgentSessionDetailFixture,
          ],
        ]}
      >
        <DetailProbe id="session-detail-1" options={{ staleTime: 0 }} />
      </AppCoreStoryProviders>
    );

    expect(
      screen.getByText("Desktop implementation session")
    ).toBeInTheDocument();
    expect(document.querySelector(".animate-pulse")).not.toBeInTheDocument();
    await waitFor(() =>
      expect(requests).toEqual(["/agent-sessions/session-detail-1"])
    );

    releaseRefetch(
      createAgentSessionDetailFixture({ name: "Refetched detail session" })
    );

    expect(
      await screen.findByText("Refetched detail session")
    ).toBeInTheDocument();
    expect(detailBodyText()).not.toMatch(UNSAFE_DETAIL_TEXT_PATTERN);
  });

  it("scopes cached detail by active source so local and cloud rows for one id cannot mix", async () => {
    const localDetail = createAgentSessionDetailFixture({
      id: "same-session",
      name: "Local detail",
    });
    const cloudDetail = createAgentSessionDetailFixture({
      id: "same-session",
      name: "Cloud detail",
    });

    render(
      <AppCoreStoryProviders
        apiRoutes={[
          {
            method: "GET",
            path: "/agent-sessions/same-session",
            respond: () => cloudDetail,
          },
        ]}
      >
        <AgentSessionsDataSourceProvider
          dataSource={detailOnlySource("local", localDetail)}
        >
          <DetailNameProbe id="same-session" testId="local-detail" />
        </AgentSessionsDataSourceProvider>
        <DetailNameProbe id="same-session" testId="cloud-detail" />
      </AppCoreStoryProviders>
    );

    await waitFor(() => {
      expect(screen.getByTestId("local-detail")).toHaveTextContent(
        "Local detail"
      );
      expect(screen.getByTestId("cloud-detail")).toHaveTextContent(
        "Cloud detail"
      );
    });
  });

  it("maps retry exhaustion to the safe not-found state without raw error leakage", async () => {
    const requests: string[] = [];

    render(
      <AppCoreStoryProviders
        apiRoutes={[
          {
            method: "GET",
            path: "/agent-sessions/error-session",
            respond: ({ pathname }) => {
              requests.push(pathname);
              return { message: "stack: Error at internal boundary" };
            },
            status: 500,
          },
        ]}
      >
        <DetailProbe id="error-session" options={{ retry: 1, retryDelay: 0 }} />
      </AppCoreStoryProviders>
    );

    expect(await screen.findByText("Session not found")).toBeInTheDocument();
    await waitFor(() => expect(requests).toHaveLength(2));
    expect(document.body.textContent).not.toContain("internal boundary");
    expect(document.body.textContent).not.toContain("stack:");
    expect(detailBodyText()).not.toMatch(UNSAFE_DETAIL_TEXT_PATTERN);
  });
});

type DetailProbeProps = {
  id: string;
  options?: Parameters<typeof useAgentSessionDetail>[1];
};

function DetailProbe({ id, options }: DetailProbeProps) {
  const query = useAgentSessionDetail(id, options);

  return (
    <AgentSessionDetailView
      backHref="/sessions"
      isLoading={query.isLoading}
      session={query.data}
    />
  );
}

function DetailNameProbe({ id, testId }: { id: string; testId: string }) {
  const query = useAgentSessionDetail(id);
  return <span data-testid={testId}>{query.data?.name ?? "loading"}</span>;
}

function detailBodyText() {
  return document.body.textContent ?? "";
}

function detailOnlySource(
  scope: string,
  detail: AgentSessionDetail
): AgentSessionsDataSource {
  return {
    scope,
    list: () => Promise.reject(new Error("list unused")),
    detail: () => Promise.resolve(detail),
    usage: () => Promise.reject(new Error("usage unused")),
    analytics: () => Promise.reject(new Error("analytics unused")),
  };
}
