-- ISS-11427: when the cloud's monitored-activity hold on a session started.
-- Additive and nullable: every existing row is NOT HELD until a delivery holds
-- it, which is the safe direction — a null start expires nothing.
ALTER TABLE "session_detail" ADD COLUMN "monitored_activity_held_since" TIMESTAMP(3);
