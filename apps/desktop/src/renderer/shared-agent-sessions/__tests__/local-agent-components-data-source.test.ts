import type {
  AgentComponentDetail,
  AgentComponentListResponse,
} from "@repo/api/src/types/agent-component";
import { createAgentSessionListItemFixture } from "@repo/app/agents/components/sessions/session-list-fixtures";
import { makeDetail } from "@repo/app/agents/components/workspace/agent-component-fixtures";
import { ApiError } from "@repo/app/shared/api/api-error";
import { describe, expect, it, vi } from "vitest";
import { SHARED_AGENT_COMPONENTS_TRANSIENT_ERROR_CODE } from "../../../shared/shared-agent-components-contract";
import { isTransientSourceError } from "../../shared/transient-source-error";
import type { DesktopApi } from "../../types/desktop-api";
import {
  createLocalAgentComponentsDataSource,
  LOCAL_AGENT_COMPONENTS_NOT_FOUND_CODE,
  LOCAL_AGENT_COMPONENTS_SOURCE_ERROR_CODE,
  LOCAL_AGENT_COMPONENTS_UNAVAILABLE_CODE,
  withLocalDateWindowWithheld,
} from "../local-agent-components-data-source";

const LIST: AgentComponentListResponse = {
  items: [],
  total: 2,
  hasMore: false,
};
const DETAIL: AgentComponentDetail = makeDetail({ slug: "agent::alpha" });

type DesktopDb = DesktopApi["db"];

// The port takes every member as optional (a preload may not have wired `db` at
// all); this fake always builds one, so it says so and callers can assert on it.
function fakeDesktopApi(
  overrides: Partial<DesktopDb> = {},
  onDbChanged?: DesktopApi["onDbChanged"]
): Parameters<typeof createLocalAgentComponentsDataSource>[0] & {
  db: DesktopDb;
} {
  return {
    db: {
      listAgentComponents: vi.fn(async () => LIST),
      getAgentComponentDetail: vi.fn(async () => DETAIL),
      ...overrides,
    } as DesktopDb,
    onDbChanged,
  };
}

