import { afterEach, describe, expect, it, vi } from "vitest";
import { AppTelemetrySchema } from "../app";
import { PermissionTelemetrySchema } from "../permission";
import { TelemetryAttribute } from "../src/attributes";
import {
  configureTelemetryEmitChannel,
  createEmit,
  emit,
  type TelemetryEmitChannel,
  TelemetryEmitChannelNotConfiguredError,
  TelemetryEmitMetadataKey,
} from "../src/emit";
import { GenAiTelemetrySchema } from "../src/gen-ai";
import { TelemetrySchemaName } from "../src/schema-name";
import { SpanTelemetrySchema } from "../src/span";
import {
  appPayload,
  genAiPayload,
  permissionPayload,
  spanPayload,
  syncPayload,
} from "../src/test-fixtures";
import { SyncTelemetrySchema } from "../sync";

afterEach(() => {
  configureTelemetryEmitChannel(null);
  vi.restoreAllMocks();
});

describe("emit", () => {
  it("uses the configured direct channel with exact event name and metadata", () => {
    const channel = channelFixture();
    const attributes = SpanTelemetrySchema.parse(spanPayload());

    configureTelemetryEmitChannel(channel);
    emit(TelemetrySchemaName.Span, {
      name: "http.request",
      attributes,
    });

    expect(channel.info).toHaveBeenCalledTimes(1);
    expect(channel.info).toHaveBeenCalledWith("http.request", {
      ...attributes,
      [TelemetryEmitMetadataKey.SchemaName]: TelemetrySchemaName.Span,
    });
  });

  it("creates an injected-channel emitter without touching the direct channel", () => {
    const directChannel = channelFixture();
    const injectedChannel = channelFixture();
    const emitWithInjectedChannel = createEmit(injectedChannel);
    const attributes = GenAiTelemetrySchema.parse(genAiPayload());

    configureTelemetryEmitChannel(directChannel);
    emitWithInjectedChannel(TelemetrySchemaName.GenAi, {
      name: "gen_ai.request",
      attributes,
    });

    expect(injectedChannel.info).toHaveBeenCalledTimes(1);
    expect(injectedChannel.info).toHaveBeenCalledWith("gen_ai.request", {
      ...attributes,
      [TelemetryEmitMetadataKey.SchemaName]: TelemetrySchemaName.GenAi,
    });
    expect(directChannel.info).not.toHaveBeenCalled();
  });

  it("emits app schema metadata through injected channels", () => {
    const channel = channelFixture();
    const emitWithInjectedChannel = createEmit(channel);
    const attributes = AppTelemetrySchema.parse(appPayload());

    emitWithInjectedChannel(TelemetrySchemaName.App, {
      name: "app.lifecycle",
      attributes,
    });

    expect(channel.info).toHaveBeenCalledTimes(1);
    expect(channel.info).toHaveBeenCalledWith("app.lifecycle", {
      ...attributes,
      [TelemetryEmitMetadataKey.SchemaName]: TelemetrySchemaName.App,
    });
  });

  it("emits sync schema metadata through injected channels", () => {
    const channel = channelFixture();
    const emitWithInjectedChannel = createEmit(channel);
    const attributes = SyncTelemetrySchema.parse(syncPayload());

    emitWithInjectedChannel(TelemetrySchemaName.Sync, {
      name: "sync.batch",
      attributes,
    });

    expect(channel.info).toHaveBeenCalledTimes(1);
    expect(channel.info).toHaveBeenCalledWith("sync.batch", {
      ...attributes,
      [TelemetryEmitMetadataKey.SchemaName]: TelemetrySchemaName.Sync,
    });
  });

  it("emits permission schema metadata through injected channels", () => {
    const channel = channelFixture();
    const emitWithInjectedChannel = createEmit(channel);
    const attributes = PermissionTelemetrySchema.parse(permissionPayload());

    emitWithInjectedChannel(TelemetrySchemaName.Permission, {
      name: "gen_ai.permission",
      attributes,
    });

    expect(channel.info).toHaveBeenCalledTimes(1);
    expect(channel.info).toHaveBeenCalledWith("gen_ai.permission", {
      ...attributes,
      [TelemetryEmitMetadataKey.SchemaName]: TelemetrySchemaName.Permission,
    });
  });

  it("throws before side effects when the direct channel is unconfigured", () => {
    expect(() =>
      emit(TelemetrySchemaName.Span, {
        name: "http.request",
        attributes: SpanTelemetrySchema.parse(spanPayload()),
      })
    ).toThrow(TelemetryEmitChannelNotConfiguredError);
  });

  it("writes the schema marker after attributes so casts cannot override it", () => {
    const channel = channelFixture();
    const emitWithInjectedChannel = createEmit(channel);
    const attributes = {
      ...SpanTelemetrySchema.parse(spanPayload()),
      [TelemetryEmitMetadataKey.SchemaName]: "fake_schema",
    } as ReturnType<typeof SpanTelemetrySchema.parse>;

    emitWithInjectedChannel(TelemetrySchemaName.Span, {
      name: "http.request",
      attributes,
    });

    expect(channel.info).toHaveBeenCalledTimes(1);
    expect(channel.info).toHaveBeenCalledWith(
      "http.request",
      expect.objectContaining({
        [TelemetryEmitMetadataKey.SchemaName]: TelemetrySchemaName.Span,
      })
    );
  });

  it("does not runtime-parse casted payloads", () => {
    const channel = channelFixture();
    const emitWithInjectedChannel = createEmit(channel);
    const attributes = SpanTelemetrySchema.parse(spanPayload());

    Object.assign(attributes, {
      [TelemetryAttribute.DurationMs]: "not-a-number",
    });

    emitWithInjectedChannel(TelemetrySchemaName.Span, {
      name: "http.request",
      attributes,
    });

    expect(channel.info).toHaveBeenCalledTimes(1);
    expect(channel.info).toHaveBeenCalledWith(
      "http.request",
      expect.objectContaining({
        [TelemetryAttribute.DurationMs]: "not-a-number",
      })
    );
  });
});

function channelFixture(): TelemetryEmitChannel {
  return {
    info: vi.fn(),
  };
}
