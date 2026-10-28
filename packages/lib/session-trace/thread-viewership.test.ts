import { describe, expect, it } from "vitest";
import { LaunchThreadSource } from "../harness/launch-attribution";
import { isUnattendedAgentThread } from "./thread-viewership";

/**
 * ISS-7830: the rule, at the seam that states it.
 *
 * The cases come in PAIRS on one fixture, because each direction alone is
 * satisfied by an implementation that always answers that way: an
 * `isUnattendedAgentThread` hardcoded to `true` passes every unviewed case, and
 * one hardcoded to `false` passes every viewed case. Only the same attribution
 * answering differently on the two viewership values pins the override.
 */

/** The harness's own statement that another agent spawned this thread. */
const AGENT_SPAWNED = {
  threadSource: LaunchThreadSource.Subagent,
} as const;

/** A person's own thread — the negative control for every case below. */
const USER_STARTED = {
  threadSource: LaunchThreadSource.User,
  promptSource: "typed",
} as const;

const VIEWED = true;
const NEVER_VIEWED = false;

describe("ISS-7830: viewership overrides the launch-attribution default", () => {
  it("an agent-spawned thread nobody opened is unattended", () => {
    expect(isUnattendedAgentThread(AGENT_SPAWNED, NEVER_VIEWED)).toBe(true);
  });

  it("the SAME agent-spawned thread, once opened, is attended", () => {
    // The sibling of the case above, on the identical attribution. Without it,
    // an implementation that ignored viewership entirely would still be green.
    expect(isUnattendedAgentThread(AGENT_SPAWNED, VIEWED)).toBe(false);
  });

  it("an SDK-injected first prompt behaves the same way in both directions", () => {
    // The second leg `isAgentDrivenLaunch` recognises. It must obey the same
    // override, or the rule would hold for one kind of agent-driven launch and
    // silently not the other.
    const sdkInjected = {
      threadSource: LaunchThreadSource.Unstated,
      promptSource: "sdk",
    } as const;
    expect(isUnattendedAgentThread(sdkInjected, NEVER_VIEWED)).toBe(true);
    expect(isUnattendedAgentThread(sdkInjected, VIEWED)).toBe(false);
  });

  it("a thread a person started is attended whether or not it was opened", () => {
    // Viewership may only ever REMOVE the unattended verdict. A signal that could
    // add one would let never opening your own session score it autonomous.
    expect(isUnattendedAgentThread(USER_STARTED, NEVER_VIEWED)).toBe(false);
    expect(isUnattendedAgentThread(USER_STARTED, VIEWED)).toBe(false);
  });

  it("a session carrying no launch facet is unchanged in both directions", () => {
    // Every session imported before the facet existed. The rule must contribute
    // nothing rather than default either way.
    expect(isUnattendedAgentThread(undefined, NEVER_VIEWED)).toBe(false);
    expect(isUnattendedAgentThread(undefined, VIEWED)).toBe(false);
  });
});
