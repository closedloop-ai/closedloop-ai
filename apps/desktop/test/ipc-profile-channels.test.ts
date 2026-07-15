import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  PROFILE_CONFIG_IPC_CHANNELS,
  ProfileConfigIpcChannel,
  registerProfileConfigIpcHandlers,
} from "../src/main/profile-config-ipc.js";
import { createProfileConfigDesktopApi } from "../src/main/profile-config-preload.js";

type IpcHandler = (event: unknown, payload?: unknown) => unknown;

const UNTRUSTED_SENDER_ERROR = /untrusted sender/;

function makeProfileRegistrarHandlers(
  isTrustedSender: (sender: unknown) => boolean = () => true
): Map<string, IpcHandler> {
  const handlers = new Map<string, IpcHandler>();
  const savedConfig = {
    id: "profile-1",
    name: "Production",
    relayOrigin: "https://relay.example.test",
    apiOrigin: "https://api.example.test",
    webAppOrigin: "https://app.example.test",
  };
  registerProfileConfigIpcHandlers(
    {
      handle: (channel, listener) => {
        handlers.set(channel, listener);
      },
    },
    {
      isTrustedSender,
      settingsStore: {
        findConfigByOrigins: () => savedConfig,
        getRelayOrigin: () => savedConfig.relayOrigin,
        getApiOrigin: () => savedConfig.apiOrigin,
        getWebAppOrigin: () => savedConfig.webAppOrigin,
        getActiveConfigId: () => null,
        saveConfig: () => savedConfig,
        updateConfigConnection: () => savedConfig,
        updateConfigManagedMetadata: () => savedConfig,
        setActiveConfigId: () => {},
        applyConfig: () => savedConfig,
        listConfigs: () => [savedConfig],
        deleteConfig: () => ({ wasActive: false }),
        renameConfig: () => {},
        ensureConfigGatewayId: () => ({
          ...savedConfig,
          gatewayId: "gateway-1",
        }),
      },
      apiKeyStore: {
        getStatus: () => ({ source: "none" }),
        getApiKey: () => null,
        getApiKeyProvenance: () => null,
        saveProfileKey: () => {},
        getProfileKey: () => null,
        getProfileKeyRecord: () => null,
        setApiKey: () => {},
        clearApiKey: () => {},
        deleteProfileKey: () => {},
      },
      getGatewaySnapshot: () => ({
        gatewayPort: null,
        computeTarget: null,
      }),
      cancelManagedOnboardingForUserChange: () => {},
      onActiveConfigDeleted: () => {},
      onConfigDeleted: () => {},
      restartCloudSocket: () => {},
      isEncryptionAvailable: () => true,
    } as Parameters<typeof registerProfileConfigIpcHandlers>[1]
  );
  return handlers;
}