describe("createLocalAgentComponentsDataSource", () => {
  it("negotiates daily frequency without replacing old source absence with zero", async () => {
    expect(
      createLocalAgentComponentsDataSource(fakeDesktopApi()).frequency
    ).toBeUndefined();
    const getAgentComponentFrequency = vi.fn(async () => ({
      windowDays: 30,
      points: [{ day: "2026-10-19", invocations: 12 }],
    }));
    const source = createLocalAgentComponentsDataSource(
      fakeDesktopApi({ getAgentComponentFrequency })
    );
    expect(await source.frequency?.("skill::review", 30)).toEqual({
      windowDays: 30,
      points: [{ day: "2026-10-19", invocations: 12 }],
    });
    expect(getAgentComponentFrequency).toHaveBeenCalledWith(
      "skill::review",
      30
    );
  });
  it("identifies as the local agent-components scope", () => {
    expect(createLocalAgentComponentsDataSource(fakeDesktopApi()).scope).toBe(
      "agent-components:local"
    );
  });

  it("declares that it honors the date window, and PROVES it by forwarding both bounds", async () => {
    // ISS-6888. The declaration is what the shared Agents list reads to decide
    // whether to ask this source for a preceding-window baseline and an
    // unwindowed facet universe, so asserting the boolean alone would be a
    // restatement of the literal. The forwarding assertion is what makes it a
    // claim about behavior: `list` hands the bounds to IPC verbatim, which is the
    // renderer half of the path FEA-3196 wired end to end (the main process keeps
    // them in `coerceAgentComponentFilters` and `toUsageWindow` puts both into
    // the usage SQL). Before FEA-3196 the declaration would have been a lie.
    const api = fakeDesktopApi();
    const source = createLocalAgentComponentsDataSource(api);

    expect(source.honorsDateWindow).toBe(true);

    await source.list({
      endDate: "2026-05-01T00:00:00.000Z",
      startDate: "2026-03-01T00:00:00.000Z",
    });
    expect(api.db.listAgentComponents).toHaveBeenCalledWith({
      endDate: "2026-05-01T00:00:00.000Z",
      startDate: "2026-03-01T00:00:00.000Z",
    });
  });

  it("forwards filters and the slug to the IPC reads", async () => {
    const api = fakeDesktopApi();
    const source = createLocalAgentComponentsDataSource(api);

    await expect(source.list({ limit: 500 })).resolves.toEqual(LIST);
    expect(api.db.listAgentComponents).toHaveBeenCalledWith({ limit: 500 });

    await expect(source.detail("agent::alpha")).resolves.toEqual(DETAIL);
    expect(api.db.getAgentComponentDetail).toHaveBeenCalledWith("agent::alpha");
  });

  it("rejects 404 when the IPC handler resolves no component", async () => {
    const source = createLocalAgentComponentsDataSource(
      fakeDesktopApi({ getAgentComponentDetail: vi.fn(async () => null) })
    );

    const error = await source
      .detail("agent::missing")
      .catch((caught) => caught);
    expect(error).toBeInstanceOf(ApiError);
    expect(error.status).toBe(404);
    expect(error.code).toBe(LOCAL_AGENT_COMPONENTS_NOT_FOUND_CODE);
  });

  it("sanitizes an IPC failure to a 500 that leaks no local detail", async () => {
    const source = createLocalAgentComponentsDataSource(
      fakeDesktopApi({
        listAgentComponents: vi.fn(() =>
          Promise.reject(new Error("SQLITE_ERROR: /Users/someone/db.sqlite"))
        ),
      })
    );

    const error = await source.list({}).catch((caught) => caught);
    expect(error).toBeInstanceOf(ApiError);
    expect(error.status).toBe(500);
    expect(error.code).toBe(LOCAL_AGENT_COMPONENTS_SOURCE_ERROR_CODE);
    expect(error.message).not.toContain("SQLITE_ERROR");
    expect(error.message).not.toContain("/Users/someone");
  });

  it("classifies a db-host lifecycle failure as transient so the client retries", async () => {
    const source = createLocalAgentComponentsDataSource(
      fakeDesktopApi({
        // The db-host child restarting mid-read: retryable, not the hard error
        // card. `runSource` classifies on the RAW message before discarding it.
        listAgentComponents: vi.fn(() =>
          Promise.reject(new Error("db-host exited (code: 1)"))
        ),
      })
    );

    const error = await source.list({}).catch((caught) => caught);
    expect(isTransientSourceError(error)).toBe(true);
    expect(error).not.toBeInstanceOf(ApiError);
    expect(error.code).toBe(SHARED_AGENT_COMPONENTS_TRANSIENT_ERROR_CODE);
    expect(error.message).not.toContain("db-host exited");
  });

  it("raises 501 when the preload exposes no agent-components IPC methods", async () => {
    // A build that predates the main-process handlers: the methods are absent,
    // not failing — the source must say so instead of an opaque TypeError. The
    // capability check runs OUTSIDE `sanitize`, so it surfaces synchronously
    // (React Query's queryFn wrapper turns that into a rejected query) and keeps
    // its explicit 501 instead of being re-wrapped as a generic 500.
    const bare = createLocalAgentComponentsDataSource({ db: {} as DesktopDb });

    const listError = catchSync(() => bare.list({}));
    expect(listError).toBeInstanceOf(ApiError);
    expect((listError as ApiError).status).toBe(501);
    expect((listError as ApiError).code).toBe(
      LOCAL_AGENT_COMPONENTS_UNAVAILABLE_CODE
    );

    const detailError = await bare
      .detail("agent::alpha")
      .catch((caught) => caught);
    expect(detailError).toBeInstanceOf(ApiError);
    expect(detailError.status).toBe(501);
    expect(detailError.code).toBe(LOCAL_AGENT_COMPONENTS_UNAVAILABLE_CODE);
  });

  // ISS-6882. `desktop:db:changed` carries `{ sessionId? }` — an agent-SESSION
  // id. It is not a component identity in any shape, so the source must not
  // forward it as one: a `{ componentId }` change makes the live bridge narrow
  // its invalidation to a detail key nothing is registered under, and every open
  // component detail then stays stale forever. Both payload shapes below carry a
  // session id that is deliberately unlike any component slug or id in this
  // suite, so a wrong mapping cannot pass by coincidence.
  it.each([
    ["a session-scoped payload", { sessionId: "session-9" }],
    ["an already-broad payload", {}],
    ["a payload with an explicitly absent session", { sessionId: undefined }],
  ])("maps %s to a BROAD component change", (_label, payload) => {
    const onDbChanged = vi.fn(
      (_cb: (payload: { sessionId?: string }) => void) => vi.fn()
    );
    const source = createLocalAgentComponentsDataSource(
      fakeDesktopApi({}, onDbChanged)
    );

    const onChange = vi.fn();
    source.subscribe?.(onChange);
    const forward = onDbChanged.mock.calls[0]?.[0];
    forward?.(payload);

    expect(onChange).toHaveBeenCalledWith({});
    expect(onChange.mock.calls[0]?.[0]).not.toHaveProperty("componentId");
  });

  it("returns onDbChanged's own teardown from subscribe", () => {
    const unsubscribe = vi.fn();
    const onDbChanged = vi.fn(
      (_cb: (payload: { sessionId?: string }) => void) => unsubscribe
    );
    const source = createLocalAgentComponentsDataSource(
      fakeDesktopApi({}, onDbChanged)
    );

    const stop = source.subscribe?.(vi.fn());
    expect(onDbChanged).toHaveBeenCalledTimes(1);
    expect(unsubscribe).not.toHaveBeenCalled();

    stop?.();
    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });

  it("omits subscribe when the preload exposes no onDbChanged", () => {
    const source = createLocalAgentComponentsDataSource(fakeDesktopApi());
    expect(source.subscribe).toBeUndefined();
  });

  it("constructs against a preload with no db namespace at all", () => {
    // ISS-6822. This factory runs for EVERY desktop app-core mount, not just the
    // Agents route, so it is handed whatever the preload injected — including a
    // bridge-absent `{}` on a build that never wired `db`. Probing the page-data
    // capability must not dereference `db` unguarded: a throw here escapes the
    // factory and takes the whole app-core stack down with it, blanking surfaces
    // (guest chrome, the sidebar) that never asked for agent components.
    const source = createLocalAgentComponentsDataSource({});

    expect(source.scope).toBe("agent-components:local");
    // No `db` means no page-data channel, so the port stays on the `list` path.
    expect(source.pageData).toBeUndefined();
  });

  it("still fails closed with 501, not a TypeError, when db is absent", () => {
    // The absent-`db` build must degrade the same way an absent-METHOD build
    // does — the sanitized capability error, never a raw preload TypeError.
    const source = createLocalAgentComponentsDataSource({});

    const listError = catchSync(() => source.list({}));
    expect(listError).toBeInstanceOf(ApiError);
    expect((listError as ApiError).status).toBe(501);
    expect((listError as ApiError).code).toBe(
      LOCAL_AGENT_COMPONENTS_UNAVAILABLE_CODE
    );
  });
});

