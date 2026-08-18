import { describe, expect, it, vi } from "vitest";
import type {
  CLDocument,
  ClosedLoopClient,
} from "../src/clients/closedloop.js";
import {
  buildIssueContent,
  extractSignatureMarker,
  FiledFindingStatus,
  type Finding,
  fileFindings,
  findingKey,
  normKey,
  openKeysFromDocuments,
  parseFindingsJsonl,
} from "../src/passes/findings.js";

describe("findings parsing", () => {
  it("parses valid JSONL lines and skips blanks/garbage", () => {
    const text = [
      JSON.stringify({
        title: "Dead export foo",
        description: "unused",
        signature: "dead:foo",
      }),
      "",
      "not json",
      JSON.stringify({ description: "no title — dropped" }),
      JSON.stringify({ title: "  Trimmed  ", description: "x" }),
    ].join("\n");
    const f = parseFindingsJsonl(text);
    expect(f).toHaveLength(2);
    expect(f[0]?.title).toBe("Dead export foo");
    expect(f[1]?.title).toBe("Trimmed");
  });

  it("keeps a finding whose optional fields are absent or wrong-typed", () => {
    // These lines come from a harness writing free-form JSONL, so a numeric
    // `description` or a `screenshots` string is reachable input. A titled finding
    // must survive it — dropping the whole finding would lose a real review result
    // over a malformed optional field.
    const text = [
      JSON.stringify({ title: "No optionals" }),
      JSON.stringify({
        title: "Wrong types",
        description: 42,
        signature: 7,
        screenshots: "not-an-array",
      }),
    ].join("\n");

    const f = parseFindingsJsonl(text);

    expect(f.map((x) => x.title)).toEqual(["No optionals", "Wrong types"]);
    expect(f[0]?.description).toBe("");
    expect(f[1]?.description).toBe("");
    expect(f[1]?.signature).toBeUndefined();
    expect(f[1]?.screenshots).toBeUndefined();
  });

  it("keeps only the string entries of a screenshots array", () => {
    const text = JSON.stringify({
      title: "Mixed screenshots",
      screenshots: ["/a.png", 3, null, "/b.png"],
    });

    expect(parseFindingsJsonl(text)[0]?.screenshots).toEqual([
      "/a.png",
      "/b.png",
    ]);
  });
});

describe("signature marker extraction", () => {
  it("returns undefined when there is no content at all", () => {
    // A ClosedLoop document can come back with no body; the dedup scan must treat
    // that as "no signature" rather than throwing mid-sweep.
    expect(extractSignatureMarker()).toBeUndefined();
    expect(extractSignatureMarker("")).toBeUndefined();
  });
});

describe("dedup keys", () => {
  it("normalizes to lowercase alphanumerics", () => {
    expect(normKey("Dead export: Foo()!")).toBe("deadexportfoo");
  });

  it("prefers signature over title", () => {
    expect(
      findingKey({ title: "T", description: "", signature: "sig-A" })
    ).toBe("siga");
    expect(findingKey({ title: "Only Title", description: "" })).toBe(
      "onlytitle"
    );
  });

  it("round-trips a signature marker in issue content", () => {
    const body = buildIssueContent("Some description", "dead:foo");
    expect(extractSignatureMarker(body)).toBe("dead:foo");
  });
});

describe("openKeysFromDocuments", () => {
  const doc = (over: Partial<CLDocument>): CLDocument => ({
    id: "i",
    slug: "FEA-1",
    type: "FEATURE",
    title: "t",
    status: "TRIAGE",
    ...over,
  });

  it("includes title + signature keys for non-terminal docs, excludes terminal", () => {
    const docs = [
      doc({
        title: "nightly-review: Dead export foo",
        content: buildIssueContent("d", "dead:foo"),
      }),
      doc({
        title: "Closed issue",
        status: "DONE",
        content: buildIssueContent("d", "closed:sig"),
      }),
    ];
    const keys = openKeysFromDocuments(docs);
    expect(keys.has(normKey("Dead export foo"))).toBe(true); // title, stripped of prefix
    expect(keys.has(normKey("dead:foo"))).toBe(true); // signature marker
    expect(keys.has(normKey("closed:sig"))).toBe(false); // terminal excluded
  });

  it("indexes a doc that carries NO signature marker by its title alone", () => {
    // Issues filed by hand — or by an older build — have no embedded signature.
    // They must still contribute their title to the dedup set, or the next run
    // re-files a finding a human already opened.
    const docs = [doc({ title: "nightly-review: Hand-filed thing" })];

    const keys = openKeysFromDocuments(docs);

    expect(keys.has(normKey("Hand-filed thing"))).toBe(true);
  });

  it("dedups a new finding whose signature is already open", () => {
    const docs = [
      doc({
        title: "nightly-review: X",
        content: buildIssueContent("d", "dead:foo"),
      }),
    ];
    const keys = openKeysFromDocuments(docs);
    expect(
      keys.has(
        findingKey({
          title: "different title",
          description: "",
          signature: "dead:foo",
        })
      )
    ).toBe(true);
  });
});

