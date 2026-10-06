# Project instructions

## Working style

- Inspect the existing implementation before making changes.
- Preserve existing working behavior unless the task explicitly requires changing it.
- Make the smallest reasonable change that implements the requested behavior.
- Do not refactor, rename, reorganize, reformat, or "clean up" unrelated code.
- Do not modify unrelated files.
- Do not introduce new libraries, frameworks, architectural patterns, or abstractions unless explicitly requested.
- Prefer the project's existing patterns and conventions.

## Scope

When implementing a task:

1. Determine which files are actually relevant.
2. Read those files before editing them.
3. Modify only what is necessary for the requested feature.
4. Leave unrelated code untouched.

If something outside the requested scope appears incorrect, do not fix it automatically. Mention it after completing the requested work.

## Existing architecture

Treat the existing architecture as intentional unless the task explicitly asks for an architectural change.

Do not replace working implementations merely because another approach appears cleaner.

## Database and API

- Supabase/PostgreSQL is the source of truth for persistent application data.
- Do not duplicate canonical database data into local JSON files unless explicitly requested.
- Preserve existing API contracts unless the task explicitly changes them.
- Do not create or modify database tables, constraints, migrations, or production data unless explicitly requested.

## Frontend

- The current frontend uses plain HTML, CSS, and JavaScript.
- Do not introduce React, Vue, TypeScript, bundlers, or other frontend frameworks unless explicitly requested.
- The frontend should communicate with the backend API rather than accessing Supabase directly.

## Implementation

Before editing, understand the current data flow and reuse existing functions/routes where appropriate.

Do not create duplicate helpers, routes, schemas, or components when an existing implementation can be extended safely.

## Testing

After making changes:

- Check the files you modified for syntax errors.
- Run existing relevant tests/checks when available.
- Do not change unrelated code merely to make unrelated tests pass.
- Report what was changed and any checks that were run.

## User-approved design

When the task says that a design or plan has already been approved, implement that design rather than redesigning the feature.

If the approved design conflicts with the current repository in a way that makes implementation unsafe or impossible, stop and explain the conflict instead of inventing a different architecture.