describe("withLocalDateWindowWithheld", () => {
  it("WITHHOLDS the declaration, leaving the rest of the source intact", () => {
    const source = createLocalAgentComponentsDataSource(fakeDesktopApi());
    expect(source.honorsDateWindow).toBe(true);

    const withheld = withLocalDateWindowWithheld(source);

    expect(withheld.honorsDateWindow).toBe(false);
    // Only the declaration is withheld. A gate that also dropped `subscribe` or
    // `pageData` would silently take the live-refresh bridge or the bounded read
    // away from every desktop user with the flag off — a far larger change than
    // the one comparison it is meant to hold back.
    expect(withheld.scope).toBe(source.scope);
    expect(withheld.list).toBe(source.list);
    expect(withheld.detail).toBe(source.detail);
    expect(withheld.subscribe).toBe(source.subscribe);
  });

  it("cannot GRANT the capability to a source that does not have it", () => {
    // The correctness half the retired scope check was protecting, kept on the
    // new axis. A source that ignores the window answers the preceding query
    // with the current window's rows, so a delta from it would be a fabricated
    // 0%. This helper only ever writes `false`, so no rollout state can make
    // such a source claim otherwise.
    const ignoresWindow = {
      ...createLocalAgentComponentsDataSource(fakeDesktopApi()),
      honorsDateWindow: false,
    };

    expect(withLocalDateWindowWithheld(ignoresWindow).honorsDateWindow).toBe(
      false
    );
  });
});

/** The error a synchronously-throwing call raised, for the capability guard. */
function catchSync(run: () => unknown): unknown {
  try {
    run();
  } catch (error) {
    return error;
  }
  return null;
}

describe("component session pagination", () => {
  it("continues beyond the rendered first page without losing hydrated sessions", async () => {
    const sessions = Array.from({ length: 107 }, (_, index) =>
      createAgentSessionListItemFixture({ id: `session-${index}` })
    );
    const api = fakeDesktopApi({
      getAgentComponentDetail: vi.fn(async () =>
        makeDetail({ sessionsTab: sessions, sessions: 107 })
      ),
    });
    const source = createLocalAgentComponentsDataSource(api);
    const first = await source.detail("subagent::orchestrator");
    expect(first.sessionsTab).toHaveLength(50);
    const second = await source.sessionPage!(
      first.slug,
      first.sessionsTabNextCursor!
    );
    expect(second.items.map((session) => session.id)).toEqual(
      sessions.slice(50, 100).map((session) => session.id)
    );
    const last = await source.sessionPage!(first.slug, second.nextCursor!);
    expect(last.items).toHaveLength(7);
    expect(last.total).toBe(107);
    expect(last.nextCursor).toBeNull();
  });

  it.each(["", " ", "-1", "NaN", "Infinity", "2.5", "9007199254740992"])(
    "rejects an invalid local cursor %s",
    async (cursor) => {
      const source = createLocalAgentComponentsDataSource(fakeDesktopApi());
      await expect(
        source.sessionPage!("subagent::orchestrator", cursor)
      ).rejects.toMatchObject({ status: 400 });
    }
  );
});
