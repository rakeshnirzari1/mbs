import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';
import { once } from 'node:events';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { buildAnswer, lookupMbsItem, normalizeItemNumber } from '../src/mbs.js';
import { lookupSummaryItem } from '../src/mbsSummary.js';
import { createServer } from '../server.js';

const repoRoot = new URL('..', import.meta.url);

test('normalizeItemNumber trims whitespace and uppercases letters', () => {
  assert.equal(normalizeItemNumber('  23a '), '23A');
});

test('lookupMbsItem maps MBS API item responses', async () => {
  const result = await lookupMbsItem('23', {
    apiBaseUrl: 'http://127.0.0.1',
    fetchImpl: async () => ({
      ok: true,
      headers: {
        get(name) {
          return name === 'content-type' ? 'application/json' : null;
        }
      },
      async json() {
        return {
          mbs_items: [
            {
              item_number: '23',
              item_description: 'Level B GP attendance',
              fee: 42.85,
              rebate: 41.4,
              effective_from: '2025-07-01'
            }
          ]
        };
      }
    })
  });

  assert.deepEqual(result, {
    itemNumber: '23',
    itemName: null,
    itemDescription: 'Level B GP attendance',
    fee: 42.85,
    rebate: 41.4,
    effectiveFrom: '2025-07-01',
    effectiveTo: null
  });
});

test('lookupMbsItem parses official-style HTML item pages', async () => {
  const result = await lookupMbsItem('23', {
    fetchImpl: async () => ({
      ok: true,
      headers: {
        get(name) {
          return name === 'content-type' ? 'text/html; charset=utf-8' : null;
        }
      },
      async text() {
        return `
          <html>
            <body>
              <h1>Item 23</h1>
              <p>Description: Level B GP attendance for a standard consultation.</p>
              <p>Schedule Fee: $45.05</p>
              <p>Benefit: 100% = $45.05</p>
            </body>
          </html>
        `;
      }
    })
  });

  assert.equal(result.itemNumber, '23');
  assert.equal(result.itemDescription, 'Level B GP attendance for a standard consultation.');
  assert.equal(result.fee, 45.05);
  assert.equal(result.rebate, 45.05);
});

test('lookupMbsItem parses incentive-style HTML benefit formats', async () => {
  const result = await lookupMbsItem('10990', {
    fetchImpl: async () => ({
      ok: true,
      headers: {
        get(name) {
          return name === 'content-type' ? 'text/html; charset=utf-8' : null;
        }
      },
      async text() {
        return `
          <html>
            <body>
              <h1>Item 10990</h1>
              <p>Description: Bulk billing incentive for eligible services.</p>
              <p>Benefits: 100% = $9.85 85% = $8.37</p>
            </body>
          </html>
        `;
      }
    })
  });

  assert.equal(result.itemNumber, '10990');
  assert.equal(result.itemDescription, 'Bulk billing incentive for eligible services.');
  assert.equal(result.fee, null);
  assert.equal(result.rebate, 9.85);
});

test('buildAnswer can focus on the rebate', () => {
  const answer = buildAnswer(
    {
      itemNumber: '23',
      itemName: null,
      itemDescription: 'Level B GP attendance',
      fee: 42.85,
      rebate: 41.4,
      effectiveFrom: null,
      effectiveTo: null
    },
    'rebate'
  );

  assert.match(answer, /Medicare rebate of \$41\.40/);
});

test('stdio MCP server exposes lookup_mbs_item', async () => {
  const apiServer = http.createServer((request, response) => {
    const url = new URL(request.url, 'http://127.0.0.1');
    assert.equal(url.searchParams.get('item'), '23');

    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(
      JSON.stringify({
        mbs_items: [
          {
            item_number: '23',
            item_name: 'Professional attendance',
            item_description: 'Level B GP attendance',
            fee: 42.85,
            rebate: 41.4,
            effective_from: '2025-07-01'
          }
        ]
      })
    );
  });

  apiServer.listen(0, '127.0.0.1');
  await once(apiServer, 'listening');

  const address = apiServer.address();
  const transport = new StdioClientTransport({
    command: 'node',
    args: ['server.js'],
    cwd: repoRoot.pathname,
    env: {
      MCP_TRANSPORT: 'stdio',
      MBS_API_BASE_URL: `http://127.0.0.1:${address.port}`
    },
    stderr: 'pipe'
  });
  const client = new Client({
    name: 'mbs-test-client',
    version: '1.0.0'
  });

  try {
    await client.connect(transport);

    const tools = await client.listTools();
    assert.ok(tools.tools.some((tool) => tool.name === 'lookup_mbs_item'));

    const result = await client.callTool({
      name: 'lookup_mbs_item',
      arguments: {
        itemNumber: '23',
        focus: 'both'
      }
    });

    assert.notEqual(result.isError, true);
    assert.equal(result.structuredContent.itemNumber, '23');
    assert.equal(result.structuredContent.fee, 42.85);
    assert.equal(result.structuredContent.rebate, 41.4);
    assert.match(result.content[0].text, /scheduled fee of \$42\.85 and a Medicare rebate of \$41\.40/);
  } finally {
    await transport.close();
    apiServer.close();
    await once(apiServer, 'close');
  }
});

