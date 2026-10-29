/**
 * ISS-8636 / ISS-9218 — the DIFFER, driven against synthetic ledgers.
 *
 * Split out of `sessions-list-v2-host-capability-parity.test.ts` (ISS-9218),
 * which is the executable audit of three real hosts; these are tests of the
 * mechanism that audits them, and they must be able to fail on inputs the repo
 * does not happen to contain today. Keeping them here also keeps the ledger file
 * a ledger.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  HOST_CAPABILITY,
  PRESENTATION,
} from "@repo/app/shared/lib/surface-capability-kind";
import { afterAll, describe, expect, it } from "vitest";
import { propsPassedToImported } from "./support/jsx-mount-props";
import {
  capabilityDrift,
  declaredOptionalProps,
  type HostCapabilityLedger,
  SUPPLIED,
  unledgeredMounts,
} from "./support/surface-capability-parity";

describe("the parity check itself", () => {
  const COMPONENT = `
    export function Surface({ alpha, beta, rows }: {
      alpha?: string;
      beta?: string;
      rows: string;
    }) { return null; }
  `;
  const HOST = `
    import { Surface } from "./surface";
    export const Host = () => <Surface alpha={1} rows={2} />;
  `;
  const BOTH_HOST_CAPABILITY = {
    alpha: HOST_CAPABILITY,
    beta: HOST_CAPABILITY,
  } as const;
  const ledgerWith = (
    capabilities: HostCapabilityLedger["capabilities"],
    kinds: HostCapabilityLedger["kinds"] = BOTH_HOST_CAPABILITY
  ): HostCapabilityLedger => ({
    capabilities,
    componentModule: "./surface",
    componentName: "Surface",
    componentPath: "surface.tsx",
    hostPath: "host.tsx",
    kinds,
  });
  const driftFor = (
    capabilities: HostCapabilityLedger["capabilities"],
    kinds?: HostCapabilityLedger["kinds"]
  ) =>
    capabilityDrift({
      declaredOptional: declaredOptionalProps(COMPONENT, "Surface"),
      ledger: ledgerWith(capabilities, kinds),
      supplied: propsPassedToImported(HOST, "./surface", "Surface"),
    });
  const REAL_REASON =
    "This host reads a local store with no cloud record behind it, so there is nothing to wire.";

  // The inert claims need three optional props at once — one the host passes,
  // one it withholds, and the one making the claim about them.
  const TRIO_COMPONENT = `
    export function Trio({ inert, passed, withheld, rows }: {
      inert?: string;
      passed?: string;
      withheld?: string;
      rows: string;
    }) { return null; }
  `;
  const TRIO_HOST = `
    import { Trio } from "./trio";
    export const Host = () => <Trio passed={1} rows={2} />;
  `;
  const TRIO_KINDS = {
    inert: PRESENTATION,
    passed: HOST_CAPABILITY,
    withheld: HOST_CAPABILITY,
  } as const;
  const trioDrift = (capabilities: HostCapabilityLedger["capabilities"]) =>
    capabilityDrift({
      declaredOptional: declaredOptionalProps(TRIO_COMPONENT, "Trio"),
      ledger: {
        capabilities,
        componentModule: "./trio",
        componentName: "Trio",
        componentPath: "trio.tsx",
        hostPath: "host.tsx",
        kinds: TRIO_KINDS,
      },
      supplied: propsPassedToImported(TRIO_HOST, "./trio", "Trio"),
    });

  it("reads only the optional props, never the required ones", () => {
    expect([...declaredOptionalProps(COMPONENT, "Surface")]).toStrictEqual([
      "alpha",
      "beta",
    ]);
  });

  // A surface big enough to need this guard is a surface whose props get split
  // out for the 1,000-line ceiling — `SessionsListSurfaceV2Props` was, on main,
  // while this branch was open. A reader that only understood an inline literal
  // fails closed on that refactor and stops guarding anything.
  it("reads the props off a named alias in the component's own module", () => {
    const aliased = `
      type SurfaceProps = { alpha?: string; beta?: string; rows: string };
      export function Surface({ alpha, beta, rows }: SurfaceProps) { return null; }
    `;
    expect([...declaredOptionalProps(aliased, "Surface")]).toStrictEqual([
      "alpha",
      "beta",
    ]);
  });

  it("follows a named alias imported from a relative sibling", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "capability-parity-"));
    temporaryDirs.push(dir);
    writeFileSync(
      path.join(dir, "surface-props.ts"),
      "export type SurfaceProps = { alpha?: string; beta?: string; rows: string };"
    );
    const component = `
      import type { SurfaceProps } from "./surface-props";
      export function Surface({ alpha, beta, rows }: SurfaceProps) { return null; }
    `;
    expect([
      ...declaredOptionalProps(
        component,
        "Surface",
        path.join(dir, "surface.tsx")
      ),
    ]).toStrictEqual(["alpha", "beta"]);
  });

  // The refusal matters more than the resolution: a reader that returned the
  // props it happened to understand would under-report the declared set, and an
  // unclassified capability would then read as fully classified — the silence
  // this whole check exists to close, one level up.
  it("refuses a prop type it cannot resolve to a literal", () => {
    const unresolvable = `
      import type { SurfaceProps } from "@somewhere/else";
      export function Surface({ alpha }: SurfaceProps) { return null; }
    `;
    expect(() => declaredOptionalProps(unresolvable, "Surface")).toThrow(
      UNRESOLVABLE_PROP_TYPE_REFUSAL
    );
  });

  it("accepts a fully classified host", () => {
    expect(
      driftFor({ alpha: SUPPLIED, beta: { notSupported: REAL_REASON } })
    ).toStrictEqual([]);
  });

  it("names the capability and the host when a supplied one stops being passed", () => {
    expect(
      driftFor({ alpha: { notSupported: "x" }, beta: SUPPLIED })
    ).toStrictEqual([
      'host.tsx: capability "alpha" is classified notSupported ("x") but this host does pass it to Surface. Reclassify it as supplied.',
      'host.tsx: capability "beta" is classified supplied but this host does not pass it to Surface, so the affordance never renders. Pass it, or reclassify it as notSupported with the reason.',
    ]);
  });

  it("names an optional prop no host has classified", () => {
    expect(driftFor({ alpha: SUPPLIED })).toStrictEqual([
      'host.tsx: capability "beta" is optional on Surface but this host classifies it nowhere. Pass it, or record it as notSupported with the reason.',
    ]);
  });

  it("names a stale entry the component no longer declares", () => {
    expect(
      driftFor({
        alpha: SUPPLIED,
        beta: { notSupported: REAL_REASON },
        gamma: { notSupported: REAL_REASON },
      })
    ).toStrictEqual([
      'host.tsx: capability "gamma" is classified here but Surface no longer declares it as optional. Drop the stale entry.',
    ]);
  });

  // ISS-9218 — the distinction itself, driven against synthetic ledgers so it is
  // exercised whatever today's real ledgers happen to say.
  it("refuses notSupported on a presentation prop, and says why", () => {
    expect(
      driftFor(
        { alpha: SUPPLIED, beta: { notSupported: REAL_REASON } },
        { alpha: HOST_CAPABILITY, beta: PRESENTATION }
      )
    ).toStrictEqual([
      'host.tsx: capability "beta" is presentation on Surface, so "notSupported" cannot be true of it — nothing stops this host passing a value, and omitting it silently swaps in the surface\'s own default. Pass it, or declare it inertWithout the companion this host withholds.',
    ]);
  });

  it("keeps notSupported available to a host-capability prop", () => {
    expect(
      driftFor(
        { alpha: SUPPLIED, beta: { notSupported: REAL_REASON } },
        { alpha: PRESENTATION, beta: HOST_CAPABILITY }
      )
    ).toStrictEqual([]);
  });

  it("names a prop the capability-kind map does not classify", () => {
    expect(
      driftFor(
        { alpha: SUPPLIED, beta: { notSupported: REAL_REASON } },
        { alpha: HOST_CAPABILITY }
      )
    ).toStrictEqual([
      'host.tsx: capability "beta" is optional on Surface but its capability-kind map declares no kind for it. Classify it beside the prop type as host-capability or presentation.',
    ]);
  });

  it("rejects a reason that only cross-references another entry", () => {
    expect(
      driftFor({ alpha: SUPPLIED, beta: { notSupported: "See alpha." } })
    ).toStrictEqual([
      'host.tsx: capability "beta" gives "See alpha." as its notSupported reason, which only points at another entry instead of stating why this host cannot support it. Say what this host lacks, or declare it inertWithout/inertUnder that entry so the guard checks the dependency rather than a reader grading a sentence.',
    ]);
  });

  it("rejects a reason too short to state an inability", () => {
    expect(
      driftFor({ alpha: SUPPLIED, beta: { notSupported: "no seam yet" } })
    ).toStrictEqual([
      'host.tsx: capability "beta" gives "no seam yet" as its notSupported reason, which is too short to state why this host cannot support it.',
    ]);
  });

  it("rejects an empty reason", () => {
    expect(
      driftFor({ alpha: SUPPLIED, beta: { notSupported: "   " } })
    ).toStrictEqual([
      'host.tsx: capability "beta" is notSupported with no reason at all. State why this host cannot support it.',
    ]);
  });

  it("accepts a presentation prop declared inert behind a withheld companion", () => {
    expect(
      trioDrift({
        inert: { inertWithout: "withheld" },
        passed: SUPPLIED,
        withheld: { notSupported: REAL_REASON },
      })
    ).toStrictEqual([]);
  });

  // The claim expires on its own. This is what makes `inertWithout` a check
  // rather than the old escape hatch under a new key: the moment ISS-9216 wires
  // desktop's `onPageSizeChange`, the real ledger's entry fails exactly here.
  it("reddens when the companion an inert prop hides behind IS supplied", () => {
    expect(
      trioDrift({
        inert: { inertWithout: "passed" },
        passed: SUPPLIED,
        withheld: { notSupported: REAL_REASON },
      })
    ).toStrictEqual([
      'host.tsx: capability "inert" is declared inert without "passed", but this host DOES supply "passed", so the affordance it configures renders and omitting it changes what the reader sees. Pass it.',
    ]);
  });

  it("accepts an inert-under claim whose companion IS supplied", () => {
    expect(
      trioDrift({
        inert: { inertUnder: "passed" },
        passed: SUPPLIED,
        withheld: { notSupported: REAL_REASON },
      })
    ).toStrictEqual([]);
  });

  it("reddens when the companion an inert-under prop is superseded by is NOT supplied", () => {
    expect(
      trioDrift({
        inert: { inertUnder: "withheld" },
        passed: SUPPLIED,
        withheld: { notSupported: REAL_REASON },
      })
    ).toStrictEqual([
      'host.tsx: capability "inert" is declared inert under "withheld", but this host does not supply "withheld", so nothing supersedes it and its own value is what the surface would use. Pass it.',
    ]);
  });

  it("names an inert claim pointing at a capability this ledger does not carry", () => {
    expect(
      trioDrift({
        inert: { inertWithout: "absent" },
        passed: SUPPLIED,
        withheld: { notSupported: REAL_REASON },
      })
    ).toStrictEqual([
      'host.tsx: capability "inert" is declared inert without "absent", which this host classifies nowhere. Name a capability this ledger carries.',
    ]);
  });

  it("refuses an inert claim that points at itself", () => {
    expect(
      trioDrift({
        inert: { inertWithout: "inert" },
        passed: SUPPLIED,
        withheld: { notSupported: REAL_REASON },
      })
    ).toStrictEqual([
      'host.tsx: capability "inert" is declared inert without itself, which asserts nothing. Name the OTHER capability that makes it inert.',
    ]);
  });

  // ISS-9218 review cid 3937680744 — the self-reference check is the one-node
  // case, and stopping there left the ring open: two withheld props naming each
  // other satisfy the companion-withheld rule individually, so both pass and the
  // pair vouches for itself. Reported ONCE, from whichever entry is walked first.
  it("refuses two inert claims that name each other", () => {
    expect(
      trioDrift({
        inert: { inertWithout: "withheld" },
        passed: SUPPLIED,
        withheld: { inertWithout: "inert" },
      })
    ).toStrictEqual([
      'host.tsx: capabilities "inert" → "withheld" → "inert" declare one another inert in a closed ring, so every claim in it is vouched for only by another member and all of them can be withheld with nothing checked. Break the ring: at least one of them must be passed, or answered as notSupported with the reason.',
    ]);
  });

  it("reports an inert prop the host actually passes", () => {
    expect(
      trioDrift({
        inert: { inertWithout: "withheld" },
        passed: { inertUnder: "inert" },
        withheld: { notSupported: REAL_REASON },
      })
    ).toStrictEqual([
      'host.tsx: capability "passed" is classified inert under "inert" but this host does pass it to Trio. Reclassify it as supplied.',
    ]);
  });

  // ISS-9223 narrowed this: the surface→GridTableV2 seam one layer down cannot
  // refuse every spread, because both list surfaces spread. What is still
  // refused is a spread whose prop set cannot be PROVEN — a parameter here — so
  // an unreadable one is never quietly read as supplying none.
  it("refuses a host that spreads an expression it cannot resolve", () => {
    const spread = `
      import { Surface } from "./surface";
      export const Host = (p) => <Surface {...p} />;
    `;
    expect(() => propsPassedToImported(spread, "./surface", "Surface")).toThrow(
      SPREAD_REFUSAL
    );
  });

  it("refuses a spread of a name the module declares twice", () => {
    const shadowed = `
      import { Surface } from "./surface";
      const props = { alpha: 1 };
      export const Host = () => {
        const props = { beta: 2 };
        return <Surface {...props} />;
      };
    `;
    expect(() =>
      propsPassedToImported(shadowed, "./surface", "Surface")
    ).toThrow(SPREAD_REFUSAL);
  });

  // `var` has no TDZ, so this typechecks. Without a visited set the reader
  // recurses between the two names until the stack overflows.
  it("refuses a spread whose initializers refer back to one another", () => {
    const looping = `
      import { Surface } from "./surface";
      var alpha = beta;
      var beta = alpha;
      export const Host = () => <Surface {...alpha} />;
    `;
    expect(() =>
      propsPassedToImported(looping, "./surface", "Surface")
    ).toThrow(SPREAD_REFUSAL);
  });

  it("reads the keys of a spread object literal declared in the module", () => {
    const spread = `
      import { Surface } from "./surface";
      const gridProps = { alpha: 1, beta: 2 };
      export const Host = () => <Surface {...gridProps} gamma={3} />;
    `;
    expect([
      ...propsPassedToImported(spread, "./surface", "Surface"),
    ]).toStrictEqual(["alpha", "beta", "gamma"]);
  });

  // The Sessions grid's own shape: a ternary between two named `as const` prop
  // shapes, one per gate state. Only what BOTH branches carry is supplied —
  // the same rule the reader already applies across several mounts.
  it("intersects the branches of a spread ternary", () => {
    const branched = `
      import { Surface } from "./surface";
      const OPEN = { alpha: true, beta: true } as const;
      const CLOSED = { alpha: false } as const;
      export const Host = ({ on }) => <Surface {...(on ? OPEN : CLOSED)} />;
    `;
    expect([
      ...propsPassedToImported(branched, "./surface", "Surface"),
    ]).toStrictEqual(["alpha"]);
  });

  it("refuses a host that no longer renders the component at all", () => {
    const gone = `
      import { Surface } from "./surface";
      export const Host = () => null;
    `;
    expect(() => propsPassedToImported(gone, "./surface", "Surface")).toThrow(
      NOT_RENDERED_REFUSAL
    );
  });

  // A reader that collected attributes from every JSX element would report a
  // sibling's prop as this component's, so an unwired capability would read as
  // supplied — the false-positive direction of the exact silence this guards.
  it("ignores a sibling element carrying the same attribute name", () => {
    const siblings = `
      import { Surface } from "./surface";
      import { Other } from "./other";
      export const Host = () => (
        <>
          <Other beta={1} />
          <Surface alpha={1} />
        </>
      );
    `;
    expect([
      ...propsPassedToImported(siblings, "./surface", "Surface"),
    ]).toStrictEqual(["alpha"]);
  });

  // An early `return <Surface rows usage />` on the errored path is the original
  // outage's own shape. A union across mounts would call the affordances that
  // branch drops supplied, so the guard would be green while a reader on that
  // path got none of them.
  it("counts a capability supplied only when every mount passes it", () => {
    const branched = `
      import { Surface } from "./surface";
      export const Host = ({ failed }) =>
        failed ? <Surface /> : <Surface alpha={1} />;
    `;
    expect([
      ...propsPassedToImported(branched, "./surface", "Surface"),
    ]).toStrictEqual([]);
    expect(
      driftFor({ alpha: SUPPLIED, beta: { notSupported: REAL_REASON } })
    ).toStrictEqual([]);
  });

  // The discovery filter, driven against synthetic ledgers rather than only
  // against today's repo. Two ledgers that happen to share no host path pass
  // the scoped and the unscoped form identically, so the production run above
  // cannot tell them apart; these can.
  const SURFACE_IN_PAGE: HostCapabilityLedger = {
    capabilities: {},
    kinds: {},
    componentModule: "@repo/surface",
    componentName: "Surface",
    componentPath: "packages/surface.tsx",
    hostPath: "apps/host.tsx",
  };
  const HOST_IN_PAGE: HostCapabilityLedger = {
    capabilities: {},
    kinds: {},
    componentModule: "@/host",
    componentName: "Host",
    componentPath: "apps/host.tsx",
    hostPath: "apps/page.tsx",
  };
  const LEDGER_PAIR = [SURFACE_IN_PAGE, HOST_IN_PAGE];

  it("accepts a mount the component's own ledger classifies", () => {
    expect(
      unledgeredMounts({
        componentName: "Surface",
        ledgers: LEDGER_PAIR,
        mounts: ["apps/host.tsx"],
      })
    ).toStrictEqual([]);
  });

  it("names a mount only a DIFFERENT component's ledger covers", () => {
    // `apps/page.tsx` is ledgered — for Host, not for Surface. An unscoped set
    // of every ledger's hostPath swallows this and reports no gap.
    expect(
      unledgeredMounts({
        componentName: "Surface",
        ledgers: LEDGER_PAIR,
        mounts: ["apps/host.tsx", "apps/page.tsx"],
      })
    ).toStrictEqual(["apps/page.tsx"]);
  });

  it("names a mount no ledger covers at all", () => {
    expect(
      unledgeredMounts({
        componentName: "Surface",
        ledgers: LEDGER_PAIR,
        mounts: ["apps/desktop-host.tsx"],
      })
    ).toStrictEqual(["apps/desktop-host.tsx"]);
  });

  it("resolves an aliased import rather than a literal tag name", () => {
    const aliased = `
      import { Surface as Renamed } from "./surface";
      export const Host = () => <Renamed alpha={1} />;
    `;
    expect([
      ...propsPassedToImported(aliased, "./surface", "Surface"),
    ]).toStrictEqual(["alpha"]);
  });
});

const SPREAD_REFUSAL =
  /cannot be read\. Pass them by name\.|cannot resolve to a prop set/;
const NOT_RENDERED_REFUSAL = /never renders/;
const UNRESOLVABLE_PROP_TYPE_REFUSAL = /cannot resolve to a type literal/;

/** Fixture modules the sibling-import case has to put on disk to be resolved. */
const temporaryDirs: string[] = [];

afterAll(() => {
  for (const dir of temporaryDirs) {
    rmSync(dir, { force: true, recursive: true });
  }
});
