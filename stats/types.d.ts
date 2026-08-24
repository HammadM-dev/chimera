// The slice of Cloudflare's D1 API this worker uses, declared locally.
//
// `@cloudflare/workers-types` would give the whole surface, and CLAUDE.md says
// to ask before adding a dependency — for a hundred lines of worker using four
// methods, a local declaration is the smaller answer. It also keeps `stats/`
// buildable with nothing installed, which suits a directory that is deployed by
// `wrangler deploy` and never by this repository's build.
//
// If this drifts from the real API, `wrangler deploy` says so. That is the
// right place to find out: it is the only thing that runs this code.

interface D1Result<T = Record<string, unknown>> {
  results?: T[];
  success: boolean;
}

interface D1PreparedStatement {
  bind(...values: unknown[]): D1PreparedStatement;
  run(): Promise<D1Result>;
  all(): Promise<D1Result>;
  first<T = Record<string, unknown>>(): Promise<T | null>;
}

interface D1Database {
  prepare(query: string): D1PreparedStatement;
  batch(statements: D1PreparedStatement[]): Promise<D1Result[]>;
}