test('createServer returns an MCP server with lookup_mbs_item tool', async () => {
  const server = createServer();
  assert.ok(server, 'createServer should return a server instance');
});

test('HTTP server health endpoints return ok', async () => {
  const { default: express } = await import('express');
  const { StreamableHTTPServerTransport } = await import('@modelcontextprotocol/sdk/server/streamableHttp.js');
  const { createMcpExpressApp } = await import('@modelcontextprotocol/sdk/server/express.js');

  const app = createMcpExpressApp({ host: '127.0.0.1' });

  app.get('/', (_req, res) => {
    res.json({ status: 'ok', service: 'mbs-mcp-server' });
  });

  app.get('/health', (_req, res) => {
    res.json({ status: 'ok' });
  });

  app.post('/mcp', async (req, res) => {
    // Mirrors the production stateless pattern: new server/transport per request.
    const server = createServer();
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
      res.on('close', () => { transport.close(); server.close(); });
    } catch (error) {
      if (!res.headersSent) res.status(500).json({ jsonrpc: '2.0', error: { code: -32603, message: 'Internal server error' }, id: null });
    }
  });

  app.get('/mcp', (_req, res) => {
    res.status(405).json({ jsonrpc: '2.0', error: { code: -32000, message: 'Method not allowed.' }, id: null });
  });

  const httpServer = app.listen(0, '127.0.0.1');
  await once(httpServer, 'listening');
  const { port } = httpServer.address();
  const base = `http://127.0.0.1:${port}`;

  try {
    const healthRes = await fetch(`${base}/health`);
    assert.equal(healthRes.status, 200);
    const healthBody = await healthRes.json();
    assert.equal(healthBody.status, 'ok');

    const rootRes = await fetch(`${base}/`);
    assert.equal(rootRes.status, 200);
    const rootBody = await rootRes.json();
    assert.equal(rootBody.status, 'ok');

    const mcpGetRes = await fetch(`${base}/mcp`);
    assert.equal(mcpGetRes.status, 405);

    const mcpBadBody = await fetch(`${base}/mcp`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ not: 'valid-mcp' })
    });
    assert.ok(mcpBadBody.status >= 400, `expected error status, got ${mcpBadBody.status}`);

    const notFoundRes = await fetch(`${base}/unknown-path`);
    assert.equal(notFoundRes.status, 404);
  } finally {
    httpServer.close();
    await once(httpServer, 'close');
  }
});

test('lookupSummaryItem returns summary for known item', async () => {
  const result = await lookupSummaryItem('23', {
    summaryDataUrl: 'http://unused.test',
    summaryCacheTtlMs: 0,
    fetchImpl: async () => ({
      ok: true,
      async json() {
        return {
          '23': { content: 'Billing compliance summary for item 23.', updated: '2026-07-04' }
        };
      }
    })
  });

  assert.deepEqual(result, {
    summary: 'Billing compliance summary for item 23.',
    summaryUpdated: '2026-07-04'
  });
});

test('lookupSummaryItem returns null for unknown item', async () => {
  const result = await lookupSummaryItem('999', {
    summaryDataUrl: 'http://unused.test',
    summaryCacheTtlMs: 0,
    fetchImpl: async () => ({
      ok: true,
      async json() {
        return {
          '23': { content: 'Billing compliance summary for item 23.', updated: '2026-07-04' }
        };
      }
    })
  });

  assert.equal(result, null);
});

