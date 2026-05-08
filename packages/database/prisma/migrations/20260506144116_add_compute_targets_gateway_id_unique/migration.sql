CREATE UNIQUE INDEX "compute_targets_gateway_id_unique_idx"
  ON "compute_targets" ("gateway_id")
  WHERE "gateway_id" IS NOT NULL;
