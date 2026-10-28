import { describe, expect, it } from "vitest";
import { GET } from "@/app/health/route";

const healthRequest = () => new Request("https://api.closedloop.ai/health");

describe("Health Check", () => {
  it("returns 200 OK with text body", async () => {
    const response = await GET(healthRequest());
    expect(response.status).toBe(200);

    const text = await response.text();
    expect(text).toBe("OK");
  });

  // GAP-001: closedloop-ai returns plain text, not JSON.
  // This block documents the contract the smoke suite validates.
  describe("compatibility contract", () => {
    it("Content-Type is not application/json", async () => {
      const response = await GET(healthRequest());
      const contentType = response.headers.get("content-type");
      expect(contentType).not.toContain("application/json");
    });
  });
});
