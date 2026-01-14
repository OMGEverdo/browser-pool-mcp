#!/usr/bin/env node
/**
 * Dynamic Browser Pool MCP Server
 *
 * Uses MCP SDK client to properly communicate with Playwright MCP instances.
 */

const { spawn } = require('child_process');
const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { SSEClientTransport } = require('@modelcontextprotocol/sdk/client/sse.js');
const { z } = require('zod');
const fs = require('fs');
const net = require('net');
const path = require('path');

// Debug logging - writes to debug.log in same directory as script
const LOG_FILE = path.join(__dirname, 'debug.log');
const DEBUG = process.env.BROWSER_POOL_DEBUG === '1';

function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}\n`;
  if (DEBUG) {
    fs.appendFileSync(LOG_FILE, line);
  }
  console.error(msg);
}

// Configuration
const BASE_PORT = 9000;
const MAX_INSTANCES = 10;
const INSTANCE_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes

// Track running instances: port -> { process, client, lastUsed, sessionId }
const instances = new Map();
let nextPort = BASE_PORT;

// Generate unique session ID
const sessionId = `session-${Date.now()}-${Math.random().toString(36).slice(2)}`;
let assignedPort = null;
let assignedClient = null;

/**
 * Wait for server to be ready
 */
function waitForServer(port, timeout = 45000) {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const http = require('http');

    const check = () => {
      const req = http.request({
        hostname: 'localhost',
        port,
        path: '/sse',
        method: 'GET',
        timeout: 2000
      }, (res) => {
        res.destroy();
        resolve();
      });

      req.on('error', () => {
        if (Date.now() - start > timeout) {
          reject(new Error(`Timeout waiting for server on port ${port}`));
        } else {
          setTimeout(check, 1000);
        }
      });

      req.end();
    };

    // Wait for npx to download and start
    setTimeout(check, 3000);
  });
}

/**
 * Create MCP client connected to a Playwright instance
 */
async function createMcpClient(port) {
  const transport = new SSEClientTransport(new URL(`http://localhost:${port}/sse`));
  const client = new Client({ name: 'browser-pool', version: '1.0.0' });
  await client.connect(transport);
  return client;
}

/**
 * Check if a port is already in use
 */
function isPortInUse(port) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once('error', () => resolve(true));
    server.once('listening', () => {
      server.close();
      resolve(false);
    });
    server.listen(port, '127.0.0.1');
  });
}

/**
 * Get or create a browser instance
 */
async function getOrCreateInstance() {
  // Return existing if we have one
  if (assignedClient && assignedPort) {
    const instance = instances.get(assignedPort);
    if (instance) {
      instance.lastUsed = Date.now();
      return { port: assignedPort, client: assignedClient };
    }
  }

  // Check capacity
  if (instances.size >= MAX_INSTANCES) {
    let oldestPort = null;
    let oldestTime = Infinity;
    for (const [port, inst] of instances) {
      if (inst.lastUsed < oldestTime) {
        oldestTime = inst.lastUsed;
        oldestPort = port;
      }
    }
    if (oldestPort) {
      await killInstance(oldestPort);
    }
  }

  // Find available port (check both local map and actual port availability)
  let port = nextPort;
  let attempts = 0;
  while (attempts < 100) {
    if (!instances.has(port) && !(await isPortInUse(port))) {
      break;
    }
    port++;
    if (port > BASE_PORT + 100) port = BASE_PORT;
    attempts++;
  }
  if (attempts >= 100) {
    throw new Error('No available ports in range 9000-9100');
  }
  nextPort = port + 1;

  log(`[browser-pool] Spawning Playwright on port ${port}...`);

  // Spawn Playwright MCP
  const proc = spawn('npx', ['@playwright/mcp@latest', '--port', String(port), '--isolated'], {
    stdio: ['pipe', 'pipe', 'pipe'],
    shell: true,
    windowsHide: false
  });

  proc.stdout.on('data', d => console.error(`[pw:${port}:out] ${d.toString().trim()}`));
  proc.stderr.on('data', d => console.error(`[pw:${port}:err] ${d.toString().trim()}`));
  proc.on('exit', code => {
    console.error(`[browser-pool] Port ${port} exited (code ${code})`);
    instances.delete(port);
    if (assignedPort === port) {
      assignedPort = null;
      assignedClient = null;
    }
  });

  // Wait for server
  await waitForServer(port);
  console.error(`[browser-pool] Server ready on port ${port}`);

  // Create MCP client
  const client = await createMcpClient(port);
  console.error(`[browser-pool] MCP client connected to port ${port}`);

  instances.set(port, {
    process: proc,
    client,
    lastUsed: Date.now(),
    sessionId
  });

  assignedPort = port;
  assignedClient = client;

  return { port, client };
}

