import { GET } from "@/app/health/route";

describe("Health Check", () => {
  it("returns 200 OK with text body", async () => {
    const response = GET();
    expect(response.status).toBe(200);

    const text = await response.text();
    expect(text).toBe("OK");
  });
});