/** A fake ClosedLoopClient recording the createDocument/attachTag calls. */
function fakeClient(existing: CLDocument[] = []) {
  const created: Array<{
    title: string;
    content: string;
    status: string;
    priority?: string;
    assigneeId?: string;
  }> = [];
  const tagAttachments: Array<{ documentId: string; tagId: string }> = [];
  let nextId = 1;
  const client = {
    listDocuments: vi.fn(async () => Promise.resolve(existing)),
    ensureTag: vi.fn(async () => Promise.resolve("tag-123")),
    createDocument: vi.fn((input: (typeof created)[number]) => {
      const id = `doc-${nextId++}`;
      created.push(input);
      return Promise.resolve({
        id,
        slug: id,
        type: "FEATURE",
        title: input.title,
        status: input.status,
      } as CLDocument);
    }),
    attachTag: vi.fn((documentId: string, tagId: string) => {
      tagAttachments.push({ documentId, tagId });
      return Promise.resolve(undefined);
    }),
  };
  return {
    client: client as unknown as ClosedLoopClient,
    created,
    tagAttachments,
    spies: client,
  };
}

const openDoc = (over: Partial<CLDocument>): CLDocument => ({
  id: "i",
  slug: "FEA-1",
  type: "FEATURE",
  title: "t",
  status: "TRIAGE",
  ...over,
});

