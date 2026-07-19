#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
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

async function main() {
  const transport = new StdioServerTransport();
  const server = createServer();
  await server.connect(transport);
}

main().catch((error) => {
  console.error('MBS MCP server failed to start:', error);
  process.exit(1);
});
