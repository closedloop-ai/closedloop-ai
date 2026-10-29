import type { BasicUser } from "@repo/api/src/types/user";
import { renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { createAgentSessionDetailFixture } from "../../components/detail/agent-session-detail-fixtures";
import { humanActorColor } from "../../lib/trace-human-actor-color";
import { useTranscriptTraceItems } from "../use-transcript-trace-items";

const CREATOR: BasicUser = {
  id: "creator-1",
  email: "ada@example.com",
  firstName: "Ada",
  lastName: "Creator",
  avatarUrl: null,
};
const ALIAS: BasicUser = {
  id: "assignee-1",
  email: "rex@example.com",
  firstName: "Rex",
  lastName: "Assignee",
  avatarUrl: null,
};

function humanActorFor(
  overrides: Parameters<typeof createAgentSessionDetailFixture>[0]
) {
  const session = createAgentSessionDetailFixture(overrides);
  const { result } = renderHook(() =>
    useTranscriptTraceItems({
      session,
      fallbackItems: undefined,
      parsedSession: undefined,
    })
  );
  return result.current.context.humanActor;
}

// ISS-12585: the transcript's human turns are the session creator's, matching
// the server trace; the deprecated `user` field (now the assignee) stands in
// only for an API that predates `createdBy`.
describe("useTranscriptTraceItems human actor", () => {
  it("names the creator, not the deprecated user alias", () => {
    expect(humanActorFor({ createdBy: CREATOR, user: ALIAS })).toEqual({
      name: "Ada Creator",
      color: humanActorColor(true),
    });
  });

  it("falls back to the user field when the producer omits createdBy", () => {
    expect(humanActorFor({ createdBy: undefined, user: ALIAS })).toEqual({
      name: "Rex Assignee",
      color: humanActorColor(true),
    });
  });

  it("reads an explicit null creator as no person, without falling back", () => {
    expect(humanActorFor({ createdBy: null, user: ALIAS })).toEqual({
      name: "You",
      color: humanActorColor(false),
    });
  });
});
