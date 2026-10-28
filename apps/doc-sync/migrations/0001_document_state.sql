-- One row per Hocuspocus document. `name` is the document name: the
-- canonical room id generateDocumentRoomId(orgId, slug), enforced at connect
-- by ISS-12502. `state` is the merged Yjs update (PLN-2185 T-2.1).
CREATE TABLE document_state (
  name text PRIMARY KEY,
  state bytea NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
