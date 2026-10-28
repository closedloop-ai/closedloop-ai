import { ApproverRole, type User } from "@repo/api/src/types/user";
import { BranchCommentsSignalRefresh } from "@repo/app/branches/components/detail/branch-comments-signal-refresh";
import { AuthAdapterProvider } from "@repo/app/shared/auth/provider";
import { createStaticAuthAdapter } from "@repo/app/shared/auth/static-auth-adapter";
import { createFakeRealtimePort } from "@repo/app/shared/realtime/__tests__/fake-realtime-port";
import { useSignals } from "@repo/app/shared/realtime/use-signals";
import { AppCoreStoryProviders } from "@repo/app/shared/storybook/decorators";
import type { FixtureRoute } from "@repo/app/shared/storybook/fixture-fetch";
import { userKeys } from "@repo/app/users/hooks/use-users";
import {
  createSocketIoRealtimeClient,
  type RealtimeClient,
} from "@repo/realtime-client/connection";
import {
  ChannelKind,
  formatChannelAddress,
} from "@repo/realtime-contract/channels";
import { REALTIME_TOKEN_PATH } from "@repo/realtime-contract/protocol";
import { CommentSignalType } from "@repo/realtime-contract/signals";
import { act, render, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  type CreateWebRealtimeClient,
  WebRealtimeHost,
} from "../web-realtime-host";

const ORGANIZATION_ID = "0190c6c8-0000-7000-8000-0000000000a1";
const BRANCH_ID = "0190c6c8-0000-7000-8000-0000000000b1";
const CHANNEL = formatChannelAddress(ChannelKind.Comments, ORGANIZATION_ID, [
  BRANCH_ID,
]);
const THREAD_ID = "0190c6c8-0000-7000-8000-0000000000c1";
const FIRST_POLL_MS = 2000;

afterEach(() => {
  vi.useRealTimers();
});

describe("WebRealtimeHost (PLN-2162 M3)", () => {
  it("builds no client and asks for no token before the first join", async () => {
    const fakes = createFakeClients();
    const tokenRequests = vi.fn(() => ({}));
    const view = render(
      <Host
        apiRoutes={[tokenRoute(200, tokenRequests)]}
        createClient={fakes.create}
      />
    );

    await act(async () => undefined);
    expect(fakes.create).not.toHaveBeenCalled();
    expect(tokenRequests).not.toHaveBeenCalled();

    view.rerender(
      <Host
        apiRoutes={[tokenRoute(200, tokenRequests)]}
        createClient={fakes.create}
      >
        <Subscriber poll={vi.fn(() => Promise.resolve())} />
      </Host>
    );

    await waitFor(() => expect(fakes.create).toHaveBeenCalledTimes(1));
    expect(fakes.latest().joins.map(({ channel }) => channel)).toEqual([
      CHANNEL,
    ]);
  });

  it("keeps polling when the token route answers 503, and opens no socket", async () => {
    vi.useFakeTimers();
    const createSocket = vi.fn();
    const tokenRequests = vi.fn(() => ({}));
    const poll = vi.fn(() => Promise.resolve());
    const createClient: CreateWebRealtimeClient = (options) =>
      createSocketIoRealtimeClient({ ...options, createSocket });

    render(
      <Host
        apiRoutes={[tokenRoute(503, tokenRequests)]}
        createClient={createClient}
      >
        <Subscriber poll={poll} />
      </Host>
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(FIRST_POLL_MS);
    });

    expect(tokenRequests).toHaveBeenCalled();
    expect(poll).toHaveBeenCalledTimes(1);
    expect(createSocket).not.toHaveBeenCalled();
  });

  it("closes the old client on an org switch and joins on a new one", async () => {
    const fakes = createFakeClients();
    const view = render(
      <Host createClient={fakes.create} orgId="org_one">
        <Subscriber poll={vi.fn(() => Promise.resolve())} />
      </Host>
    );
    await waitFor(() => expect(fakes.create).toHaveBeenCalledTimes(1));
    const first = fakes.latest();

    view.rerender(
      <Host createClient={fakes.create} orgId="org_two">
        <Subscriber poll={vi.fn(() => Promise.resolve())} />
      </Host>
    );

    await waitFor(() => expect(fakes.create).toHaveBeenCalledTimes(2));
    expect(first.close).toHaveBeenCalledTimes(1);
    expect(fakes.latest().close).not.toHaveBeenCalled();
    expect(fakes.latest().joins.map(({ channel }) => channel)).toEqual([
      CHANNEL,
    ]);
  });

  it("closes the client on sign-out", async () => {
    const fakes = createFakeClients();
    const view = render(
      <Host createClient={fakes.create}>
        <Subscriber poll={vi.fn(() => Promise.resolve())} />
      </Host>
    );
    await waitFor(() => expect(fakes.create).toHaveBeenCalledTimes(1));

    view.rerender(
      <Host createClient={fakes.create} userId={null}>
        <Subscriber poll={vi.fn(() => Promise.resolve())} />
      </Host>
    );

    await waitFor(() => expect(fakes.latest().close).toHaveBeenCalledTimes(1));
    expect(fakes.create).toHaveBeenCalledTimes(1);
  });

  it("lets the Branch comments signal refresh (#8375) reload on a signal", async () => {
    const fakes = createFakeClients();
    const onCommentsChanged = vi.fn(() => Promise.resolve());

    render(
      <Host
        createClient={fakes.create}
        queryData={[[userKeys.currentUser(), currentUser()]]}
      >
        <BranchCommentsSignalRefresh
          branchId={BRANCH_ID}
          dataLoadedAt={() => Date.now()}
          onCommentsChanged={onCommentsChanged}
        />
      </Host>
    );
    await waitFor(() => expect(fakes.create).toHaveBeenCalledTimes(1));
    const [joined] = fakes.latest().joins;
    expect(joined?.channel).toBe(CHANNEL);

    act(() =>
      joined?.listener.onSignal({
        type: CommentSignalType.ThreadCreated,
        data: { threadId: THREAD_ID, threadRevision: 1 },
      })
    );

    await waitFor(() => expect(onCommentsChanged).toHaveBeenCalledTimes(1));
  });
});

