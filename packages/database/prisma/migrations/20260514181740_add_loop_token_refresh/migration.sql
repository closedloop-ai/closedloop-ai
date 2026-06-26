-- CreateTable
CREATE TABLE "loop_token_refresh" (
    "id" UUID NOT NULL,
    "loop_id" UUID NOT NULL,
    "jti" TEXT NOT NULL,
    "refreshed_at" TIMESTAMP(3) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "loop_token_refresh_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "loop_token_refresh_jti_key" ON "loop_token_refresh"("jti");

-- CreateIndex
CREATE INDEX "loop_token_refresh_loop_id_idx" ON "loop_token_refresh"("loop_id");

-- AddForeignKey
ALTER TABLE "loop_token_refresh" ADD CONSTRAINT "loop_token_refresh_loop_id_fkey" FOREIGN KEY ("loop_id") REFERENCES "loops"("id") ON DELETE CASCADE ON UPDATE CASCADE;