test('stdio MCP server lookup_mbs_item includes summary when available', async () => {
  const apiServer = http.createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(
      JSON.stringify({
        mbs_items: [
          {
            item_number: '23',
            item_name: 'Professional attendance',
            item_description: 'Level B GP attendance',
            fee: 42.85,
            rebate: 41.4,
            effective_from: '2025-07-01'
          }
        ]
      })
    );
  });

  const summaryServer = http.createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(
      JSON.stringify({
        '23': { content: 'Billing compliance summary for item 23.', updated: '2026-07-04' }
      })
    );
  });

  apiServer.listen(0, '127.0.0.1');
  summaryServer.listen(0, '127.0.0.1');
  await Promise.all([once(apiServer, 'listening'), once(summaryServer, 'listening')]);

  const apiPort = apiServer.address().port;
  const summaryPort = summaryServer.address().port;

  const transport = new StdioClientTransport({
    command: 'node',
    args: ['server.js'],
    cwd: repoRoot.pathname,
    env: {
      MCP_TRANSPORT: 'stdio',
      MBS_API_BASE_URL: `http://127.0.0.1:${apiPort}`,
      MBS_SUMMARY_DATA_URL: `http://127.0.0.1:${summaryPort}`
    },
    stderr: 'pipe'
  });
  const client = new Client({ name: 'mbs-test-client', version: '1.0.0' });

  try {
    await client.connect(transport);

    const result = await client.callTool({
      name: 'lookup_mbs_item',
      arguments: { itemNumber: '23', focus: 'both' }
    });

    assert.notEqual(result.isError, true);
    assert.equal(result.structuredContent.fee, 42.85);
    assert.equal(result.structuredContent.summary, 'Billing compliance summary for item 23.');
    assert.equal(result.structuredContent.summaryUpdated, '2026-07-04');
    assert.deepEqual(Object.keys(result.structuredContent).sort(), [
      'answer',
      'effectiveFrom',
      'effectiveTo',
      'fee',
      'itemDescription',
      'itemName',
      'itemNumber',
      'rebate',
      'summary',
      'summaryUpdated'
    ]);
    assert.match(result.content[0].text, /scheduled fee of \$42\.85/);
    assert.match(result.content[0].text, /Billing Compliance Summary/);
  } finally {
    await transport.close();
    apiServer.close();
    summaryServer.close();
    await Promise.all([once(apiServer, 'close'), once(summaryServer, 'close')]);
  }
});

test('stdio MCP server lookup_mbs_item succeeds when summary feed unavailable', async () => {
  const apiServer = http.createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(
      JSON.stringify({
        mbs_items: [{ item_number: '23', fee: 42.85, rebate: 41.4 }]
      })
    );
  });

  // Summary server that always returns 503 to simulate unavailability.
  const unavailableSummaryServer = http.createServer((_request, response) => {
    response.writeHead(503);
    response.end();
  });

  apiServer.listen(0, '127.0.0.1');
  unavailableSummaryServer.listen(0, '127.0.0.1');
  await Promise.all([once(apiServer, 'listening'), once(unavailableSummaryServer, 'listening')]);

  const transport = new StdioClientTransport({
    command: 'node',
    args: ['server.js'],
    cwd: repoRoot.pathname,
    env: {
      MCP_TRANSPORT: 'stdio',
      MBS_API_BASE_URL: `http://127.0.0.1:${apiServer.address().port}`,
      MBS_SUMMARY_DATA_URL: `http://127.0.0.1:${unavailableSummaryServer.address().port}`
    },
    stderr: 'pipe'
  });
  const client = new Client({ name: 'mbs-test-client', version: '1.0.0' });

  try {
    await client.connect(transport);

    const result = await client.callTool({
      name: 'lookup_mbs_item',
      arguments: { itemNumber: '23' }
    });

    assert.notEqual(result.isError, true);
    assert.equal(result.structuredContent.fee, 42.85);
    assert.equal(result.structuredContent.rebate, 41.4);
    assert.equal(result.structuredContent.summary, null);
    assert.equal(result.structuredContent.summaryUpdated, null);
  } finally {
    await transport.close();
    apiServer.close();
    unavailableSummaryServer.close();
    await Promise.all([once(apiServer, 'close'), once(unavailableSummaryServer, 'close')]);
  }
});

