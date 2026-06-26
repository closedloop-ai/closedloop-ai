# Loop Orchestration Guidelines

- Context-pack and loop orchestration code must use domain services for document and pull-request metadata lookups instead of calling `withDb` directly.
- Best-effort metadata lookups that enrich context packs must catch lookup failures, log a warning with loop/document context, and degrade to an omitted or null metadata value instead of failing the loop.
- Loop and context-pack tests must use shared contract constants for commands and artifact/document types: `LoopCommand`, `LoopArtifactType`, and `DocumentType`. Do not add raw fixture strings such as `"EVALUATE_CODE"`, `"EVALUATE_PRD"`, `"PRD"`, `"FEATURE"`, or `"IMPLEMENTATION_PLAN"` when those constants are available.
- Loop failure helpers that persist desktop-, relay-, or runner-provided error text in `Loop.error` or loop events must trim the message, enforce a bounded maximum length, and use a stable fallback when the source text is absent or blank.
