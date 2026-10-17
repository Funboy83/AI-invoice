# Contributing

## Every new feature ships with its MCP tools

The owner runs the store from Claude and other AI apps through the API/MCP server (`/api/mcp`, `/api/v1/tools`), and expects them to be able to do **everything the app can do**. So a change that lets people do something new in the app is not finished until outside AI apps can do it too:

1. Add the tool(s): reads in `src/lib/server/adminTools.ts` (or reuse a chat tool from `src/lib/ai/tools.ts`), and list it in `src/lib/server/externalApi.ts`.
2. Writes go through **preview → `confirmAction`**: with `previewOnly` the tool checks everything, returns what would change (money before/after, stock, warnings) and `pinnedArgs`, and writes nothing. The confirmed call must use the **same store function the app's page uses**, so the app's rules (totals, no overpaying, duplicates, stock, idempotency) apply once, in one place.
3. No permanent deletes unless the app itself has one.
4. Add a test in `src/lib/server/externalApi.admin.test.ts` (preview writes nothing; confirm saves exactly once) and add the tool to the list test in `externalApi.test.ts`.
5. Update the plain-language MCP guide for the owner.

Before pushing: `npm test`, `npm run lint`, `npm run build`.
