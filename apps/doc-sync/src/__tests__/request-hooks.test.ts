import type { onUpgradePayload } from "@hocuspocus/server";
import { describe, expect, it, vi } from "vitest";
import { refuseDisallowedOrigin } from "../auth/connection-hooks";

const ALLOWED_ORIGIN = "https://app.example.test";

function upgrade(origin: string | undefined) {
  const end = vi.fn();
  const value = {
    request: { headers: origin === undefined ? {} : { origin } },
    socket: { end },
  } as unknown as Pick<onUpgradePayload, "request" | "socket">;
  return { value, end };
}

describe("refuseDisallowedOrigin", () => {
  const hook = refuseDisallowedOrigin([ALLOWED_ORIGIN]);

  it("admits an allowed Origin without touching the socket", async () => {
    const { value, end } = upgrade(ALLOWED_ORIGIN);

    await expect(hook(value)).resolves.toBeUndefined();
    expect(end).not.toHaveBeenCalled();
  });

  it("admits an upgrade with no Origin", async () => {
    const { value, end } = upgrade(undefined);

    await expect(hook(value)).resolves.toBeUndefined();
    expect(end).not.toHaveBeenCalled();
  });

  it("answers a disallowed Origin 403 on the socket and rejects with no value", async () => {
    const { value, end } = upgrade("https://evil.example.test");

    await expect(hook(value)).rejects.toBeUndefined();
    expect(end).toHaveBeenCalledWith(
      "HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n"
    );
  });
});
