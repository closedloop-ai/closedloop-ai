-- AddForeignKey (idempotent: constraint already created by prior migration)
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_namespace n ON n.oid = c.connamespace
    WHERE c.conname = 'file_attachments_issue_id_fkey'
      AND n.nspname = current_schema()
  ) THEN
    ALTER TABLE "file_attachments" ADD CONSTRAINT "file_attachments_issue_id_fkey" FOREIGN KEY ("issue_id") REFERENCES "issues"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;