/**
 * Kill an instance
 */
async function killInstance(port) {
  const instance = instances.get(port);
  if (instance) {
    console.error(`[browser-pool] Killing port ${port}`);
    try {
      await instance.client.close();
    } catch (e) { }
    instance.process.kill();
    instances.delete(port);
  }
}

/**
 * Proxy tool call to Playwright
 */
async function proxyToolCall(toolName, args) {
  log(`[proxyToolCall] ${toolName} with args: ${JSON.stringify(args)}`);
  const { client } = await getOrCreateInstance();
  log(`[proxyToolCall] got client for port ${assignedPort}`);

  // Update last used
  if (assignedPort && instances.has(assignedPort)) {
    instances.get(assignedPort).lastUsed = Date.now();
  }

  try {
    log(`[proxyToolCall] Calling client.callTool...`);
    const result = await client.callTool({ name: toolName, arguments: args || {} });
    log(`[proxyToolCall] Result type: ${typeof result}`);
    log(`[proxyToolCall] Result: ${JSON.stringify(result).slice(0, 500)}`);

    // The SDK returns { content: [...], isError?: boolean }
    // We need to return this same format
    if (result && result.content) {
      return result;
    }

    // Fallback: wrap in content array if needed
    return {
      content: [{ type: 'text', text: JSON.stringify(result) }]
    };
  } catch (error) {
    log(`[proxyToolCall] ERROR: ${error.message}\n${error.stack}`);
    return {
      content: [{ type: 'text', text: `Error: ${error.message}` }],
      isError: true
    };
  }
}

/**
 * Handle pool_status specially
 */
function getPoolStatus() {
  const status = [];
  for (const [port, inst] of instances) {
    status.push({
      port,
      sessionId: inst.sessionId,
      idleMinutes: Math.round((Date.now() - inst.lastUsed) / 60000)
    });
  }
  return {
    content: [{
      type: 'text',
      text: JSON.stringify({
        instances: status,
        maxInstances: MAX_INSTANCES,
        thisSession: sessionId,
        assignedPort
      }, null, 2)
    }]
  };
}

// Cleanup timer
setInterval(() => {
  const now = Date.now();
  for (const [port, inst] of instances) {
    if (now - inst.lastUsed > INSTANCE_TIMEOUT_MS) {
      console.error(`[browser-pool] Port ${port} timed out`);
      killInstance(port);
    }
  }
}, 60000);

/**
 * Main
 */
