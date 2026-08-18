import { ApiError } from "@repo/app/shared/api/api-error";
import { afterEach, describe, expect, test, vi } from "vitest";
import { addRepo, removeRepo, updateRepoSettings } from "../repos";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("addRepo", () => {
  test("posts the path and returns the parsed response body on success", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(jsonResponse(200, { id: "repo-1", path: "acme/web" }));
    globalThis.fetch = fetchMock;

    const result = await addRepo("acme/web");

    expect(fetchMock).toHaveBeenCalledWith("/api/gateway/repos", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: "acme/web" }),
    });
    expect(result).toEqual({ id: "repo-1", path: "acme/web" });
  });

  test("throws an ApiError carrying the status, code, and message from the error body", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      jsonResponse(409, {
        error: "Repository already added",
        code: "REPO_EXISTS",
        details: { path: "acme/web" },
        timestamp: "2026-04-13T18:41:00.000Z",
      })
    );

    await expect(addRepo("acme/web")).rejects.toMatchObject({
      name: "ApiError",
      status: 409,
      code: "REPO_EXISTS",
      message: "Repository already added",
      details: { path: "acme/web" },
      timestamp: "2026-04-13T18:41:00.000Z",
    });
  });

  test("falls back to the default message when the error body has no error or code field", async () => {
    globalThis.fetch = vi
      .fn()
      .mockResolvedValue(jsonResponse(500, { reason: "unhandled" }));

    await expect(addRepo("acme/web")).rejects.toMatchObject({
      status: 500,
      code: undefined,
      message: "Failed to add repository",
    });
  });
});

describe("removeRepo", () => {
  test("issues a DELETE with the path percent-encoded in the query string", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(jsonResponse(200, { ok: true }));
    globalThis.fetch = fetchMock;

    const result = await removeRepo("acme/my repo #2");

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/gateway/repos?path=acme%2Fmy%20repo%20%232",
      { method: "DELETE" }
    );
    expect(result).toEqual({ ok: true });
  });

  test("throws an ApiError carrying the status and message on a non-ok response", async () => {
    globalThis.fetch = vi
      .fn()
      .mockResolvedValue(jsonResponse(404, { error: "Repository not found" }));

    let caught: unknown;
    try {
      await removeRepo("acme/web");
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(ApiError);
    expect((caught as ApiError).status).toBe(404);
    expect((caught as ApiError).message).toBe("Repository not found");
    expect((caught as ApiError).code).toBeUndefined();
  });
});

describe("updateRepoSettings", () => {
  test("patches the settings and returns the parsed response body on success", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(jsonResponse(200, { ok: true }));
    globalThis.fetch = fetchMock;

    const settings = {
      worktreeParentDir: "/Users/alice/worktrees",
      worktreeParentDirConfirmed: true,
    };
    const result = await updateRepoSettings(settings);

    expect(fetchMock).toHaveBeenCalledWith("/api/gateway/repos", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(settings),
    });
    expect(result).toEqual({ ok: true });
  });

  test("throws an ApiError using the code as the message when no error field is present", async () => {
    globalThis.fetch = vi
      .fn()
      .mockResolvedValue(jsonResponse(400, { code: "INVALID_PATH" }));

    await expect(
      updateRepoSettings({ worktreeParentDir: "not-absolute" })
    ).rejects.toMatchObject({
      status: 400,
      code: "INVALID_PATH",
      message: "INVALID_PATH",
    });
  });
});
