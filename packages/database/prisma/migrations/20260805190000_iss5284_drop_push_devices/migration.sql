-- Drop the mobile push-device registry.
--
-- `apps/mobile` was deleted wholesale (ISS-5284), and an Expo push token could
-- only ever be minted by that client — nothing else registers one, and with no
-- device to deliver to the notification dispatch had no receiver. The routes
-- (`/me/push-devices`), the Expo transport, and the dispatch call sites went
-- with it, so this table has no writer and no reader left.
--
-- Destructive by intent: the rows are Expo push tokens for an app that no
-- longer exists. They cannot be re-used by any surviving client and there is no
-- migration path that would want them back.

-- DropForeignKey
ALTER TABLE "push_devices" DROP CONSTRAINT "push_devices_organization_id_fkey";

-- DropForeignKey
ALTER TABLE "push_devices" DROP CONSTRAINT "push_devices_user_id_fkey";

-- DropTable
DROP TABLE "push_devices";
