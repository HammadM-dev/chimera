#!/usr/bin/env node
// A real MCP server, as a plugin would be.
//
// This is the shape every community MCP server has — the email, calendar and
// issue-tracker servers a user would actually install — reduced to one tool so
// a test can prove the whole path: added in Providers, its tools offered to an
// agent, called during a run, governed like any other tool.
//
// It writes what it was told to a file, which is how the test knows the call
// really happened rather than being reported as having happened.
import fs from 'node:fs';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const outbox = process.env.PLUGIN_OUTBOX ?? '';
const token = process.env.PLUGIN_TOKEN ?? '';

const server = new McpServer({ name: 'test-mailer', version: '0.0.1' });

server.registerTool(
  'send',
  {
    description: 'Sends a message to somebody.',
    inputSchema: { to: z.string(), subject: z.string(), body: z.string() },
  },
  ({ to, subject, body }) => {
    if (outbox !== '') {
      fs.appendFileSync(
        outbox,
        `${JSON.stringify({ to, subject, body, tokenSeen: token !== '' })}\n`,
        'utf8',
      );
    }
    return { content: [{ type: 'text', text: `Sent to ${to}.` }] };
  },
);

await server.connect(new StdioServerTransport());
