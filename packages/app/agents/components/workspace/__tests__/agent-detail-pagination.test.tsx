import type { AgentComponentDetail } from "@repo/api/src/types/agent-component";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { AppCoreStoryProviders } from "../../../../shared/storybook/decorators";
import type { AgentComponentsDataSource } from "../../../data-source/agent-components-data-source";
import { AgentComponentsDataSourceProvider } from "../../../data-source/provider";
import { createAgentSessionListItemFixture } from "../../sessions/session-list-fixtures";
import { agentDetailSource, makeDetail } from "../agent-component-fixtures";
import { AgentDetailPagedSessions } from "../agent-detail-pagination";

function mount(
  detail: AgentComponentDetail,
  source: AgentComponentsDataSource
) {
  return render(
    <AppCoreStoryProviders>
      <AgentComponentsDataSourceProvider dataSource={source}>
        <AgentDetailPagedSessions
          component={detail}
          getSessionHref={(session) => `/sessions/${session.id}`}
        />
      </AgentComponentsDataSourceProvider>
    </AppCoreStoryProviders>
  );
}

describe("agent detail session paging", () => {
  it("uses the loaded head and fetches the requested continuation only after Next", async () => {
    const user = userEvent.setup();
    const head = createAgentSessionListItemFixture({
      id: "head",
      name: "Head session",
    });
    const tail = createAgentSessionListItemFixture({
      id: "tail",
      name: "Tail session",
    });
    const detail = makeDetail({
      sessionsTab: [head],
      sessions: 2,
      sessionsTabNextCursor: "next-session",
    });
    const sessionPage = vi.fn(async () => ({
      items: [tail],
      total: 2,
      nextCursor: null,
    }));
    mount(detail, { ...agentDetailSource(detail), sessionPage });
    expect(
      screen.getByRole("link", { name: "Head session" })
    ).toBeInTheDocument();
    expect(sessionPage).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "Next" }));
    expect(
      await screen.findByRole("link", { name: "Tail session" })
    ).toBeInTheDocument();
    expect(sessionPage).toHaveBeenCalledWith(detail.slug, "next-session");
    expect(screen.getByRole("button", { name: "Next" })).toBeDisabled();
    await user.click(screen.getByRole("button", { name: "Previous" }));
    expect(
      await screen.findByRole("link", { name: "Head session" })
    ).toBeInTheDocument();
  });

  it("paginates every delivered row on an older source without a continuation method", async () => {
    const user = userEvent.setup();
    const sessions = Array.from({ length: 51 }, (_, index) =>
      createAgentSessionListItemFixture({
        id: `id-${index}`,
        name: `Recorded session ${index}`,
      })
    );
    const detail = makeDetail({
      sessionsTab: sessions,
      sessions: sessions.length,
    });
    mount(detail, agentDetailSource(detail));
    expect(
      screen.getByRole("link", { name: "Recorded session 0" })
    ).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Next" }));
    expect(
      screen.getByRole("link", { name: "Recorded session 50" })
    ).toBeInTheDocument();

    expect(screen.getByRole("button", { name: "Next" })).toBeDisabled();
  }, 15_000);

  it("keeps Previous reachable after a continuation failure", async () => {
    const user = userEvent.setup();
    const detail = makeDetail({
      sessionsTab: [
        createAgentSessionListItemFixture({ name: "Head session" }),
      ],
      sessionsTabNextCursor: "bad-read",
    });
    mount(detail, {
      ...agentDetailSource(detail),
      sessionPage: vi.fn(() => Promise.reject(new Error("read failed"))),
    });
    await user.click(screen.getByRole("button", { name: "Next" }));
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Retry" })).toBeInTheDocument()
    );
    await user.click(screen.getByRole("button", { name: "Previous" }));
    expect(
      await screen.findByRole("link", { name: "Head session" })
    ).toBeInTheDocument();
  });
});
