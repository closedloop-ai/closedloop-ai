import { describe, expect, it } from "vitest";
import { filterLiveOthers } from "../shared/presence-utils";

type Other = {
  connectionId: number;
  presence: { cursor: null; selection: null; readOnly?: boolean };
};

function makeOther(connectionId: number, readOnly?: boolean): Other {
  return {
    connectionId,
    presence: {
      cursor: null,
      selection: null,
      ...(readOnly === undefined ? {} : { readOnly }),
    },
  };
}

describe("filterLiveOthers", () => {
  it("removes entries with presence.readOnly === true", () => {
    const result = filterLiveOthers([
      makeOther(1, false),
      makeOther(2, true),
      makeOther(3),
    ]);
    expect(result.map((o) => o.connectionId)).toEqual([1, 3]);
  });

  it("keeps entries where readOnly is undefined (live editors)", () => {
    const result = filterLiveOthers([makeOther(1), makeOther(2)]);
    expect(result.map((o) => o.connectionId)).toEqual([1, 2]);
  });

  it("returns an empty array when every other is read-only", () => {
    const result = filterLiveOthers([makeOther(1, true), makeOther(2, true)]);
    expect(result).toEqual([]);
  });

  it("returns an empty array on empty input", () => {
    expect(filterLiveOthers([])).toEqual([]);
  });
});
