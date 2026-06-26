import { describe, expect, it } from "vitest";
import { buildCommentPermalink } from "../shared/permalinks";

describe("buildCommentPermalink", () => {
  it("composes origin + path + thread param", () => {
    expect(
      buildCommentPermalink({
        origin: "https://app.closedloop.ai",
        artifactPath: "/acme/prds/PRD-7",
        threadId: "th_abc123",
      })
    ).toBe("https://app.closedloop.ai/acme/prds/PRD-7?thread=th_abc123");
  });

  it("strips a trailing slash from origin", () => {
    expect(
      buildCommentPermalink({
        origin: "https://app.closedloop.ai/",
        artifactPath: "/acme/prds/PRD-7",
        threadId: "th_1",
      })
    ).toBe("https://app.closedloop.ai/acme/prds/PRD-7?thread=th_1");
  });

  it("strips a trailing slash from the artifact path", () => {
    expect(
      buildCommentPermalink({
        origin: "https://app.closedloop.ai",
        artifactPath: "/acme/features/FEA-42/",
        threadId: "th_1",
      })
    ).toBe("https://app.closedloop.ai/acme/features/FEA-42?thread=th_1");
  });

  it("prepends a leading slash when the artifact path is missing one", () => {
    expect(
      buildCommentPermalink({
        origin: "https://app.closedloop.ai",
        artifactPath: "acme/implementation-plans/PLN-7",
        threadId: "th_1",
      })
    ).toBe(
      "https://app.closedloop.ai/acme/implementation-plans/PLN-7?thread=th_1"
    );
  });

  it("URL-encodes the thread id", () => {
    expect(
      buildCommentPermalink({
        origin: "https://app.closedloop.ai",
        artifactPath: "/acme/prds/PRD-7",
        threadId: "th id with spaces & ampersand",
      })
    ).toBe(
      "https://app.closedloop.ai/acme/prds/PRD-7?thread=th%20id%20with%20spaces%20%26%20ampersand"
    );
  });
});
