-- CreateTable
CREATE TABLE "push_devices" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "expo_push_token" TEXT NOT NULL,
    "platform" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "push_devices_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "push_devices_user_id_idx" ON "push_devices"("user_id");

-- CreateIndex
CREATE INDEX "push_devices_organization_id_user_id_idx" ON "push_devices"("organization_id", "user_id");

-- CreateIndex
CREATE UNIQUE INDEX "push_devices_expo_push_token_key" ON "push_devices"("expo_push_token");

-- AddForeignKey
ALTER TABLE "push_devices" ADD CONSTRAINT "push_devices_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "push_devices" ADD CONSTRAINT "push_devices_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
