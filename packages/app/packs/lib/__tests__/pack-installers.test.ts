import { describe, expect, it } from "vitest";
import { packInstallersFromNames } from "../pack-installers";

describe("packInstallersFromNames", () => {
  it("returns an empty array for an empty roster", () => {
    expect(packInstallersFromNames([])).toEqual([]);
  });

  it("maps a single name onto its own id, name, and initials", () => {
    expect(packInstallersFromNames(["Jane Doe"])).toEqual([
      { id: "Jane Doe", initials: "J", name: "Jane Doe" },
    ]);
  });

  it("gives every unique name its own id equal to the name", () => {
    expect(packInstallersFromNames(["Jane Doe", "Bob Smith"])).toEqual([
      { id: "Jane Doe", initials: "J", name: "Jane Doe" },
      { id: "Bob Smith", initials: "B", name: "Bob Smith" },
    ]);
  });

  it("suffixes the second occurrence of a repeated name to keep ids unique", () => {
    expect(packInstallersFromNames(["Jane Doe", "Jane Doe"])).toEqual([
      { id: "Jane Doe", initials: "J", name: "Jane Doe" },
      { id: "Jane Doe#2", initials: "J", name: "Jane Doe" },
    ]);
  });

  it("numbers a name repeated three times as #1 (unsuffixed), #2, #3", () => {
    expect(packInstallersFromNames(["Cher", "Cher", "Cher"])).toEqual([
      { id: "Cher", initials: "C", name: "Cher" },
      { id: "Cher#2", initials: "C", name: "Cher" },
      { id: "Cher#3", initials: "C", name: "Cher" },
    ]);
  });

  it("doubles a literal # in the name before appending an occurrence suffix", () => {
    const result = packInstallersFromNames(["A#B", "A#B"]);

    expect(result).toEqual([
      { id: "A##B", initials: "A", name: "A#B" },
      { id: "A##B#2", initials: "A", name: "A#B" },
    ]);
  });

  it("keeps a literal '#2' name distinct from a suffixed second occurrence of a shorter name", () => {
    // Per the module doc: ["Alex", "Alex", "Alex#2"] must not collapse the
    // second "Alex" (suffixed to "Alex#2") with the literal "Alex#2" name
    // (escaped to "Alex##2"), because that would collide two different rows
    // onto one React key.
    const result = packInstallersFromNames(["Alex", "Alex", "Alex#2"]);

    expect(result.map((installer) => installer.id)).toEqual([
      "Alex",
      "Alex#2",
      "Alex##2",
    ]);
    expect(new Set(result.map((installer) => installer.id)).size).toBe(3);
  });

  // One initial on every avatar (Nerys, 2026-10-22).
  it("computes one initial from the name's first letter", () => {
    const result = packInstallersFromNames([
      "Jane Doe",
      "Cher",
      "John Fitzgerald Kennedy",
    ]);

    expect(result.map((installer) => installer.initials)).toEqual([
      "J",
      "C",
      "J",
    ]);
  });

  it("preserves the producer's order and the original display name on every row", () => {
    const result = packInstallersFromNames(["Bob Smith", "Jane Doe"]);

    expect(result.map((installer) => installer.name)).toEqual([
      "Bob Smith",
      "Jane Doe",
    ]);
  });
});