async function main() {
  const server = new McpServer({ name: 'browser-pool', version: '1.0.0' });

  // Register tools - proxy to Playwright
  server.tool('browser_navigate', 'Navigate to URL', { url: z.string() },
    async (args, extra) => {
      log(`[browser_navigate] called with args: ${JSON.stringify(args)}`);
      try {
        const result = await proxyToolCall('browser_navigate', args);
        log(`[browser_navigate] result: ${JSON.stringify(result).slice(0, 500)}`);
        return result;
      } catch (err) {
        log(`[browser_navigate] ERROR: ${err.message}\n${err.stack}`);
        throw err;
      }
    });

  server.tool('browser_snapshot', 'Page snapshot', {},
    async () => {
      log(`[browser_snapshot] called`);
      try {
        const result = await proxyToolCall('browser_snapshot', {});
        log(`[browser_snapshot] result: ${JSON.stringify(result).slice(0, 500)}`);
        return result;
      } catch (err) {
        log(`[browser_snapshot] ERROR: ${err.message}\n${err.stack}`);
        throw err;
      }
    });

  server.tool('browser_click', 'Click element', {
    element: z.string(),
    ref: z.string()
  }, async (args) => proxyToolCall('browser_click', args));

  server.tool('browser_type', 'Type text', {
    element: z.string(),
    ref: z.string(),
    text: z.string(),
    submit: z.boolean().optional()
  }, async (args) => proxyToolCall('browser_type', args));

  server.tool('browser_screenshot', 'Take screenshot', {
    fullPage: z.boolean().optional()
  }, async (args) => proxyToolCall('browser_screenshot', args));

  server.tool('browser_close', 'Close browser', {},
    async (args) => proxyToolCall('browser_close', args));

  server.tool('browser_tabs', 'Manage tabs', {
    action: z.enum(['list', 'new', 'close', 'select']),
    index: z.number().optional()
  }, async (args) => proxyToolCall('browser_tabs', args));

  server.tool('browser_navigate_back', 'Go back', {},
    async (args) => proxyToolCall('browser_navigate_back', args));

  server.tool('browser_press_key', 'Press key', { key: z.string() },
    async (args) => proxyToolCall('browser_press_key', args));

  server.tool('browser_hover', 'Hover element', {
    element: z.string(),
    ref: z.string()
  }, async (args) => proxyToolCall('browser_hover', args));

  server.tool('browser_select_option', 'Select option', {
    element: z.string(),
    ref: z.string(),
    values: z.array(z.string())
  }, async (args) => proxyToolCall('browser_select_option', args));

  server.tool('browser_evaluate', 'Run JavaScript', { function: z.string() },
    async (args) => proxyToolCall('browser_evaluate', args));

  server.tool('browser_wait_for', 'Wait for condition', {
    time: z.number().optional(),
    text: z.string().optional(),
    textGone: z.string().optional()
  }, async (args) => proxyToolCall('browser_wait_for', args));

  server.tool('browser_resize', 'Resize window', {
    width: z.number(),
    height: z.number()
  }, async (args) => proxyToolCall('browser_resize', args));

  server.tool('browser_handle_dialog', 'Handle dialog', {
    accept: z.boolean(),
    promptText: z.string().optional()
  }, async (args) => proxyToolCall('browser_handle_dialog', args));

  server.tool('browser_file_upload', 'Upload files', {
    paths: z.array(z.string()).optional()
  }, async (args) => proxyToolCall('browser_file_upload', args));

  server.tool('browser_console_messages', 'Get console', {
    level: z.string().optional()
  }, async (args) => proxyToolCall('browser_console_messages', args));

  server.tool('browser_network_requests', 'Get network requests', {},
    async (args) => proxyToolCall('browser_network_requests', args));

  server.tool('pool_status', 'Browser pool status', {},
    async () => getPoolStatus());

  // Debug tool to test if async proxy works
  server.tool('pool_test', 'Test async response', { message: z.string() },
    async (args) => {
      log(`[pool_test] called with: ${JSON.stringify(args)}`);
      // Simulate async operation
      await new Promise(r => setTimeout(r, 100));
      const response = {
        content: [{
          type: 'text',
          text: `Received: ${args.message}`
        }]
      };
      log(`[pool_test] returning: ${JSON.stringify(response)}`);
      return response;
    });

  // Cleanup handlers
  const cleanup = () => {
    console.error('[browser-pool] Shutting down...');
    for (const [port] of instances) {
      killInstance(port);
    }
    process.exit(0);
  };
  process.on('SIGINT', cleanup);
  process.on('SIGTERM', cleanup);

  // Start
  const transport = new StdioServerTransport();
  await server.connect(transport);
  log('[browser-pool] Started');
  log(`[browser-pool] Session: ${sessionId}`);
}

main().catch(err => {
  console.error('[browser-pool] Fatal:', err);
  process.exit(1);
});
