import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

// A stand-in model gateway, shared by the specs that need one.
//
// Each spec had grown its own copy of this, which meant a change to what the
// engine asks for had to be made in eight places, and was made in six. The
// answer is configurable because the interesting tests are the ones where the
// model says something awkward.

export interface StubOptions {
  /** What the model answers. Given the request body, returns the text. */
  answer?: (body: string) => string;
  /** Models the catalogue reports. */
  models?: string[];
  /** Milliseconds to wait before answering — for testing slow providers. */
  delayMs?: number;
  /** When set, every completion fails with this HTTP status. */
  failWith?: number;
}

export interface Stub {
  baseUrl: string;
  /** Every completion body this stub was sent, in order. */
  seen: string[];
  close: () => Promise<void>;
}

export async function startStub(options: StubOptions = {}): Promise<Stub> {
  const seen: string[] = [];
  const models = options.models ?? ['claude-haiku-4-5', 'claude-sonnet-4-6'];

  const server: Server = createServer((req, res) => {
    if (req.url?.startsWith('/v1/models') === true) {
      res.writeHead(200, { 'content-type': 'application/json', connection: 'close' });
      res.end(JSON.stringify({ data: models.map((id) => ({ id })) }));
      return;
    }

    let body = '';
    req.on('data', (chunk: Buffer) => {
      body += chunk.toString();
    });
    req.on('end', () => {
      seen.push(body);

      const send = (): void => {
        if (options.failWith !== undefined) {
          res.writeHead(options.failWith, {
            'content-type': 'application/json',
            connection: 'close',
          });
          res.end(JSON.stringify({ error: { message: 'stub was told to fail' } }));
          return;
        }

        // The verification pass asks a yes/no question and needs JSON back.
        const verdict = body.includes('Has the task been achieved');
        const text = verdict
          ? '{"verified": true, "evidence": "answered"}'
          : (options.answer?.(body) ?? 'Done.');

        res.writeHead(200, { 'content-type': 'application/json', connection: 'close' });
        res.end(
          JSON.stringify({
            id: 's-1',
            model: models[0],
            choices: [
              { index: 0, message: { role: 'assistant', content: text }, finish_reason: 'stop' },
            ],
            usage: { prompt_tokens: 100, completion_tokens: 20 },
          }),
        );
      };

      if (options.delayMs === undefined) send();
      else setTimeout(send, options.delayMs);
    });
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;

  return {
    baseUrl: `http://127.0.0.1:${String(port)}/v1`,
    seen,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