function Host({
  children,
  createClient,
  apiRoutes = [tokenRoute(200, () => ({}))],
  orgId = "org_test",
  userId = "user_test",
  queryData,
}: {
  children?: ReactNode;
  createClient: CreateWebRealtimeClient;
  apiRoutes?: FixtureRoute[];
  orgId?: string;
  userId?: string | null;
  queryData?: [readonly unknown[], unknown][];
}) {
  return (
    <AppCoreStoryProviders apiRoutes={apiRoutes} queryData={queryData}>
      <AuthAdapterProvider adapter={authAdapter(userId, orgId)}>
        <WebRealtimeHost createClient={createClient}>
          {children}
        </WebRealtimeHost>
      </AuthAdapterProvider>
    </AppCoreStoryProviders>
  );
}

const authAdapters = new Map<
  string,
  ReturnType<typeof createStaticAuthAdapter>
>();

/** One adapter per identity, so a rerender with the same identity keeps its snapshot. */
function authAdapter(userId: string | null, orgId: string) {
  const key = `${userId}:${orgId}`;
  let adapter = authAdapters.get(key);
  if (adapter === undefined) {
    adapter = createStaticAuthAdapter({ userId, orgId });
    authAdapters.set(key, adapter);
  }
  return adapter;
}

function Subscriber({ poll }: { poll: () => Promise<void> }) {
  useSignals(CHANNEL, { onSignal: vi.fn(), onResync: vi.fn(), poll });
  return null;
}

function tokenRoute(status: number, respond: () => unknown): FixtureRoute {
  return { method: "POST", path: REALTIME_TOKEN_PATH, status, respond };
}

type FakeClient = ReturnType<typeof createFakeRealtimePort> & {
  close: ReturnType<typeof vi.fn>;
};

function createFakeClients() {
  const clients: FakeClient[] = [];
  const create = vi.fn((): RealtimeClient => {
    const fake = { ...createFakeRealtimePort(), close: vi.fn() };
    clients.push(fake);
    return { ...fake.port, close: fake.close };
  });
  return {
    create,
    latest(): FakeClient {
      const client = clients.at(-1);
      if (client === undefined) {
        throw new Error("no client was created");
      }
      return client;
    },
  };
}

function currentUser(): User {
  return {
    id: "0190c6c8-0000-7000-8000-0000000000d1",
    clerkId: "user_test",
    organizationId: ORGANIZATION_ID,
    email: "reader@example.com",
    firstName: null,
    lastName: null,
    avatarUrl: null,
    phoneNumber: null,
    role: ApproverRole.Engineer,
    linearId: null,
    slackId: null,
    githubUsername: null,
    active: true,
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    updatedAt: new Date("2026-01-01T00:00:00.000Z"),
  };
}
