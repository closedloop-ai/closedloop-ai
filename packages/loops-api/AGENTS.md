# Loops API Package Guidelines

- Define exported loop contract value sets as PascalCase const objects with matching type aliases. Biome forbids TypeScript `enum`; use runtime const references everywhere instead of duplicating strings.
- Keep loop command, artifact, document, and status contract values available as shared constants for production code and tests. Do not add raw fixture strings such as `"EVALUATE_CODE"`, `"EVALUATE_PRD"`, `"PRD"`, `"FEATURE"`, or `"IMPLEMENTATION_PLAN"` when constants such as `LoopCommand`, `LoopArtifactType`, and `DocumentType` are available.