describe("fileFindings", () => {
  it("files each finding as a TRIAGE issue with tag, assignee, and signature marker", async () => {
    const { client, created, tagAttachments, spies } = fakeClient();
    const findings: Finding[] = [
      { title: "Stale README", description: "docs.md:3", signature: "sig:one" },
      { title: "Wrong flag", description: "cfg.ts:9" },
    ];

    const result = await fileFindings(client, findings, {
      tagName: "agent-docs-darwin",
      assigneeId: "assignee-9",
    });

    expect(spies.ensureTag).toHaveBeenCalledWith("agent-docs-darwin");
    expect(result.created).toBe(2);
    expect(result.skipped).toBe(0);
    // Each created issue carries the assignee, TRIAGE status, and a signature marker.
    expect(created).toHaveLength(2);
    for (const c of created) {
      expect(c.status).toBe("TRIAGE");
      expect(c.assigneeId).toBe("assignee-9");
    }
    // The signature marker is stamped so the NEXT filing can dedup.
    expect(extractSignatureMarker(created[0]?.content)).toBe("sig:one");
    // Signature-less finding falls back to the title as its signature.
    expect(extractSignatureMarker(created[1]?.content)).toBe("Wrong flag");
    // Every created issue is tagged.
    expect(tagAttachments.map((t) => t.tagId)).toEqual(["tag-123", "tag-123"]);
    // Per-finding outcomes carry the created status + document id.
    expect(result.results.map((r) => r.status)).toEqual([
      FiledFindingStatus.Created,
      FiledFindingStatus.Created,
    ]);
    expect(result.results[0]?.documentId).toBe("doc-1");
  });

  it("skips a finding whose signature is already open (dedup guard)", async () => {
    const { client, created, spies } = fakeClient([
      openDoc({
        title: "nightly-review: previously filed",
        content: buildIssueContent("d", "already:filed"),
      }),
    ]);
    const findings: Finding[] = [
      { title: "New one", description: "d", signature: "brand:new" },
      // Same signature as the open doc — must be skipped, not re-filed.
      {
        title: "Different title",
        description: "d",
        signature: "already:filed",
      },
    ];

    const result = await fileFindings(client, findings, {
      tagName: "agent-docs-darwin",
    });

    expect(result.created).toBe(1);
    expect(result.skipped).toBe(1);
    // Only the non-duplicate reached createDocument.
    expect(created).toHaveLength(1);
    expect(created[0]?.title).toContain("New one");
    expect(spies.createDocument).toHaveBeenCalledTimes(1);
    const statuses = result.results.map((r) => r.status);
    expect(statuses).toContain(FiledFindingStatus.Created);
    expect(statuses).toContain(FiledFindingStatus.Skipped);
  });

  it("dedups two findings with the same signature WITHIN one batch", async () => {
    const { client, created } = fakeClient();
    const findings: Finding[] = [
      { title: "First", description: "d", signature: "dup:sig" },
      { title: "Second", description: "d", signature: "dup:sig" },
    ];

    const result = await fileFindings(client, findings, {
      tagName: "agent-docs-darwin",
    });

    expect(result.created).toBe(1);
    expect(result.skipped).toBe(1);
    expect(created).toHaveLength(1);
  });

  it("still succeeds when tag attach fails (non-admin key)", async () => {
    const { client, spies } = fakeClient();
    spies.attachTag.mockRejectedValueOnce(new Error("forbidden"));
    const result = await fileFindings(
      client,
      [{ title: "X", description: "d" }],
      { tagName: "agent-docs-darwin" }
    );
    expect(result.created).toBe(1);
  });

  it("reports PARTIAL outcomes when one create fails — successes are kept", async () => {
    // The middle finding's create throws. The batch must not abort and lose the
    // issues created before and after it: the failure is isolated to that one
    // finding (reported Failed), and the rest are still Created.
    const { client, spies } = fakeClient();
    // Fail only the SECOND create; the default mock handles the 1st and 3rd.
    spies.createDocument.mockRejectedValueOnce(new Error("network blip"));

    const result = await fileFindings(
      client,
      [
        { title: "First", description: "a" },
        { title: "Second", description: "b" },
        { title: "Third", description: "c" },
      ],
      { tagName: "agent-docs-darwin" }
    );

    expect(result.created).toBe(2);
    expect(result.failed).toBe(1);
    expect(result.skipped).toBe(0);
    // One result per requested finding, in request order (positional contract).
    expect(result.results.map((r) => r.status)).toEqual([
      FiledFindingStatus.Failed,
      FiledFindingStatus.Created,
      FiledFindingStatus.Created,
    ]);
    // Every finding was attempted — the failure did not abort the batch.
    expect(spies.createDocument).toHaveBeenCalledTimes(3);
  });

  it("does NOT prime dedup for a failed finding (a retry can create it)", async () => {
    // Two findings share a dedup key. The first FAILS to create; the second
    // must NOT be skipped as a same-key duplicate — the first was never filed.
    const { client, spies } = fakeClient();
    // Fail the FIRST create; the default mock creates the second.
    spies.createDocument.mockRejectedValueOnce(new Error("boom"));

    const result = await fileFindings(
      client,
      [
        { title: "Dup", description: "a", signature: "sig:dup" },
        { title: "Dup", description: "b", signature: "sig:dup" },
      ],
      { tagName: "agent-docs-darwin" }
    );

    expect(result.results.map((r) => r.status)).toEqual([
      FiledFindingStatus.Failed,
      FiledFindingStatus.Created,
    ]);
    expect(result.created).toBe(1);
    expect(result.failed).toBe(1);
    expect(result.skipped).toBe(0);
  });

  it("still files findings when the tag could not be created, and skips the attach", async () => {
    // `ensureTag` returns null when the API key is not authorized to create tags.
    // Filing must proceed regardless — a missing label is cosmetic, an unfiled
    // finding is lost review work — and `attachTag` must not be called with a
    // null id.
    const { client, spies, created, tagAttachments } = fakeClient();
    spies.ensureTag.mockResolvedValueOnce(null as unknown as string);

    const result = await fileFindings(
      client,
      [{ title: "Untagged finding", description: "d" }],
      { tagName: "agent-docs-darwin" }
    );

    expect(result.created).toBe(1);
    expect(created).toHaveLength(1);
    expect(spies.attachTag).not.toHaveBeenCalled();
    expect(tagAttachments).toEqual([]);
  });
});
