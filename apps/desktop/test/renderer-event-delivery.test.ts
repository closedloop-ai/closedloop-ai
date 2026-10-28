import { describe, expect, it } from "vitest";
import {
  attemptRendererDelivery,
  completeRendererNavigationReady,
  prepareRendererRouteOpen,
  RendererEventDelivery,
} from "../src/main/lifecycle/renderer-event-delivery.js";
import { DesktopRendererEventChannel } from "../src/shared/desktop-renderer-event-channel.js";

describe("RendererEventDelivery", () => {
  it("replays snapshots for each generation and keeps the latest value", () => {
    const delivery = new RendererEventDelivery();
    delivery.record(DesktopRendererEventChannel.DistributionsOptInAvailable, [
      ["first"],
    ]);
    delivery.record(DesktopRendererEventChannel.DistributionsOptInAvailable, [
      ["current"],
    ]);

    expect(delivery.markReady()).toEqual([
      {
        channel: DesktopRendererEventChannel.DistributionsOptInAvailable,
        args: [["current"]],
      },
    ]);
    delivery.startGeneration();
    expect(delivery.markReady()).toEqual([
      {
        channel: DesktopRendererEventChannel.DistributionsOptInAvailable,
        args: [["current"]],
      },
    ]);
    expect(delivery.markReady()).toBeNull();
  });

  it("drops a handled snapshot before a replacement renderer can replay it", () => {
    const delivery = new RendererEventDelivery();
    delivery.record(DesktopRendererEventChannel.DistributionsOptInAvailable, [
      ["handled"],
    ]);

    delivery.clearSnapshot(
      DesktopRendererEventChannel.DistributionsOptInAvailable
    );

    expect(delivery.markReady()).toEqual([]);
  });

  it("bounds discrete intents to one latest value and consumes them", () => {
    const delivery = new RendererEventDelivery();
    delivery.record(DesktopRendererEventChannel.NavigateTab, ["approvals"]);
    delivery.record(DesktopRendererEventChannel.NavigateTab, ["sessions"]);

    expect(delivery.markReady()).toEqual([
      {
        channel: DesktopRendererEventChannel.NavigateTab,
        args: ["sessions"],
      },
    ]);
    delivery.startGeneration();
    expect(delivery.markReady()).toEqual([]);
  });

  it("requeues a last-wins intent when its guarded send fails", () => {
    const delivery = new RendererEventDelivery();
    expect(delivery.markReady()).toEqual([]);
    const attempted = delivery.record(DesktopRendererEventChannel.NavigateTab, [
      "approvals",
    ]);
    expect(attempted).not.toBeNull();
    if (attempted) {
      delivery.deliveryFailed(attempted);
    }

    delivery.startGeneration();
    expect(delivery.markReady()).toEqual([
      {
        channel: DesktopRendererEventChannel.NavigateTab,
        args: ["approvals"],
      },
    ]);
  });

  it("requeues a route when its readiness flush races frame disposal", () => {
    const owner = new RendererEventDelivery();
    owner.record(DesktopRendererEventChannel.NavigateTab, ["approvals"]);
    const [flushed] = owner.markReady() ?? [];

    expect(flushed).toBeDefined();
    if (flushed) {
      expect(attemptRendererDelivery(owner, flushed, () => false)).toBe(false);
    }
    owner.startGeneration();
    expect(owner.markReady()).toEqual([
      {
        channel: DesktopRendererEventChannel.NavigateTab,
        args: ["approvals"],
      },
    ]);
  });

  it("lets a fresh initial hash supersede a queued route from an older generation", () => {
    const delivery = new RendererEventDelivery();
    delivery.record(DesktopRendererEventChannel.NavigateTab, ["approvals"]);

    expect(prepareRendererRouteOpen(delivery, false, "sessions")).toEqual({
      initialHash: "#/sessions",
      queuedRoute: null,
    });
    expect(delivery.markReady()).toEqual([]);
  });

  it("republishes owner state for every navigation-ready mount", () => {
    const delivery = new RendererEventDelivery();
    const delivered: string[] = [];
    let publications = 0;
    delivery.record(DesktopRendererEventChannel.DistributionsOptInAvailable, [
      ["current"],
    ]);

    const markNavigationReady = () => {
      completeRendererNavigationReady(
        delivery,
        (event) => delivered.push(event.channel),
        () => {
          publications += 1;
        }
      );
    };
    markNavigationReady();
    markNavigationReady();

    expect(delivered).toEqual([
      DesktopRendererEventChannel.DistributionsOptInAvailable,
    ]);
    expect(publications).toBe(2);
  });

  it("sends transient events only while a renderer is ready", () => {
    const delivery = new RendererEventDelivery();

    expect(
      delivery.record(DesktopRendererEventChannel.AuthStateChanged, [
        { status: "signed_out" },
      ])
    ).toBeNull();
    expect(
      delivery.record(DesktopRendererEventChannel.Realtime, [{ sequence: 1 }])
    ).toBeNull();
    expect(
      delivery.record(DesktopRendererEventChannel.PackInstallOutput, ["line"])
    ).toBeNull();
    expect(delivery.markReady()).toEqual([]);
    expect(
      delivery.record(DesktopRendererEventChannel.Realtime, [{ sequence: 2 }])
    ).toEqual({
      channel: DesktopRendererEventChannel.Realtime,
      args: [{ sequence: 2 }],
    });
    expect(
      delivery.record(DesktopRendererEventChannel.AuthStateChanged, [
        { status: "signed_out" },
      ])
    ).toEqual({
      channel: DesktopRendererEventChannel.AuthStateChanged,
      args: [{ status: "signed_out" }],
    });
    expect(delivery.record("desktop:unknown", ["value"])).toEqual({
      channel: "desktop:unknown",
      args: ["value"],
    });
    delivery.startGeneration();
    expect(delivery.record("desktop:unknown", ["new-value"])).toBeNull();
  });
});
