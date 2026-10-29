/**
 * ISS-9398 — `AgentsListSurfaceV2` host capability parity.
 *
 * The executable half of PRD-730's "host capability ledgers cover every optional
 * command or panel and reject presentation omissions". Its discovery check fails
 * on any production mount no ledger classifies, so a third host is guarded from
 * birth rather than from the day someone notices it.
 *
 * ## The two host differences this surface has, classified
 *
 * **Desktop plugin management is a real capability.** Installing, updating and
 * uninstalling packs runs over main-process IPC — `plugins-panel.tsx` drives
 * `window.desktopApi.db.catalog*` — which is `HostBoundarySeam
 * .LocalRuntimeCapability`. Desktop declares it; web declares it absent with the
 * reason below, and the surface then renders NO management affordance there. Not
 * a disabled one: a control a shell cannot fulfil must not be drawn.
 *
 * **Web org management is not a capability of THIS surface.** Promoting a
 * component into the org catalog is web-only, and it lives on the agent DETAIL
 * route (`apps/app/app/(authenticated)/[orgSlug]/agents/[slug]/agent-detail-with-promote.tsx`
 * mounts `PromoteModal`). ISS-9398 keeps that detail surface as the canonical
 * destination and does not rebuild it, so the command is not a prop of the list
 * and does not appear below. It is
 * recorded HERE, where a reader checks what each host can do, so the asymmetry
 * is a stated fact rather than an unexplained gap in one ledger.
 *
 * ## What a prop's KIND means here
 *
 * {@link AGENTS_LIST_SURFACE_V2_CAPABILITY_KINDS} carries one entry and it is
 * `host-capability`. ISS-9216 AC2 is why there is nothing else: a prop that
 * changes what the user sees by being omitted is REQUIRED on this surface rather
 * than classified in this file. `AgentsGroupedList`'s `persistKey` and
 * `getComponentHref` were both that kind of prop.
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { AGENTS_LIST_SURFACE_V2_CAPABILITY_KINDS } from "@repo/app/agents/components/workspace/agents-list-surface-v2-capability-kinds";
import {
  PRESENTATION,
  type SurfaceCapabilityKind,
} from "@repo/app/shared/lib/surface-capability-kind";
import { describe, expect, it } from "vitest";
import { propsPassedToImported } from "./support/jsx-mount-props";
import {
  capabilityDrift,
  declaredOptionalProps,
  type HostCapabilityLedger,
  productionMountsOf,
  SUPPLIED,
  unledgeredMounts,
} from "./support/surface-capability-parity";

const REPO_ROOT = path.join(process.cwd(), "..", "..");
const SEARCH_ROOTS = ["apps", "packages"];
/** The first ledger pays a full `apps` + `packages` walk; the rest reuse it. */
const REPO_WALK_TIMEOUT_MS = 60_000;

const COMPONENT_NAME = "AgentsListSurfaceV2";
const COMPONENT_MODULE =
  "@repo/app/agents/components/workspace/agents-list-surface-v2";
const COMPONENT_PATH =
  "packages/app/agents/components/workspace/agents-list-surface-v2.tsx";
const COMPONENT_MODULE_SUFFIX = "agents-list-surface-v2";

const WEB_HOST_PATH =
  "apps/app/app/(authenticated)/[orgSlug]/agents/components/agents-list-host.tsx";
const DESKTOP_HOST_PATH =
  "apps/desktop/src/renderer/components/agents/agents-view.tsx";

/**
 * What the web shell LACKS, stated as the thing it lacks.
 *
 * Not "web does not manage plugins" — that restates the omission. The pack
 * install/uninstall path is a spawned local process reached over Electron IPC,
 * and a browser tab has no channel to it at all.
 */
const NO_LOCAL_PACK_RUNTIME =
  "The web shell has no local pack runtime: install, update and uninstall run as main-process work behind the desktop `window.desktopApi.db.catalog*` IPC channels, which a browser tab cannot reach. Org-wide pack distribution is the sibling Packs route, not this list.";

const WEB_LEDGER: HostCapabilityLedger = {
  componentModule: COMPONENT_MODULE,
  componentName: COMPONENT_NAME,
  componentPath: COMPONENT_PATH,
  hostPath: WEB_HOST_PATH,
  kinds: AGENTS_LIST_SURFACE_V2_CAPABILITY_KINDS,
  capabilities: {
    pluginManagement: { notSupported: NO_LOCAL_PACK_RUNTIME },
  },
};

const DESKTOP_LEDGER: HostCapabilityLedger = {
  componentModule: COMPONENT_MODULE,
  componentName: COMPONENT_NAME,
  componentPath: COMPONENT_PATH,
  hostPath: DESKTOP_HOST_PATH,
  kinds: AGENTS_LIST_SURFACE_V2_CAPABILITY_KINDS,
  capabilities: {
    pluginManagement: SUPPLIED,
  },
};

const LEDGERS = [WEB_LEDGER, DESKTOP_LEDGER];

