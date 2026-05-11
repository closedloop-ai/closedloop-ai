-- Add request-mode metadata so relay health-check snapshots cannot mix
-- plugin-auto-update enabled and disabled results.
ALTER TABLE "compute_target_health_checks"
ADD COLUMN "plugin_auto_update_enabled" BOOLEAN NOT NULL DEFAULT false;