test('stdio MCP server lookup_mbs_item ignores malformed summary feed entries', async () => {
  const apiServer = http.createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(
      JSON.stringify({
        mbs_items: [{ item_number: '23', fee: 42.85, rebate: 41.4 }]
      })
    );
  });

  const summaryServer = http.createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(
      JSON.stringify({
        '23': { updated: '2026-07-04' }
      })
    );
  });

  apiServer.listen(0, '127.0.0.1');
  summaryServer.listen(0, '127.0.0.1');
  await Promise.all([once(apiServer, 'listening'), once(summaryServer, 'listening')]);

  const transport = new StdioClientTransport({
    command: 'node',
    args: ['server.js'],
    cwd: repoRoot.pathname,
    env: {
      MCP_TRANSPORT: 'stdio',
      MBS_API_BASE_URL: `http://127.0.0.1:${apiServer.address().port}`,
      MBS_SUMMARY_DATA_URL: `http://127.0.0.1:${summaryServer.address().port}`
    },
    stderr: 'pipe'
  });
  const client = new Client({ name: 'mbs-test-client', version: '1.0.0' });

  try {
    await client.connect(transport);

    const result = await client.callTool({
      name: 'lookup_mbs_item',
      arguments: { itemNumber: '23' }
    });

    assert.notEqual(result.isError, true);
    assert.equal(result.structuredContent.summary, null);
    assert.equal(result.structuredContent.summaryUpdated, null);
  } finally {
    await transport.close();
    apiServer.close();
    summaryServer.close();
    await Promise.all([once(apiServer, 'close'), once(summaryServer, 'close')]);
  }
});

test('stdio MCP server lookup_mbs_item_summary returns data for known item', async () => {
  const summaryServer = http.createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(
      JSON.stringify({
        '23': { content: 'Billing compliance summary for item 23.', updated: '2026-07-04' }
      })
    );
  });

  summaryServer.listen(0, '127.0.0.1');
  await once(summaryServer, 'listening');

  const summaryUrl = `http://127.0.0.1:${summaryServer.address().port}`;

  const transport = new StdioClientTransport({
    command: 'node',
    args: ['server.js'],
    cwd: repoRoot.pathname,
    env: {
      MCP_TRANSPORT: 'stdio',
      MBS_SUMMARY_DATA_URL: summaryUrl
    },
    stderr: 'pipe'
  });
  const client = new Client({ name: 'mbs-test-client', version: '1.0.0' });

  try {
    await client.connect(transport);

    const tools = await client.listTools();
    assert.ok(tools.tools.some((tool) => tool.name === 'lookup_mbs_item_summary'));

    const result = await client.callTool({
      name: 'lookup_mbs_item_summary',
      arguments: { itemNumber: '23' }
    });

    assert.notEqual(result.isError, true);
    assert.equal(result.structuredContent.itemNumber, '23');
    assert.equal(result.structuredContent.summary, 'Billing compliance summary for item 23.');
    assert.equal(result.structuredContent.summaryUpdated, '2026-07-04');
    assert.equal(result.structuredContent.sourceUrl, summaryUrl);
  } finally {
    await transport.close();
    summaryServer.close();
    await once(summaryServer, 'close');
  }
});

test('stdio MCP server lookup_mbs_item_summary returns error for unknown item', async () => {
  const summaryServer = http.createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(
      JSON.stringify({
        '23': { content: 'Billing compliance summary for item 23.', updated: '2026-07-04' }
      })
    );
  });

  summaryServer.listen(0, '127.0.0.1');
  await once(summaryServer, 'listening');

  const transport = new StdioClientTransport({
    command: 'node',
    args: ['server.js'],
    cwd: repoRoot.pathname,
    env: {
      MCP_TRANSPORT: 'stdio',
      MBS_SUMMARY_DATA_URL: `http://127.0.0.1:${summaryServer.address().port}`
    },
    stderr: 'pipe'
  });
  const client = new Client({ name: 'mbs-test-client', version: '1.0.0' });

  try {
    await client.connect(transport);

    const result = await client.callTool({
      name: 'lookup_mbs_item_summary',
      arguments: { itemNumber: '999' }
    });

    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /No billing compliance summary content was found/);
  } finally {
    await transport.close();
    summaryServer.close();
    await once(summaryServer, 'close');
  }
});

test('stdio MCP server lookup_mbs_item_summary returns error for malformed summary entry', async () => {
  const summaryServer = http.createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(
      JSON.stringify({
        '23': { updated: '2026-07-04' }
      })
    );
  });

  summaryServer.listen(0, '127.0.0.1');
  await once(summaryServer, 'listening');

  const transport = new StdioClientTransport({
    command: 'node',
    args: ['server.js'],
    cwd: repoRoot.pathname,
    env: {
      MCP_TRANSPORT: 'stdio',
      MBS_SUMMARY_DATA_URL: `http://127.0.0.1:${summaryServer.address().port}`
    },
    stderr: 'pipe'
  });
  const client = new Client({ name: 'mbs-test-client', version: '1.0.0' });

  try {
    await client.connect(transport);

    const result = await client.callTool({
      name: 'lookup_mbs_item_summary',
      arguments: { itemNumber: '23' }
    });

    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /No billing compliance summary content was found/);
  } finally {
    await transport.close();
    summaryServer.close();
    await once(summaryServer, 'close');
  }
});
