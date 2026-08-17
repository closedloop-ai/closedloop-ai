/**
 * FEA-4011 Slice A — DB-free unit tests for the agent-component corpus of the
 * `search_document` backfill. Shares the in-memory `SearchBackfillClient` fake
 * and record factories with the other corpus suites via the fixtures module.
 */

import {
  encodeComponentSlug,
  routableComponentSlug,
} from "@repo/api/src/types/agent-component-analytics";
import { SearchEntityType } from "@repo/api/src/types/search-entity-kind";
import { describe, expect, it } from "vitest";
import { runSearchDocumentBackfill } from "./backfill-search-documents";
import {
  AT,
  agentComponent,
  makeFakeClient,
  ORG_A,
  ORG_B,
} from "./backfill-search-documents.fixtures";

describe("runSearchDocumentBackfill — agent-component corpus (FEA-4011 Slice A)", () => {
  it("projects a component: title from name, slug via the codec, subtype=kind, nulls for the rest", async () => {
    const { client, store } = makeFakeClient({
      artifacts: [],
      projects: [],
      loops: [],
      agentComponents: [
        agentComponent({
          id: "ac1",
          componentKind: "skill",
          name: "Design Review",
          componentKey: "design-review",
          externalComponentId: "ext-ac1",
          description: "runs a design review pass",
        }),
      ],
    });

    const counts = await runSearchDocumentBackfill(client);

    expect(counts.agentComponents).toBe(1);
    const row = store.get(`${ORG_A}|${SearchEntityType.AgentComponent}|ac1`);
    expect(row).toMatchObject({
      entityType: SearchEntityType.AgentComponent,
      entityId: "ac1",
      title: "Design Review",
      body: "runs a design review pass",
      // slug is built via the shared SSOT codec.
      slug: encodeComponentSlug("skill", "design-review", "Design Review"),
      entitySubtype: "skill",
      projectId: null,
      assigneeId: null,
      status: null,
      priority: null,
      teamId: null,
      anchorEntityId: null,
    });
  });

  it("falls back name → componentKey → externalComponentId for the title", async () => {
    const { client, store } = makeFakeClient({
      artifacts: [],
      projects: [],
      loops: [],
      agentComponents: [
        // name null → falls to componentKey.
        agentComponent({
          id: "byKey",
          name: null,
          componentKey: "my-command",
          externalComponentId: "ext-byKey",
        }),
        // name + componentKey null → falls to externalComponentId.
        agentComponent({
          id: "byExt",
          name: null,
          componentKey: null,
          externalComponentId: "ext-byExt",
        }),
      ],
    });

    await runSearchDocumentBackfill(client);

    expect(
      store.get(`${ORG_A}|${SearchEntityType.AgentComponent}|byKey`)?.title
    ).toBe("my-command");
    expect(
      store.get(`${ORG_A}|${SearchEntityType.AgentComponent}|byExt`)?.title
    ).toBe("ext-byExt");
  });

  it("excludes uninstalled components from the projection", async () => {
    const { client, store } = makeFakeClient({
      artifacts: [],
      projects: [],
      loops: [],
      agentComponents: [
        agentComponent({ id: "live", name: "Live" }),
        agentComponent({ id: "gone", name: "Gone", uninstalledAt: AT }),
      ],
    });

    const counts = await runSearchDocumentBackfill(client);

    expect(counts.agentComponents).toBe(1);
    expect(store.has(`${ORG_A}|${SearchEntityType.AgentComponent}|live`)).toBe(
      true
    );
    expect(store.has(`${ORG_A}|${SearchEntityType.AgentComponent}|gone`)).toBe(
      false
    );
  });

  it("is idempotent for components and keeps two orgs isolated", async () => {
    const fake = makeFakeClient({
      artifacts: [],
      projects: [],
      loops: [],
      agentComponents: [
        agentComponent({ id: "shared", organizationId: ORG_A, name: "Same" }),
        agentComponent({ id: "shared", organizationId: ORG_B, name: "Same" }),
      ],
    });

    await runSearchDocumentBackfill(fake.client);
    const sizeAfterFirst = fake.store.size;
    const snapshot = new Map(fake.store);

    await runSearchDocumentBackfill(fake.client);

    // Two orgs → two distinct rows; re-run is a no-op on contents.
    expect(sizeAfterFirst).toBe(2);
    expect(fake.store.size).toBe(2);
    for (const [key, row] of fake.store) {
      expect(row).toEqual(snapshot.get(key));
    }
    for (const org of [ORG_A, ORG_B]) {
      expect(
        fake.store.has(`${org}|${SearchEntityType.AgentComponent}|shared`)
      ).toBe(true);
    }
  });

  it("stores a null slug for an identity-less component (no key, no name) so it degrades to a non-link", async () => {
    const { client, store } = makeFakeClient({
      artifacts: [],
      projects: [],
      loops: [],
      agentComponents: [
        agentComponent({
          id: "noIdentity",
          componentKind: "tool",
          name: null,
          componentKey: null,
          externalComponentId: "ext-noIdentity",
        }),
      ],
    });

    await runSearchDocumentBackfill(client);

    const row = store.get(
      `${ORG_A}|${SearchEntityType.AgentComponent}|noIdentity`
    );
    // An empty identity encodes to `tool::`, which cannot route — the codec
    // returns null so the projection stores SQL NULL and the hit is a non-link.
    expect(routableComponentSlug("tool", null, null)).toBeNull();
    expect(row?.slug).toBeNull();
    // Title still falls back to the external id so the row is searchable.
    expect(row?.title).toBe("ext-noIdentity");
  });

  it("removes a stale projection on re-run after the source component is uninstalled", async () => {
    const record = agentComponent({ id: "wasLive", name: "Was Live" });
    const fake = makeFakeClient({
      artifacts: [],
      projects: [],
      loops: [],
      agentComponents: [record],
    });

    // First run indexes the live component.
    const first = await runSearchDocumentBackfill(fake.client);
    expect(first.staleAgentComponentsRemoved).toBe(0);
    expect(
      fake.store.has(`${ORG_A}|${SearchEntityType.AgentComponent}|wasLive`)
    ).toBe(true);

    // The component is uninstalled between runs. The upsert path no longer
    // touches it (filtered by uninstalledAt), so only the anti-join cleanup can
    // prune the now-stale projection row it left behind.
    record.uninstalledAt = AT;

    const second = await runSearchDocumentBackfill(fake.client);
    expect(second.staleAgentComponentsRemoved).toBe(1);
    expect(
      fake.store.has(`${ORG_A}|${SearchEntityType.AgentComponent}|wasLive`)
    ).toBe(false);
  });

  it("paginates the component source until exhausted (no capped first page)", async () => {
    const components = Array.from({ length: 5 }, (_, i) =>
      agentComponent({ id: `ac${i}`, externalComponentId: `ext-${i}` })
    );
    const fake = makeFakeClient({
      artifacts: [],
      projects: [],
      loops: [],
      agentComponents: components,
    });

    const counts = await runSearchDocumentBackfill(fake.client, {
      pageSize: 2,
    });

    expect(counts.agentComponents).toBe(5);
    expect(fake.store.size).toBe(5);
  });
});
