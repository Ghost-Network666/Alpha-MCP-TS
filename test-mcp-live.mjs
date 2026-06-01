/**
 * Live MCP client simulator.
 * Spawns the real dist/mcp.js using the working node binary,
 * performs the standard MCP handshake, calls the market discovery tools,
 * and prints exactly what the agent receives — especially whether tokenIds are present.
 */

import { spawn } from 'child_process';
import { once } from 'events';

const NODE_BIN = '/mnt/c/Program Files/nodejs/node.exe';
const MCP_CMD = 'dist/mcp.js';

const requests = [
  // 1. Initialize
  { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', clientInfo: { name: 'diagnostic', version: '1.0' }, capabilities: {} } },
  // 2. List tools (to confirm surface)
  { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} },
  // 3. Call list_markets (the most common discovery tool)
  { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'list_markets', arguments: { pageSize: 2 } } },
  // 4. Call search
  { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'search', arguments: { q: 'bitcoin', pageSize: 1 } } },
  // 5. Read the markets resource (another path the agent uses)
  { jsonrpc: '2.0', id: 5, method: 'resources/read', params: { uri: 'polymarket://markets' } },
];

let buffer = '';
let requestIndex = 0;

// Use bash -c wrapper so the Windows path with spaces is handled by a real shell (the only reliable way from WSL)
const mcp = spawn('bash', ['-c', `"${NODE_BIN}" "${MCP_CMD}"`], {
  stdio: ['pipe', 'pipe', 'pipe'],
  cwd: process.cwd(),
  env: { ...process.env, MCP_MODE: '1', MCP_SERVER: 'true' }
});

console.error('=== MCP SERVER SPAWNED ===');
console.error('PID:', mcp.pid);

mcp.stderr.on('data', (d) => {
  const lines = d.toString().trim().split('\n');
  for (const l of lines) if (l) console.error('[MCP stderr]', l);
});

mcp.stdout.on('data', (data) => {
  buffer += data.toString();
  // MCP uses newlines as delimiters for messages
  let idx;
  while ((idx = buffer.indexOf('\n')) !== -1) {
    const line = buffer.slice(0, idx).trim();
    buffer = buffer.slice(idx + 1);
    if (line) {
      try {
        const msg = JSON.parse(line);
        handleResponse(msg);
      } catch (e) {
        console.error('[parse error]', line.slice(0, 200));
      }
    }
  }
});

mcp.on('exit', (code) => {
  console.error('MCP process exited with code', code);
  process.exit(code || 0);
});

function sendNext() {
  if (requestIndex >= requests.length) {
    console.error('\n=== ALL TEST REQUESTS SENT. Waiting for final responses... ===');
    setTimeout(() => {
      console.error('=== TEST COMPLETE ===');
      mcp.kill();
    }, 4000);
    return;
  }
  const req = requests[requestIndex++];
  const payload = JSON.stringify(req) + '\n';
  console.error(`\n>>> SENDING [${req.id}] ${req.method}${req.params?.name ? ' ' + req.params.name : ''}`);
  mcp.stdin.write(payload);
}

function handleResponse(msg) {
  if (msg.id !== undefined) {
    console.error(`<<< RESPONSE [${msg.id}]`);
  }

  if (msg.result?.tools) {
    console.error('Tools count:', msg.result.tools.length);
    // Just confirm order tools require tokenId
    const orderTool = msg.result.tools.find(t => t.name === 'create_and_post_order');
    if (orderTool) {
      console.error('create_and_post_order required params:', Object.keys(orderTool.inputSchema?.properties || {}).filter(k => orderTool.inputSchema.required?.includes(k)));
    }
  }

  if (msg.result?.content?.[0]?.text) {
    const text = msg.result.content[0].text;
    // Look specifically for tokenId evidence in discovery responses
    const hasYesToken = /Yes Token Id/i.test(text) || /"Yes Token Id"/.test(text);
    const hasNoToken = /No Token Id/i.test(text) || /"No Token Id"/.test(text);
    const hasTokenIds = /"Token Ids"/i.test(text) || /Token Ids/i.test(text);
    const hasAnyToken = /tokenId|token_id|Token Id/i.test(text);

    console.error('  Discovery response contains:');
    console.error('    Yes Token Id field?', hasYesToken);
    console.error('    No Token Id field ?', hasNoToken);
    console.error('    Token Ids array  ?', hasTokenIds);
    console.error('    Any token mention?', hasAnyToken);

    // Show a truncated sample of what the agent actually sees
    const sample = text.slice(0, 800);
    console.error('  Sample output to agent:\n' + sample + (text.length > 800 ? '\n... (truncated)' : ''));
  }

  if (msg.result?.contents) {
    // resources/read path
    console.error('  Resource read contents count:', msg.result.contents?.length);
    const txt = JSON.stringify(msg.result.contents);
    const hasTok = /tokenId|Yes Token|No Token/i.test(txt);
    console.error('  Resource contains token info?', hasTok);
  }

  // Send next request after short delay
  setTimeout(sendNext, 300);
}

// Kick off the handshake
setTimeout(sendNext, 800);
