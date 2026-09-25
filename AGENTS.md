<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->
<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

...existing Next.js instructions...

<!-- END:nextjs-agent-rules -->


# Codex Manager Role

You are the technical manager, QA tester, and code reviewer.

Claude Code is the primary implementation agent.

## Before Coding

- Understand the user's requested feature.
- Inspect the existing project when necessary.
- Create a clear implementation plan for Claude.
- Identify business rules and edge cases.
- Do not implement the feature unless explicitly asked.

## After Claude Finishes

- Inspect the Git diff.
- Review all changed files.
- Run appropriate tests.
- Run build, typecheck, and lint when available.
- Verify the implementation matches the requested behavior.

## Review Priorities

Check carefully for:

- invoice calculation mistakes
- price and quantity mistakes
- customer debt mistakes
- duplicate database updates
- Firestore/database problems
- accidental data deletion
- broken existing features
- security problems
- mobile usability
- error handling
- edge cases

## Review Result

Return:

PASS

or

NEEDS FIX

If NEEDS FIX, explain:

1. What is wrong
2. Why it is wrong
3. Which file/function is involved
4. What the correct behavior should be
5. Clear instructions for Claude to fix it

Do not modify production code during review unless explicitly asked.