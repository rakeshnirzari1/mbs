#!/usr/bin/env node
import { fileURLToPath } from 'node:url';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { createMcpExpressApp } from '@modelcontextprotocol/sdk/server/express.js';
import * as z from 'zod/v4';
import { buildAnswer, lookupMbsItem } from './src/mbs.js';
import { DEFAULT_SUMMARY_DATA_URL, lookupSummaryItem } from './src/mbsSummary.js';

function toNullableString(value) {
  return typeof value === 'string' ? value : null;
}

function toNullableNumber(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function buildLookupStructuredContent(item, summary, summaryUpdated, answer) {
  return {
    itemNumber: String(item.itemNumber),
    itemName: toNullableString(item.itemName),
    itemDescription: toNullableString(item.itemDescription),
    fee: toNullableNumber(item.fee),
    rebate: toNullableNumber(item.rebate),
    effectiveFrom: toNullableString(item.effectiveFrom),
    effectiveTo: toNullableString(item.effectiveTo),
    summary: toNullableString(summary),
    summaryUpdated: toNullableString(summaryUpdated),
    answer: String(answer)
  };
}

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
        summary: z.string().nullable(),
        summaryUpdated: z.string().nullable(),
        answer: z.string()
      }
    },
    async ({ itemNumber, focus }) => {
      try {
        const item = await lookupMbsItem(itemNumber, options);

        let summary = null;
        let summaryUpdated = null;
        try {
          const summaryResult = await lookupSummaryItem(itemNumber, options);
          const normalizedSummary =
            summaryResult && typeof summaryResult.summary === 'string'
              ? summaryResult.summary.trim()
              : null;
          if (summaryResult && normalizedSummary) {
            summary = normalizedSummary;
            summaryUpdated = summaryResult.summaryUpdated;
          }
        } catch (summaryError) {
          console.warn('Summary lookup failed for lookup_mbs_item', {
            itemNumber: String(itemNumber),
            message: summaryError instanceof Error ? summaryError.message : 'Unknown summary lookup error'
          });
        }

        const answer = buildAnswer(item, focus ?? 'both');
        const fullAnswer = summary ? `${answer}\n\nBilling Compliance Summary:\n${summary}` : answer;

        return {
          content: [
            {
              type: 'text',
              text: fullAnswer
            }
          ],
          structuredContent: buildLookupStructuredContent(item, summary, summaryUpdated, fullAnswer)
        };
      } catch (error) {
        console.error('MBS lookup failed for lookup_mbs_item', {
          itemNumber: String(itemNumber),
          message: error instanceof Error ? error.message : 'Unknown lookup error'
        });
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

  server.registerTool(
    'lookup_mbs_item_summary',
    {
      description:
        'Look up the billing compliance summary for an Australian Medicare Benefits Schedule item number.',
      inputSchema: {
        itemNumber: z.string().describe('The MBS item number to look up, such as 23.')
      },
      outputSchema: {
        itemNumber: z.string(),
        summary: z.string(),
        summaryUpdated: z.string().nullable(),
        sourceUrl: z.string()
      }
    },
    async ({ itemNumber }) => {
      try {
        const summaryResult = await lookupSummaryItem(itemNumber, options);
        const normalizedSummary =
          summaryResult && typeof summaryResult.summary === 'string'
            ? summaryResult.summary.trim()
            : null;

        if (!summaryResult || !normalizedSummary) {
          return {
            isError: true,
            content: [
              {
                type: 'text',
                text: `No billing compliance summary content was found for MBS item ${itemNumber}.`
              }
            ]
          };
        }

        const sourceUrl =
          options.summaryDataUrl ?? process.env.MBS_SUMMARY_DATA_URL ?? DEFAULT_SUMMARY_DATA_URL;

        return {
          content: [
            {
              type: 'text',
              text: summaryResult.summary
            }
          ],
          structuredContent: {
            itemNumber: String(itemNumber),
            summary: normalizedSummary,
            summaryUpdated: toNullableString(summaryResult.summaryUpdated),
            sourceUrl: String(sourceUrl)
          }
        };
      } catch (error) {
        console.error('Summary lookup failed for lookup_mbs_item_summary', {
          itemNumber: String(itemNumber),
          message: error instanceof Error ? error.message : 'Unknown summary lookup error'
        });
        return {
          isError: true,
          content: [
            {
              type: 'text',
              text:
                error instanceof Error
                  ? error.message
                  : 'Unable to look up the billing compliance summary.'
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
    // Stateless mode: a fresh server and transport are created per request.
    // This matches the MCP SDK stateless pattern and avoids shared state between clients.
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

// Only run main() when this file is the Node.js entry point, not when imported as a module
// (e.g. by tests that import createServer).
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error('MBS MCP server failed to start:', error);
    process.exit(1);
  });
}
