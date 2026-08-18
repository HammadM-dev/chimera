import type Database from 'better-sqlite3';

// The only code permitted to write SQL against the `roles` table. Mirrors
// migrations/0003_roles.sql exactly. The JSON columns are opaque strings here:
// their shapes belong to packages/core, and packages/store does not import it.

export interface RoleRecord {
  id: string;
  name: string;
  systemPrompt: string;
  toolAllowlistJson: string;
  modelBindingJson: string;
  budgetJson: string;
  outputContractJson: string;
  maxIterations: number;
  /** True for an agent several others are meant to feed at once. */
  combinesMany: boolean;
  isBuiltin: boolean;
  updatedAt: string;
}

export type UpsertRoleInput = Omit<RoleRecord, 'updatedAt'>;

interface RoleRow {
  id: string;
  name: string;
  system_prompt: string;
  tool_allowlist_json: string;
  model_binding_json: string;
  budget_json: string;
  output_contract_json: string;
  max_iterations: number;
  combines_many: number;
  is_builtin: number;
  updated_at: string;
}

function toRecord(row: RoleRow): RoleRecord {
  return {
    id: row.id,
    name: row.name,
    systemPrompt: row.system_prompt,
    toolAllowlistJson: row.tool_allowlist_json,
    modelBindingJson: row.model_binding_json,
    budgetJson: row.budget_json,
    outputContractJson: row.output_contract_json,
    maxIterations: row.max_iterations,
    combinesMany: row.combines_many === 1,
    isBuiltin: row.is_builtin === 1,
    updatedAt: row.updated_at,
  };
}

export function list(db: Database.Database): RoleRecord[] {
  return (db.prepare('SELECT * FROM roles ORDER BY name').all() as RoleRow[]).map(toRecord);
}

export function get(db: Database.Database, id: string): RoleRecord | undefined {
  const row = db.prepare('SELECT * FROM roles WHERE id = ?').get(id) as RoleRow | undefined;
  return row ? toRecord(row) : undefined;
}

/**
 * Inserts or replaces a role.
 *
 * `updated_at` is refreshed on every write, which is what lets a caller tell a
 * user-edited role from one that still holds its shipped defaults.
 */
export function upsert(db: Database.Database, input: UpsertRoleInput): RoleRecord {
  db.prepare(
    `INSERT INTO roles (
       id, name, system_prompt, tool_allowlist_json, model_binding_json,
       budget_json, output_contract_json, max_iterations, combines_many, is_builtin, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
     ON CONFLICT(id) DO UPDATE SET
       name = excluded.name,
       system_prompt = excluded.system_prompt,
       tool_allowlist_json = excluded.tool_allowlist_json,
       model_binding_json = excluded.model_binding_json,
       budget_json = excluded.budget_json,
       output_contract_json = excluded.output_contract_json,
       max_iterations = excluded.max_iterations,
       combines_many = excluded.combines_many,
       is_builtin = excluded.is_builtin,
       updated_at = datetime('now')`,
  ).run(
    input.id,
    input.name,
    input.systemPrompt,
    input.toolAllowlistJson,
    input.modelBindingJson,
    input.budgetJson,
    input.outputContractJson,
    input.maxIterations,
    input.combinesMany ? 1 : 0,
    input.isBuiltin ? 1 : 0,
  );

  const stored = get(db, input.id);
  if (!stored) {
    throw new Error(`Role "${input.id}" vanished immediately after being written`);
  }
  return stored;
}

/** Removes a role a user made. Built-in roles are not deletable. */
export function remove(db: Database.Database, id: string): { removed: boolean } {
  const info = db.prepare('DELETE FROM roles WHERE id = ? AND is_builtin = 0').run(id);
  return { removed: info.changes > 0 };
}

/** True when the table has never been seeded. */
export function isEmpty(db: Database.Database): boolean {
  const row = db.prepare('SELECT COUNT(*) AS count FROM roles').get() as { count: number };
  return row.count === 0;
}
