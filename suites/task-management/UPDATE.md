# Task Management Suite — Update Check Instructions

## Dependencies to Monitor

### TickTick API (via MCP Server)
- **MCP Package**: `@alexarevalo.ai/mcp-server-ticktick`
- **Check**: `npm outdated @alexarevalo.ai/mcp-server-ticktick`
- **API Docs**: https://developer.ticktick.com/api
- **Impact**: Endpoint changes, authentication flow, task field additions

### TickTick API Token
- **Token location**: Environment variables / integrations config
- **Expiry**: Tokens may expire — check if refresh is needed
- **Verify**: Test with a simple task list fetch

## What to Verify
- TickTick sync completing successfully (check logs for sync errors)
- Task creation/update round-trip working
- Template expansion handling edge cases
- Autonomous manager not creating duplicate tasks
