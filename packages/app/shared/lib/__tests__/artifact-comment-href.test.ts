import { ArtifactDetailTab } from "@repo/app/shared/lib/artifact-detail-tab";
import {
  ARTIFACT_COMMENT_PARAM,
  DEFAULT_TAB_PARAM,
} from "@repo/app/shared/lib/detail-route-params";
import type { ReadonlySearchParams } from "@repo/navigation/navigation-adapter";
import { describe, expect, it } from "vitest";
import {
  readArtifactCommentThreadId,
  withArtifactCommentParam,
} from "../artifact-comment-href";

/**
 * ISS-11004 / ISS-10980: one `?comment=` contract, written by the Session and
 * Branch Activity tabs. Each names the tab its comments rail is beside, which
 * differs per surface — Session's rail is inside its Sessions panel, Branch's
 * is page-level but shown beside Artifact and Sessions only.
 */
const params = (query: string): ReadonlySearchParams =>
  new URLSearchParams(query) as unknown as ReadonlySearchParams;

const THREAD_ID = "00000000-0000-7000-8000-0000000000aa";

describe("readArtifactCommentThreadId", () => {
  it("reads the addressed thread id", () => {
    expect(
      readArtifactCommentThreadId(
        params(`${ARTIFACT_COMMENT_PARAM}=${THREAD_ID}`)
      )
    ).toBe(THREAD_ID);
  });

  it("trims surrounding whitespace", () => {
    expect(
      readArtifactCommentThreadId(params(`${ARTIFACT_COMMENT_PARAM}=  x  `))
    ).toBe("x");
  });

  it.each([
    ["no param", ""],
    ["an empty value", `${ARTIFACT_COMMENT_PARAM}=`],
    ["whitespace only", `${ARTIFACT_COMMENT_PARAM}=%20%20`],
  ])("names no thread for %s", (_label, query) => {
    expect(readArtifactCommentThreadId(params(query))).toBeNull();
  });

  it("drops a value too long to be an identifier", () => {
    const tooLong = "a".repeat(513);
    expect(
      readArtifactCommentThreadId(
        params(`${ARTIFACT_COMMENT_PARAM}=${tooLong}`)
      )
    ).toBeNull();
    expect(
      readArtifactCommentThreadId(
        params(`${ARTIFACT_COMMENT_PARAM}=${"a".repeat(512)}`)
      )
    ).toBe("a".repeat(512));
  });
});

describe("withArtifactCommentParam", () => {
  it("selects the rail's tab when the surface names one", () => {
    const href = withArtifactCommentParam({
      path: "/org/sessions/s-1",
      railTab: ArtifactDetailTab.Sessions,
      searchParams: params(""),
      threadId: THREAD_ID,
    });

    const url = new URL(href, "https://app.example.test");
    expect(url.pathname).toBe("/org/sessions/s-1");
    expect(url.searchParams.get(DEFAULT_TAB_PARAM)).toBe(
      ArtifactDetailTab.Sessions
    );
    expect(url.searchParams.get(ARTIFACT_COMMENT_PARAM)).toBe(THREAD_ID);
  });

  /**
   * The address REPLACES whatever tab the reader was on. An address that left
   * them on a tab with no rail beside it could not open the thread it names,
   * which is the whole point of the link.
   */
  it("replaces the reader's tab with the rail's", () => {
    const href = withArtifactCommentParam({
      path: "/org/branches/b-1",
      railTab: ArtifactDetailTab.Artifact,
      searchParams: params(`${DEFAULT_TAB_PARAM}=activity`),
      threadId: THREAD_ID,
    });

    const url = new URL(href, "https://app.example.test");
    expect(url.searchParams.get(DEFAULT_TAB_PARAM)).toBe(
      ArtifactDetailTab.Artifact
    );
    expect(url.searchParams.get(ARTIFACT_COMMENT_PARAM)).toBe(THREAD_ID);
  });

  it("keeps the reader's other addressing and replaces a stale comment", () => {
    const href = withArtifactCommentParam({
      path: "/org/branches/b-1",
      railTab: ArtifactDetailTab.Artifact,
      searchParams: params(`${ARTIFACT_COMMENT_PARAM}=old&file=t.jsonl`),
      threadId: THREAD_ID,
    });

    const url = new URL(href, "https://app.example.test");
    expect(url.searchParams.get("file")).toBe("t.jsonl");
    expect(url.searchParams.getAll(ARTIFACT_COMMENT_PARAM)).toEqual([
      THREAD_ID,
    ]);
  });
});
