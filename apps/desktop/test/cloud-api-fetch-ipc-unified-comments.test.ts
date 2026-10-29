import assert from "node:assert/strict";
import {
  CommentReactionEmoji,
  commentApiPaths,
} from "@repo/api/src/types/comment-thread-dto";
import { test } from "vitest";
import {
  API_ORIGIN,
  createHarness,
  NOT_ALLOWLISTED_ERROR,
} from "./cloud-api-fetch-ipc-test-harness.js";

/**
 * PLN-2162 M5.1: the bridge admits the unified comment write routes the shared
 * HTTP comments source calls, and nothing next to them. The credential is
 * main-held, so a pattern that also matched a sibling path would hand a
 * compromised renderer that write too.
 */

const ARTIFACT_ID = "0199a1b2-0000-7000-8000-00000000a001";
const THREAD_ID = "0199a1b2-0000-7000-8000-00000000b002";
const COMMENT_ID = "0199a1b2-0000-7000-8000-00000000c003";
const ATTACHMENT_ID = "0199a1b2-0000-7000-8000-00000000d004";
const EMOJI = CommentReactionEmoji.ThumbsUp;

type Route = { method: string; path: string };

const ADMITTED_ROUTES: Route[] = [
  { method: "POST", path: commentApiPaths.artifactThreads(ARTIFACT_ID) },
  { method: "POST", path: commentApiPaths.threadReplies(THREAD_ID) },
  { method: "POST", path: commentApiPaths.threadResolve(THREAD_ID) },
  { method: "POST", path: commentApiPaths.threadReopen(THREAD_ID) },
  { method: "POST", path: commentApiPaths.threadRetrySync(THREAD_ID) },
  { method: "PATCH", path: commentApiPaths.comment(COMMENT_ID) },
  { method: "DELETE", path: commentApiPaths.comment(COMMENT_ID) },
  // PLN-2187 T-2.8: reactions, and both halves of an upload.
  { method: "PUT", path: commentApiPaths.commentReaction(COMMENT_ID, EMOJI) },
  {
    method: "DELETE",
    path: commentApiPaths.commentReaction(COMMENT_ID, EMOJI),
  },
  { method: "POST", path: commentApiPaths.commentAttachments(COMMENT_ID) },
  { method: "POST", path: commentApiPaths.attachmentComplete(ATTACHMENT_ID) },
];

const REFUSED_NEIGHBOURS: Route[] = [
  // The list and single-thread reads take GET only.
  { method: "POST", path: commentApiPaths.artifactComments(ARTIFACT_ID) },
  { method: "POST", path: commentApiPaths.thread(THREAD_ID) },
  { method: "PATCH", path: commentApiPaths.thread(THREAD_ID) },
  { method: "DELETE", path: commentApiPaths.thread(THREAD_ID) },
  // The thread collection itself is not a comment id.
  { method: "PATCH", path: "/comments/threads" },
  { method: "DELETE", path: "/comments/threads" },
  { method: "POST", path: "/comments" },
  { method: "DELETE", path: "/comments" },
  // Each entry opens its own method only.
  { method: "POST", path: commentApiPaths.comment(COMMENT_ID) },
  { method: "PUT", path: commentApiPaths.comment(COMMENT_ID) },
  { method: "PATCH", path: commentApiPaths.threadResolve(THREAD_ID) },
  { method: "DELETE", path: commentApiPaths.threadReplies(THREAD_ID) },
  // Missing ids, nested paths and unknown siblings.
  { method: "POST", path: "/artifacts//comments/threads" },
  { method: "POST", path: "/comments/threads//replies" },
  {
    method: "POST",
    path: `${commentApiPaths.artifactThreads(ARTIFACT_ID)}/${THREAD_ID}`,
  },
  { method: "POST", path: `${commentApiPaths.threadReplies(THREAD_ID)}/x` },
  { method: "POST", path: `${commentApiPaths.thread(THREAD_ID)}/archive` },
  { method: "PATCH", path: `${commentApiPaths.comment(COMMENT_ID)}/replies` },
  { method: "DELETE", path: `${commentApiPaths.comment(COMMENT_ID)}/x` },
  // The attachment and reaction routes open only their own methods.
  { method: "POST", path: commentApiPaths.commentReaction(COMMENT_ID, EMOJI) },
  { method: "PATCH", path: commentApiPaths.commentReaction(COMMENT_ID, EMOJI) },
  { method: "PUT", path: commentApiPaths.commentAttachments(COMMENT_ID) },
  { method: "DELETE", path: commentApiPaths.commentAttachments(COMMENT_ID) },
  { method: "POST", path: commentApiPaths.attachment(ATTACHMENT_ID) },
  { method: "DELETE", path: commentApiPaths.attachment(ATTACHMENT_ID) },
  { method: "PUT", path: commentApiPaths.attachmentComplete(ATTACHMENT_ID) },
  // `threads` and `attachments` are route families, never a comment id.
  { method: "POST", path: "/comments/threads/attachments" },
  { method: "POST", path: "/comments/attachments/attachments" },
  { method: "PUT", path: `/comments/threads/reactions/${EMOJI}` },
  { method: "PUT", path: `/comments/attachments/reactions/${EMOJI}` },
  { method: "PATCH", path: "/comments/attachments" },
  { method: "DELETE", path: "/comments/attachments" },
  // Missing ids and nested paths.
  { method: "PUT", path: `/comments/${COMMENT_ID}/reactions/` },
  { method: "PUT", path: `/comments//reactions/${EMOJI}` },
  {
    method: "PUT",
    path: `${commentApiPaths.commentReaction(COMMENT_ID, EMOJI)}/x`,
  },
  { method: "POST", path: "/comments/attachments//complete" },
  {
    method: "POST",
    path: `${commentApiPaths.commentAttachments(COMMENT_ID)}/${ATTACHMENT_ID}`,
  },
];

test("admits every unified comment write route with the main-held credential", async () => {
  for (const { method, path } of ADMITTED_ROUTES) {
    const { invoke, fetchCalls } = createHarness();

    const result = await invoke({
      path,
      method,
      headers: { Authorization: "Bearer sentinel-from-renderer" },
      ...(method === "DELETE" ? {} : { body: "{}" }),
    });

    assert.equal(result.kind, "response", `${method} ${path} must be admitted`);
    assert.equal(fetchCalls.length, 1, `${method} ${path} must fetch once`);
    const call = fetchCalls[0];
    assert.equal(call.url.toString(), `${API_ORIGIN}${path}`);
    assert.equal(call.init.method, method);
    const headers = call.init.headers as Headers;
    assert.equal(headers.get("authorization"), "Bearer real-access-token");
  }
});

test("refuses every neighbour of the unified comment write routes", async () => {
  for (const { method, path } of REFUSED_NEIGHBOURS) {
    const { invoke, fetchCalls } = createHarness();

    const result = await invoke({
      path,
      method,
      ...(method === "DELETE" ? {} : { body: "{}" }),
    });

    assert.equal(
      result.kind,
      "network-error",
      `${method} ${path} must be rejected`
    );
    if (result.kind === "network-error") {
      assert.match(result.message, NOT_ALLOWLISTED_ERROR);
    }
    assert.equal(fetchCalls.length, 0, `${method} ${path} must not fetch`);
  }
});