describe.each(LEDGERS)(
  "$hostPath AgentsListSurfaceV2 capabilities",
  (ledger) => {
    const componentFile = path.join(REPO_ROOT, ledger.componentPath);
    const declaredOptional = declaredOptionalProps(
      readFileSync(componentFile, "utf8"),
      ledger.componentName,
      componentFile
    );
    const supplied = propsPassedToImported(
      readFileSync(path.join(REPO_ROOT, ledger.hostPath), "utf8"),
      ledger.componentModule,
      ledger.componentName
    );

    it("classifies every optional capability, and every claim matches the JSX", () => {
      expect(
        capabilityDrift({ declaredOptional, ledger, supplied })
      ).toStrictEqual([]);
    });

    it("reads a non-empty capability set from both sources", () => {
      expect(declaredOptional.size).toBeGreaterThan(0);
      expect(supplied.size).toBeGreaterThan(0);
      expect(Object.keys(ledger.capabilities)).toHaveLength(
        declaredOptional.size
      );
      // ISS-9218: the kind map is `satisfies`-bound to the prop TYPE; this reads
      // the same props off the AST. A prop reaching this ledger with no kind
      // would keep the old, unrestricted escape hatch.
      expect(Object.keys(ledger.kinds)).toHaveLength(declaredOptional.size);
    });
  }
);

/**
 * ISS-9216 AC2, as a property of this surface rather than of a host.
 *
 * Sessions has five `presentation` seeds and needs the guard to police them.
 * This surface has none, and that is the stronger position: a value every host
 * can produce is required, so there is nothing for a host to omit silently. The
 * assertion is stated positively — a future `presentation` prop reddens here and
 * has to be argued for, instead of arriving classified and unnoticed.
 */
describe("AgentsListSurfaceV2 presentation props", () => {
  it("declares none, so no host can choose a default silently", () => {
    // Widened to the map's declared VALUE type before the comparison. Every
    // entry is literal-typed `host-capability` today, so `kind === PRESENTATION`
    // is a comparison `tsc` rejects as impossible — which is the stronger
    // statement of the same fact, and also the reason the runtime check has to
    // read through the wider type to stay compilable as the map grows.
    const kinds: Readonly<Record<string, SurfaceCapabilityKind>> =
      AGENTS_LIST_SURFACE_V2_CAPABILITY_KINDS;
    const presentationProps = Object.entries(kinds)
      .filter(([, kind]) => kind === PRESENTATION)
      .map(([prop]) => prop);

    expect(presentationProps).toStrictEqual([]);
    // Not vacuous: an empty map would satisfy the assertion above forever.
    expect(Object.keys(kinds).length).toBeGreaterThan(0);
  });
});

/**
 * ISS-9218's counterfactual, run against THIS surface's ledger.
 *
 * It mutates the WEB ledger, because web is the host that genuinely WITHHOLDS
 * the capability. Mutating desktop's proves nothing about the presentation rule:
 * desktop passes the prop, so the differ stops at "classified notSupported but
 * this host does pass it" and never reaches the kind at all.
 *
 * The property above says there is no presentation prop today. That is a claim
 * about the surface; it is not evidence the guard would object if there were
 * one, and an armed guard is what stops the next `pageSizeOptions`. So this
 * reclassifies the real capability as `presentation` and `notSupported`s it away
 * with the exact pointer reason ISS-9218 was reported for, and pins both
 * messages the differ must produce.
 *
 * The expectations are written-out literals, not built from the differ's own
 * remedy strings: a message assembled from the thing it grades agrees with it by
 * construction.
 */
describe("the notSupported entry this guard must refuse", () => {
  const PROP = "pluginManagement";
  const POINTER_REASON = "See onPageSizeChange.";

  it("reddens when a presentation-classified capability is notSupported-ed away", () => {
    const componentFile = path.join(REPO_ROOT, COMPONENT_PATH);
    const mutated: HostCapabilityLedger = {
      ...WEB_LEDGER,
      capabilities: { [PROP]: { notSupported: POINTER_REASON } },
      kinds: { [PROP]: PRESENTATION },
    };

    expect(
      capabilityDrift({
        declaredOptional: declaredOptionalProps(
          readFileSync(componentFile, "utf8"),
          COMPONENT_NAME,
          componentFile
        ),
        ledger: mutated,
        supplied: propsPassedToImported(
          readFileSync(path.join(REPO_ROOT, WEB_HOST_PATH), "utf8"),
          COMPONENT_MODULE,
          COMPONENT_NAME
        ),
      })
    ).toStrictEqual([
      `${WEB_HOST_PATH}: capability "${PROP}" is presentation on ${COMPONENT_NAME}, so "notSupported" cannot be true of it — nothing stops this host passing a value, and omitting it silently swaps in the surface's own default. Pass it, or declare it inertWithout the companion this host withholds.`,
      `${WEB_HOST_PATH}: capability "${PROP}" gives "${POINTER_REASON}" as its notSupported reason, which only points at another entry instead of stating why this host cannot support it. Say what this host lacks, or declare it inertWithout/inertUnder that entry so the guard checks the dependency rather than a reader grading a sentence.`,
    ]);
  });
});

describe("AgentsListSurfaceV2 production mounts", () => {
  it(
    "has a ledger for every production module that mounts it",
    () => {
      const mounts = productionMountsOf({
        exportName: COMPONENT_NAME,
        moduleSuffix: COMPONENT_MODULE_SUFFIX,
        repoRoot: REPO_ROOT,
        searchRoots: SEARCH_ROOTS,
      });

      expect(
        unledgeredMounts({
          componentName: COMPONENT_NAME,
          ledgers: LEDGERS,
          mounts,
        })
      ).toStrictEqual([]);
      // Not vacuous: discovery that found nothing would report no gap forever.
      expect(mounts).toStrictEqual([WEB_HOST_PATH, DESKTOP_HOST_PATH]);
    },
    REPO_WALK_TIMEOUT_MS
  );
});
