"use client";

import { DeviceDataPolicy } from "@repo/app/shared/components/device-data-policy";
import {
  DEVICE_DATA_POLICY_PLACEHOLDER_COPY,
  FIXTURE_DEVICES,
  FIXTURE_ORG_NAME,
} from "@repo/app/shared/components/device-data-policy-fixtures";

// A production-bound route renders only its portable surface inside the
// route-owned `main` landmark, so each device's card styling travels through
// the surface's own `className` rather than a local list wrapper.
export default function DataControlsDevicePolicyWebPage() {
  return (
    <main className="mx-auto flex max-w-2xl flex-col gap-2 p-4 md:p-8">
      {FIXTURE_DEVICES.map((device) => (
        <DeviceDataPolicy
          className="rounded-lg border p-3"
          copy={DEVICE_DATA_POLICY_PLACEHOLDER_COPY}
          key={device.id}
          machineName={device.machineName}
          orgName={FIXTURE_ORG_NAME}
          policy={device.policy}
        />
      ))}
    </main>
  );
}
