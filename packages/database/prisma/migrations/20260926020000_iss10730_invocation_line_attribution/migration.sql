-- ISS-10730 — per-invocation LINE attribution (cloud half).
--
-- Mirrors the desktop migration of the same name. Additive and nullable with no
-- default, so an ingest that carries no line attribution persists NULL ("not
-- computed") and `toSyncItem` maps that back to an OMITTED key rather than an
-- explicit null — keeping an older Desktop build byte-identical on the wire and
-- its generation hash reconcilable.

ALTER TABLE "agent_component_invocations" ADD COLUMN "lines_added" integer;
ALTER TABLE "agent_component_invocations" ADD COLUMN "lines_removed" integer;
