#!/usr/bin/env node
import { fileURLToPath } from 'node:url';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { createMcpExpressApp } from '@modelcontextprotocol/sdk/server/express.js';
import * as z from 'zod/v4';
import { buildAnswer, lookupMbsItem } from './src/mbs.js';

export function createServer(options = {}) {
  const server = new McpServer({
    name: 'mbs-billing-assistant',
    version: '1.0.0'
  });

  server.registerTool(
    'lookup_mbs_item',
    {
      description:
        'Look up an Australian Medicare Benefits Schedule item number and return the scheduled fee and Medicare rebate.',
      inputSchema: {
        itemNumber: z.string().describe('The MBS item number to look up, such as 23.'),
        focus: z
          .enum(['fee', 'rebate', 'both'])
          .optional()
          .describe('Whether to answer about the scheduled fee, the rebate, or both values.')
      },
      outputSchema: {
        itemNumber: z.string(),
        itemName: z.string().nullable(),
        itemDescription: z.string().nullable(),
        fee: z.number().nullable(),
        rebate: z.number().nullable(),
        effectiveFrom: z.string().nullable(),
        effectiveTo: z.string().nullable(),
        answer: z.string()
      }
    },
    async ({ itemNumber, focus }) => {
      try {
        const item = await lookupMbsItem(itemNumber, options);
        const answer = buildAnswer(item, focus ?? 'both');

        return {
          content: [
            {
              type: 'text',
              text: answer
            }
          ],
          structuredContent: {
            ...item,
            answer
          }
        };
      } catch (error) {
        return {
          isError: true,
          content: [
            {
              type: 'text',
              text: error instanceof Error ? error.message : 'Unable to look up the requested MBS item.'
            }
          ]
        };
      }
    }
  );

  return server;
}

async function runStdio() {
  const transport = new StdioServerTransport();
  const server = createServer();
  await server.connect(transport);
}

async function runHttp() {
  const port = parseInt(process.env.PORT ?? '3000', 10);
  const app = createMcpExpressApp({ host: '0.0.0.0' });

  app.get('/', (_req, res) => {
    res.json({ status: 'ok', service: 'mbs-mcp-server' });
  });

  app.get('/health', (_req, res) => {
    res.json({ status: 'ok' });
  });

  app.post('/mcp', async (req, res) => {
    const server = createServer();
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
      res.on('close', () => {
        transport.close();
        server.close();
      });
    } catch (error) {
      console.error('Error handling MCP request:', error);
      if (!res.headersSent) {
        res.status(500).json({
          jsonrpc: '2.0',
          error: { code: -32603, message: 'Internal server error' },
          id: null
        });
      }
    }
  });

  app.get('/mcp', (_req, res) => {
    res.status(405).json({
      jsonrpc: '2.0',
      error: { code: -32000, message: 'Method not allowed.' },
      id: null
    });
  });

  app.delete('/mcp', (_req, res) => {
    res.status(405).json({
      jsonrpc: '2.0',
      error: { code: -32000, message: 'Method not allowed.' },
      id: null
    });
  });

  await new Promise((resolve, reject) => {
    app.listen(port, '0.0.0.0', (err) => {
      if (err) return reject(err);
      console.log(`MBS MCP server listening on port ${port}`);
      console.log(`MCP endpoint: http://localhost:${port}/mcp`);
      resolve();
    });
  });
}

async function main() {
  if (process.env.MCP_TRANSPORT === 'stdio') {
    await runStdio();
  } else {
    await runHttp();
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error('MBS MCP server failed to start:', error);
    process.exit(1);
  });
}