describe("profile config IPC registrar", () => {
  test("registers the expected profile handlers", () => {
    const handlers = makeProfileRegistrarHandlers();

    assert.deepEqual(
      [...handlers.keys()].sort(),
      [...PROFILE_CONFIG_IPC_CHANNELS].sort()
    );
  });

  test("registered profile handlers are callable", async () => {
    const handlers = makeProfileRegistrarHandlers();
    const findResult = handlers.get(
      ProfileConfigIpcChannel.FindMatchingConfig
    )?.(null);
    const configs = handlers.get(ProfileConfigIpcChannel.ListConfigs)?.(
      null
    ) as Array<{
      apiOrigin: string;
      hasCloudApiKey: boolean;
      id: string;
      name: string;
      relayOrigin: string;
      webAppOrigin: string;
    }>;
    const saved = handlers.get(ProfileConfigIpcChannel.SaveConfig)?.(null, {
      name: "Production",
    }) as { id: string };
    const applied = (await handlers.get(ProfileConfigIpcChannel.ApplyConfig)?.(
      null,
      {
        id: "profile-1",
      }
    )) as { id: string };

    assert.deepEqual(findResult, {
      apiOrigin: configs[0].apiOrigin,
      id: configs[0].id,
      name: configs[0].name,
      relayOrigin: configs[0].relayOrigin,
      webAppOrigin: configs[0].webAppOrigin,
    });
    assert.deepEqual(
      handlers.get(ProfileConfigIpcChannel.DeleteConfig)?.(null, {
        id: "profile-1",
      }),
      { wasActive: false }
    );
    assert.equal(
      handlers.get(ProfileConfigIpcChannel.RenameConfig)?.(null, {
        id: "profile-1",
        name: "Renamed",
      }),
      undefined
    );
    assert.equal(saved.id, "profile-1");
    assert.equal(applied.id, "profile-1");
  });

  test("mutating handlers reject untrusted senders", async () => {
    const handlers = makeProfileRegistrarHandlers(() => false);
    const trustedSender = {};
    const event = { sender: trustedSender };

    await assert.rejects(
      async () =>
        await handlers.get(ProfileConfigIpcChannel.SaveConfig)?.(event, {
          name: "Production",
          apiKey: "sk_live_evil",
        }),
      UNTRUSTED_SENDER_ERROR
    );
    await assert.rejects(
      async () =>
        await handlers.get(ProfileConfigIpcChannel.ApplyConfig)?.(event, {
          id: "profile-1",
        }),
      UNTRUSTED_SENDER_ERROR
    );
    await assert.rejects(
      async () =>
        await handlers.get(ProfileConfigIpcChannel.DeleteConfig)?.(event, {
          id: "profile-1",
        }),
      UNTRUSTED_SENDER_ERROR
    );
    await assert.rejects(
      async () =>
        await handlers.get(ProfileConfigIpcChannel.RenameConfig)?.(event, {
          id: "profile-1",
          name: "Renamed",
        }),
      UNTRUSTED_SENDER_ERROR
    );
  });
});

describe("profile config preload bridge", () => {
  test("invokes expected channels and payloads", async () => {
    const calls: Array<{ args: unknown[]; channel: string }> = [];
    const desktopApi = createProfileConfigDesktopApi({
      invoke: (channel: string, ...args: unknown[]) => {
        calls.push({ channel, args });
        return Promise.resolve({ channel, args });
      },
    });

    await desktopApi.findMatchingConfig();
    await desktopApi.listConfigs();
    await desktopApi.saveConfig("Production");
    await desktopApi.saveConfig({
      id: "profile-1",
      name: "Staging",
      relayOrigin: "https://relay.staging.test",
      apiOrigin: "https://api.staging.test",
      webAppOrigin: "https://app.staging.test",
      apiKey: "sk_live_staging",
    });
    await desktopApi.deleteConfig("profile-1");
    await desktopApi.renameConfig("profile-1", "Renamed");
    await desktopApi.applyConfig("profile-1");

    assert.deepEqual(calls, [
      { channel: ProfileConfigIpcChannel.FindMatchingConfig, args: [] },
      { channel: ProfileConfigIpcChannel.ListConfigs, args: [] },
      {
        channel: ProfileConfigIpcChannel.SaveConfig,
        args: [{ name: "Production" }],
      },
      {
        channel: ProfileConfigIpcChannel.SaveConfig,
        args: [
          {
            id: "profile-1",
            name: "Staging",
            relayOrigin: "https://relay.staging.test",
            apiOrigin: "https://api.staging.test",
            webAppOrigin: "https://app.staging.test",
            apiKey: "sk_live_staging",
          },
        ],
      },
      {
        channel: ProfileConfigIpcChannel.DeleteConfig,
        args: [{ id: "profile-1" }],
      },
      {
        channel: ProfileConfigIpcChannel.RenameConfig,
        args: [{ id: "profile-1", name: "Renamed" }],
      },
      {
        channel: ProfileConfigIpcChannel.ApplyConfig,
        args: [{ id: "profile-1" }],
      },
    ]);
  });
});
