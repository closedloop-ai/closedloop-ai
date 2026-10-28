/**
 * ISS-11212 (PLN-2121 Step 7): `list-session-comments` reads every page of the
 * unified artifact comments route, so `total` and offset paging cover every
 * thread instead of the legacy route's oldest 200.
 */
import { ThreadStatus } from "@repo/api/src/types/comment";
import { commentApiPaths } from "@repo/api/src/types/comment-thread-dto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { registerListSessionComments } from "../tools/list-session-comments.js";
import {
  pagedCommentsApi,
  SESSION_ID,
  sampleThread,
} from "./fixtures/session-comment-threads.js";

const THREAD_COUNT = 205;
const PATH = commentApiPaths.artifactComments(SESSION_ID);

const registerTool = vi.fn();
const apiClient = { get: vi.fn() };

function threads(status: (index: number) => ThreadStatus) {
  return Array.from({ length: THREAD_COUNT }, (_, index) =>
    sampleThread({ id: `comment-${index}`, status: status(index) })
  );
}

function callTool(input: Record<string, unknown>) {
  const handler = registerTool.mock.calls[0]?.[2];
  return handler({ sessionId: SESSION_ID, ...input });
}

async function listComments(input: Record<string, unknown>) {
  const response = await callTool(input);
  return JSON.parse(response.content[0].text);
}

describe("list-session-comments paging", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    registerListSessionComments({ registerTool } as never, apiClient as never);
  });

  it(`counts all ${THREAD_COUNT} threads and pages past the 200th`, async () => {
    apiClient.get.mockImplementation(
      pagedCommentsApi(
        PATH,
        threads(() => ThreadStatus.Open)
      )
    );

    const payload = await listComments({ limit: 10, offset: 200 });

    expect(apiClient.get).toHaveBeenCalledTimes(3);
    expect(payload).toMatchObject({
      total: THREAD_COUNT,
      offset: 200,
      returned: 5,
      hasMore: false,
    });
    expect(payload.items.map((item: { id: string }) => item.id)).toEqual(
      [200, 201, 202, 203, 204].map((index) => `comment-${index}`)
    );
  });

  it("filters status on the server and follows its cursor across two pages", async () => {
    apiClient.get.mockImplementation(
      pagedCommentsApi(
        PATH,
        threads((index) =>
          index % 2 === 0 ? ThreadStatus.Resolved : ThreadStatus.Open
        )
      )
    );

    const payload = await listComments({
      status: ThreadStatus.Resolved,
      limit: 2,
      offset: 101,
    });

    expect(apiClient.get).toHaveBeenCalledTimes(2);
    expect(apiClient.get.mock.calls.map(([, query]) => query)).toEqual([
      expect.objectContaining({ status: ThreadStatus.Resolved }),
      expect.objectContaining({
        status: ThreadStatus.Resolved,
        cursor: expect.any(String),
      }),
    ]);
    expect(payload.total).toBe(103);
    expect(payload.items.map((item: { id: string }) => item.id)).toEqual([
      "comment-202",
      "comment-204",
    ]);
  });

  it("fails instead of looping when the server repeats its cursor", async () => {
    apiClient.get.mockResolvedValue({
      capabilities: {},
      threads: [sampleThread({ id: "repeated" })],
      nextCursor: "stuck",
    });

    const response = await callTool({});

    expect(response.isError).toBe(true);
    expect(response.content[0].text).toContain("same page cursor twice");
    expect(apiClient.get).toHaveBeenCalledTimes(2);
  });

  it("fails after 100 pages when every cursor is new", async () => {
    let page = 0;
    apiClient.get.mockImplementation(() => {
      page += 1;
      return Promise.resolve({
        capabilities: {},
        threads: [],
        nextCursor: `page-${page}`,
      });
    });

    const response = await callTool({});

    expect(response.isError).toBe(true);
    expect(response.content[0].text).toContain("did not end within 100 pages");
    expect(apiClient.get).toHaveBeenCalledTimes(100);
  });

  it("leaves out a thread without a trace anchor, as the legacy route did", async () => {
    apiClient.get.mockImplementation(
      pagedCommentsApi(PATH, [
        sampleThread({ id: "anchored" }),
        sampleThread({ id: "unanchored", anchor: null }),
      ])
    );

    const payload = await listComments({});

    expect(payload.total).toBe(1);
    expect(payload.items[0].id).toBe("anchored");
  });
});
