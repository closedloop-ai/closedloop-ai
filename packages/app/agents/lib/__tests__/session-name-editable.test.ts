import { describe, expect, it } from "vitest";
import { sessionNameIsEditableBy } from "../session-name-editable";

/**
 * ISS-8718 acceptance: "A non-owner is not offered the affordance — the UI must
 * not present a control the API will refuse." Every case below is a shape the
 * Sessions list actually serves, and the absent-operand cases are the ones a
 * naive `===` gets wrong by matching `undefined` with `undefined`.
 *
 * ISS-12251 D-6 (PLN-2176 T-4.5): the owner is the session's assignee; the
 * recording user (`user`) stands in only for a producer that omits `assignee`.
 */

const VIEWER = "11111111-1111-4111-8111-111111111111";
const SOMEONE_ELSE = "22222222-2222-4222-8222-222222222222";

describe("sessionNameIsEditableBy", () => {
  it("offers the affordance to the session's assignee, whoever recorded it", () => {
    expect(
      sessionNameIsEditableBy(
        { assignee: { id: VIEWER }, user: { id: SOMEONE_ELSE } },
        VIEWER
      )
    ).toBe(true);
  });

  it("withholds it from the recording user once someone else is the assignee", () => {
    expect(
      sessionNameIsEditableBy(
        { assignee: { id: SOMEONE_ELSE }, user: { id: VIEWER } },
        VIEWER
      )
    ).toBe(false);
  });

  it("withholds it while the viewer is not yet known", () => {
    expect(
      sessionNameIsEditableBy({ assignee: { id: VIEWER } }, undefined)
    ).toBe(false);
  });

  it("does not match an unknown viewer against an unknown owner", () => {
    // Both operands absent. A bare `a === b` returns true here and would offer
    // every row an editor on a mount that can name neither party.
    expect(sessionNameIsEditableBy({ assignee: {} }, undefined)).toBe(false);
    expect(sessionNameIsEditableBy({ assignee: {} }, VIEWER)).toBe(false);
  });

  it("withholds it for an unassigned session, without falling back to the recording user", () => {
    // `assignee_id` is SetNull and a POST without an owner leaves it null. The
    // API admits only an org admin here (ISS-8733); this predicate does not,
    // and the module says why.
    expect(
      sessionNameIsEditableBy({ assignee: null, user: { id: VIEWER } }, VIEWER)
    ).toBe(false);
  });

  describe("a producer that predates `assignee` (AC-012)", () => {
    it("offers it to the recording user, the owner that API authorizes", () => {
      expect(sessionNameIsEditableBy({ user: { id: VIEWER } }, VIEWER)).toBe(
        true
      );
    });

    it("withholds it from anyone else", () => {
      expect(
        sessionNameIsEditableBy({ user: { id: SOMEONE_ELSE } }, VIEWER)
      ).toBe(false);
      expect(sessionNameIsEditableBy({ user: null }, VIEWER)).toBe(false);
    });
  });

  it("withholds it for a projection that carries no owner key at all", () => {
    expect(sessionNameIsEditableBy({}, VIEWER)).toBe(false);
  });
});
