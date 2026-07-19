#!/usr/bin/env node
import { fileURLToPath } from 'node:url';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { createMcpExpressApp } from '@modelcontextprotocol/sdk/server/express.js';
import * as z from 'zod/v4';
import {
  buildAnswer,
  DECIMAL_AMOUNT_PATTERN_SOURCE,
  isMetadataDescription,
  lookupMbsItem,
  parseCurrencyAmountText
} from './src/mbs.js';
import { DEFAULT_SUMMARY_DATA_URL, lookupSummaryItem } from './src/mbsSummary.js';

function toNullableString(value) {
  return typeof value === 'string' ? value : null;
}

function toNullableNumber(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function normalizeOptionalSummary(summaryResult) {
  if (!summaryResult || typeof summaryResult.summary !== 'string') {
    return null;
  }

  const normalizedSummary = summaryResult.summary.trim();
  if (!normalizedSummary) {
    return null;
  }

  return {
    summary: normalizedSummary,
    summaryUpdated: summaryResult.summaryUpdated
  };
}

function logToolError(level, toolName, itemNumber, error, failureMode = 'unexpected_error') {
  const logger = level === 'warn' ? console.warn : console.error;
  logger(`${toolName} failed`, {
    itemNumber: String(itemNumber),
    failureMode,
    errorType: error instanceof Error ? error.name : 'UnknownError',
    message: error instanceof Error ? error.message : 'Unknown error'
  });
}

function extractSummaryFeeAndRebate(summary) {
  if (typeof summary !== 'string') {
    return { fee: null, rebate: null };
  }

  const currencyPattern = `\\$\\s*${DECIMAL_AMOUNT_PATTERN_SOURCE}`;
  const normalized = summary.replace(/\*\*/g, ' ');
  const scheduledFee = parseCurrencyAmountText(
    normalized.match(new RegExp(`scheduled fee[^.\\n]*${currencyPattern}`, 'i'))?.[0] ?? ''
  );
  const benefitAmount = parseCurrencyAmountText(
    normalized.match(new RegExp(`benefit[^.\\n]*${currencyPattern}`, 'i'))?.[0] ?? ''
  );
  const hasHundredPercentBenefit = /benefit[^.\n]*100\s*%/i.test(normalized);

  const fee = scheduledFee;
  let rebate = benefitAmount;
  if (rebate === null && hasHundredPercentBenefit && fee !== null) {
    rebate = fee;
  }

  return { fee, rebate };
}

function normalizeSummaryBackedItem(item, summary) {
  const { fee, rebate } = extractSummaryFeeAndRebate(summary);

  return {
    ...item,
    itemDescription: isMetadataDescription(item.itemDescription) ? null : item.itemDescription,
    fee: fee ?? item.fee,
    rebate: rebate ?? item.rebate,
    effectiveFrom: null,
    effectiveTo: null
  };
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
        let summary = null;
        let summaryUpdated = null;
        try {
          const summaryResult = await lookupSummaryItem(itemNumber, options);
          const normalizedSummaryResult = normalizeOptionalSummary(summaryResult);
          if (normalizedSummaryResult) {
            summary = normalizedSummaryResult.summary;
            summaryUpdated = normalizedSummaryResult.summaryUpdated;
          }
        } catch (summaryError) {
          logToolError('warn', 'lookup_mbs_item', itemNumber, summaryError, 'summary_feed_error');
        }

        let item = null;
        let itemLookupError = null;
        try {
          item = await lookupMbsItem(itemNumber, options);
        } catch (error) {
          itemLookupError = error;
        }

        if (!item) {
          if (!summary) {
            throw itemLookupError ?? new Error('Unable to look up the requested MBS item.');
          }

          item = {
            itemNumber: String(itemNumber),
            itemName: null,
            itemDescription: null,
            fee: null,
            rebate: null,
            effectiveFrom: null,
            effectiveTo: null
          };
        }

        if (summary) {
          Object.assign(item, normalizeSummaryBackedItem(item, summary));
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
        logToolError('error', 'lookup_mbs_item', itemNumber, error, 'item_lookup_error');
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
        const normalizedSummaryResult = normalizeOptionalSummary(summaryResult);

        if (!normalizedSummaryResult) {
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
            summary: normalizedSummaryResult.summary,
            summaryUpdated: toNullableString(normalizedSummaryResult.summaryUpdated),
            sourceUrl: String(sourceUrl)
          }
        };
      } catch (error) {
        logToolError('error', 'lookup_mbs_item_summary', itemNumber, error, 'summary_lookup_error');
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
