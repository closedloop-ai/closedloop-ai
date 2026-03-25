-- AddForeignKey
ALTER TABLE "file_attachments" ADD CONSTRAINT "file_attachments_issue_id_fkey" FOREIGN KEY ("issue_id") REFERENCES "issues"("id") ON DELETE CASCADE ON UPDATE CASCADE;
