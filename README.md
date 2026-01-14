# browser-pool-mcp

A dynamic browser pool MCP server that wraps [@playwright/mcp](https://github.com/microsoft/playwright-mcp) to enable **multiple concurrent browser sessions** for Claude Code and other MCP clients.

## Problem Solved

The standard Playwright MCP server only allows one browser instance at a time. If you try to use browser tools from multiple Claude Code sessions simultaneously, you get:

```
Browser is already in use for C:\Users\...\mcp-chrome-xxx, use --isolated to run multiple instances
```

**browser-pool-mcp** solves this by:
- Spawning Playwright MCP instances on-demand on dynamic ports (9000+)
- Automatically detecting port conflicts from other sessions
- Assigning each Claude session to its own isolated browser
- Auto-cleanup of idle instances after 30 minutes

## Architecture

```
Claude Code Session 1 ──stdio──> browser-pool-mcp ──SSE──> Playwright MCP (port 9000)
Claude Code Session 2 ──stdio──> browser-pool-mcp ──SSE──> Playwright MCP (port 9001)
Claude Code Session 3 ──stdio──> browser-pool-mcp ──SSE──> Playwright MCP (port 9002)
```

Each Claude Code session gets its own browser-pool-mcp process, which spawns and connects to an isolated Playwright instance on an available port.

## Installation

### Prerequisites

- Node.js 18+
- npm

### Setup

1. Clone or download this repository:
```bash
git clone https://github.com/everdijsje/browser-pool-mcp.git
cd browser-pool-mcp
npm install
```

2. Add to your Claude Code MCP configuration (`~/.claude.json`):
```json
{
  "mcpServers": {
    "browser": {
      "type": "stdio",
      "command": "node",
      "args": ["/path/to/browser-pool-mcp/index.js"]
    }
  }
}
```

3. Restart Claude Code

## Usage

Use browser tools as normal in Claude Code:

```
Navigate to https://example.com
Take a screenshot
Click on the "Learn more" link
```

### Additional Tools

- `pool_status` - Check the status of running browser instances
- `pool_test` - Debug tool to test async responses

## Configuration

Environment variables:

| Variable | Default | Description |
|----------|---------|-------------|
| `BROWSER_POOL_DEBUG` | `0` | Set to `1` to enable debug logging to `debug.log` |

Constants in `index.js`:

| Constant | Default | Description |
|----------|---------|-------------|
| `BASE_PORT` | `9000` | Starting port for Playwright instances |
| `MAX_INSTANCES` | `10` | Maximum concurrent browser instances |
| `INSTANCE_TIMEOUT_MS` | `1800000` | Idle timeout before killing instance (30 min) |

## How It Works

1. When you call any browser tool (e.g., `browser_navigate`), browser-pool-mcp:
   - Checks if this session already has an assigned Playwright instance
   - If not, finds an available port (checking for conflicts)
   - Spawns `npx @playwright/mcp@latest --port PORT --isolated`
   - Connects via MCP SDK client over SSE
   - Proxies the tool call to Playwright

2. Each session is assigned one browser instance for its lifetime
3. Instances are cleaned up after 30 minutes of inactivity
4. When max instances are reached, the oldest idle instance is recycled

## Supported Browser Tools

All standard Playwright MCP tools are proxied:

- `browser_navigate` - Navigate to URL
- `browser_snapshot` - Get page accessibility snapshot
- `browser_click` - Click element
- `browser_type` - Type text into element
- `browser_screenshot` - Take screenshot
- `browser_tabs` - Manage browser tabs
- `browser_press_key` - Press keyboard key
- `browser_hover` - Hover over element
- `browser_select_option` - Select dropdown option
- `browser_evaluate` - Run JavaScript
- `browser_wait_for` - Wait for condition
- `browser_resize` - Resize browser window
- `browser_handle_dialog` - Handle alerts/confirms
- `browser_file_upload` - Upload files
- `browser_console_messages` - Get console logs
- `browser_network_requests` - Get network activity
- `browser_navigate_back` - Go back
- `browser_close` - Close browser

## Dependencies

- `@modelcontextprotocol/sdk` - MCP SDK for server and client communication
- `zod` - Schema validation
- `@playwright/mcp` - Spawned as child processes (installed via npx)

## License

MIT

## Author

Built by Claude Code for [Everdijs](https://github.com/everdijsje)
