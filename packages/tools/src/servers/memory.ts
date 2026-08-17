import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

// The memory tool server. How an agent records what it learned and looks up
// what a previous run knew.
//
// A tool rather than something the runtime does automatically: an agent should
// decide what is worth remembering, because a runtime that stored everything
// would fill the store with the transcript and bury the four things that
// mattered. What it must not decide is *where* memory goes — that is the
// backend's business, injected here.

export interface MemoryBackend {
  remember: (input: {
    kind: string;
    subject: string;
    body: string;
    confidence: number;
    tags: string[];
  }) => { id: string };
  recall: (query: string, limit: number) => { subject: string; body: string; kind: string }[];
}

const KINDS = [
  'fact',
  'project',
  'goal',
  'habit',
  'preference',
  'decision',
  'person',
  'tool',
] as const;

export function createMemoryServer(backend: MemoryBackend): McpServer {
  const server = new McpServer({ name: 'chimera-memory', version: '0.0.0' });

  server.registerTool(
    'remember',
    {
      description:
        'Records something worth knowing next time: a fact, a preference, a goal, a decision. Use it for things that stay true after this run ends, not for working notes.',
      inputSchema: {
        kind: z.enum(KINDS).describe('What sort of thing this is'),
        subject: z.string().min(1).describe('What it is about — a project, a person, a system'),
        body: z.string().min(1).describe('The thing itself, in one or two sentences'),
        confidence: z
          .number()
          .min(0)
          .max(1)
          .default(0.6)
          .describe('How sure you are. Something a tool returned is not a guess; say so.'),
        tags: z.array(z.string()).default([]),
      },
    },
    ({ kind, subject, body, confidence, tags }) => {
      const stored = backend.remember({
        kind,
        subject,
        body,
        confidence: confidence ?? 0.6,
        tags: tags ?? [],
      });
      return { content: [{ type: 'text' as const, text: `Remembered (${stored.id}).` }] };
    },
  );

  server.registerTool(
    'recall',
    {
      description: 'Looks up what is already known about something before working it out again.',
      inputSchema: {
        query: z.string().min(1),
        limit: z.number().int().positive().max(50).default(10),
      },
    },
    ({ query, limit }) => {
      const found = backend.recall(query, limit ?? 10);
      if (found.length === 0) {
        // An empty result is stated, not returned as an empty string: an agent
        // handed "" cannot tell "nothing known" from "the tool broke".
        return { content: [{ type: 'text' as const, text: `Nothing known about "${query}".` }] };
      }
      return {
        content: [
          {
            type: 'text' as const,
            text: found.map((row) => `[${row.kind}] ${row.subject}: ${row.body}`).join('\n'),
          },
        ],
      };
    },
  );

  return server;
}
