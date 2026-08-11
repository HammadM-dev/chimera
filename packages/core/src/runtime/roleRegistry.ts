import type Database from 'better-sqlite3';
import { ValidationError } from '@chimera/errors';
import { rolesRepository, type RoleRecord } from '@chimera/store';

// F2.2's roles: what an agent is, expressed as data the user can edit rather
// than as a class someone has to write.
//
// A role is the unit capability limits attach to. CLAUDE.md: "An agent cannot
// misuse a tool it was never granted" — the grant lives here, and
// packages/tools/src/allowlist.ts is what reads it.

/**
 * Which class of model this role wants.
 *
 * A tier rather than a model id, because the model that is right for
 * "summarise this" changes every few months and a role that names
 * `claude-haiku-4-5` is wrong the moment it does. M5-4's tiering resolves a
 * tier to an actual model against the connections available; `preferredModel`
 * is the escape hatch for a user who does want to pin one.
 */
export type ModelTier = 'frontier' | 'balanced' | 'cheap';

export interface ModelBinding {
  tier: ModelTier;
  preferredModel: string | null;
}

export interface RoleBudget {
  maxTokens: number;
  /** Null where the workspace has no cost cap for this role — not zero, which would mean "no spend". */
  maxCostUsd: number | null;
  maxWallClockMs: number;
}

export interface OutputContract {
  format: 'text' | 'json';
  /** Names a schema registered by M2-8. Null for free text. */
  schemaId: string | null;
}

export interface Role {
  id: string;
  name: string;
  systemPrompt: string;
  /** Exact tool ids or whole-server grants (`filesystem.*`). See packages/tools/src/allowlist.ts. */
  toolAllowlist: readonly string[];
  modelBinding: ModelBinding;
  budget: RoleBudget;
  outputContract: OutputContract;
  /** Hard iteration cap. CLAUDE.md: "No unbounded loops." */
  maxIterations: number;
  isBuiltin: boolean;
}

const DEFAULT_BUDGET: RoleBudget = {
  maxTokens: 200_000,
  maxCostUsd: 2,
  maxWallClockMs: 10 * 60_000,
};

/**
 * The eight starter roles from F2.2.
 *
 * Each allowlist is the narrowest set that lets the role do its job: a
 * researcher reads and fetches but cannot write files or run commands, a
 * reviewer reads but cannot write at all, and only the coder gets a shell.
 * `browser-operator` references the `browser` server that does not exist until
 * M6 — the grant is declared now and simply matches nothing, because
 * `toolRegistry.invoke` rejects tools that are not registered.
 */
export const STARTER_ROLES: readonly Role[] = [
  {
    id: 'planner',
    name: 'Planner',
    systemPrompt:
      'You break a goal into an ordered list of concrete steps. Each step names one action and how its result will be checked. You do not carry the steps out.',
    toolAllowlist: [],
    modelBinding: { tier: 'frontier', preferredModel: null },
    budget: { ...DEFAULT_BUDGET, maxTokens: 100_000 },
    outputContract: { format: 'json', schemaId: 'plan' },
    maxIterations: 3,
    isBuiltin: true,
  },
  {
    id: 'researcher',
    name: 'Researcher',
    systemPrompt:
      'You answer questions from sources you have actually read. Every claim you report carries the source it came from. When the sources disagree or do not cover the question, you say so rather than filling the gap.',
    toolAllowlist: ['http.request', 'filesystem.readFile', 'filesystem.listDirectory'],
    modelBinding: { tier: 'balanced', preferredModel: null },
    budget: DEFAULT_BUDGET,
    outputContract: { format: 'text', schemaId: null },
    maxIterations: 12,
    isBuiltin: true,
  },
  {
    id: 'coder',
    name: 'Coder',
    systemPrompt:
      'You write and change code in the run workspace. You read the surrounding code before changing it and match its conventions. You run the project checks after a change and report failures rather than describing the change as done.',
    toolAllowlist: ['filesystem.*', 'shell.exec'],
    modelBinding: { tier: 'frontier', preferredModel: null },
    budget: { ...DEFAULT_BUDGET, maxTokens: 400_000, maxWallClockMs: 20 * 60_000 },
    outputContract: { format: 'text', schemaId: null },
    maxIterations: 25,
    isBuiltin: true,
  },
  {
    id: 'reviewer',
    name: 'Reviewer',
    systemPrompt:
      'You review work against the task it was meant to do. You report only defects you can point at a line for, and you state what would fail rather than how the code feels. You change nothing.',
    // Read-only by construction: a reviewer that could edit would quietly
    // become the author of what it is reviewing.
    toolAllowlist: ['filesystem.readFile', 'filesystem.listDirectory'],
    modelBinding: { tier: 'frontier', preferredModel: null },
    budget: DEFAULT_BUDGET,
    outputContract: { format: 'json', schemaId: 'review' },
    maxIterations: 8,
    isBuiltin: true,
  },
  {
    id: 'qa',
    name: 'QA',
    systemPrompt:
      'You verify that work does what was asked by exercising it, not by reading it. You write and run checks, and you report the output you actually saw.',
    toolAllowlist: ['filesystem.*', 'shell.exec'],
    modelBinding: { tier: 'balanced', preferredModel: null },
    budget: DEFAULT_BUDGET,
    outputContract: { format: 'json', schemaId: 'verification' },
    maxIterations: 15,
    isBuiltin: true,
  },
  {
    id: 'data-extractor',
    name: 'Data extractor',
    systemPrompt:
      'You pull structured records out of unstructured text. You copy values, you do not infer them: a field the source does not state is null, never a plausible guess.',
    toolAllowlist: ['filesystem.readFile', 'filesystem.listDirectory'],
    modelBinding: { tier: 'cheap', preferredModel: null },
    budget: { ...DEFAULT_BUDGET, maxCostUsd: 0.5 },
    outputContract: { format: 'json', schemaId: 'extraction' },
    maxIterations: 5,
    isBuiltin: true,
  },
  {
    id: 'browser-operator',
    name: 'Browser operator',
    systemPrompt:
      'You operate a web browser to complete a stated task. You report what is on the page, and you stop and ask before any action that sends, buys, publishes, or deletes.',
    // The browser server arrives in M6. Declared now, matches nothing until then.
    toolAllowlist: ['browser.*'],
    modelBinding: { tier: 'frontier', preferredModel: null },
    budget: { ...DEFAULT_BUDGET, maxWallClockMs: 15 * 60_000 },
    outputContract: { format: 'text', schemaId: null },
    maxIterations: 20,
    isBuiltin: true,
  },
  {
    id: 'summariser',
    name: 'Summariser',
    systemPrompt:
      'You compress text without changing what it claims. You keep numbers, names, and caveats exactly as stated, and you drop repetition rather than detail.',
    toolAllowlist: [],
    modelBinding: { tier: 'cheap', preferredModel: null },
    budget: { ...DEFAULT_BUDGET, maxTokens: 100_000, maxCostUsd: 0.5 },
    outputContract: { format: 'text', schemaId: null },
    maxIterations: 2,
    isBuiltin: true,
  },
];

function toRole(record: RoleRecord): Role {
  return {
    id: record.id,
    name: record.name,
    systemPrompt: record.systemPrompt,
    toolAllowlist: JSON.parse(record.toolAllowlistJson) as string[],
    modelBinding: JSON.parse(record.modelBindingJson) as ModelBinding,
    budget: JSON.parse(record.budgetJson) as RoleBudget,
    outputContract: JSON.parse(record.outputContractJson) as OutputContract,
    maxIterations: record.maxIterations,
    isBuiltin: record.isBuiltin,
  };
}

function toRecord(role: Role): Omit<RoleRecord, 'updatedAt'> {
  return {
    id: role.id,
    name: role.name,
    systemPrompt: role.systemPrompt,
    toolAllowlistJson: JSON.stringify(role.toolAllowlist),
    modelBindingJson: JSON.stringify(role.modelBinding),
    budgetJson: JSON.stringify(role.budget),
    outputContractJson: JSON.stringify(role.outputContract),
    maxIterations: role.maxIterations,
    isBuiltin: role.isBuiltin,
  };
}

function validate(role: Role): void {
  if (role.systemPrompt.trim() === '') {
    throw new ValidationError(
      'ROLE_PROMPT_EMPTY',
      `Role "${role.id}" has an empty system prompt.`,
      {
        roleId: role.id,
      },
    );
  }
  if (role.maxIterations < 1) {
    // CLAUDE.md: "No unbounded loops." A role is one of the places the cap is
    // declared, so a role without one is not saveable.
    throw new ValidationError(
      'ROLE_ITERATIONS_UNBOUNDED',
      `Role "${role.id}" must allow at least one iteration.`,
      { roleId: role.id, maxIterations: role.maxIterations },
    );
  }
  if (role.budget.maxTokens < 1 || role.budget.maxWallClockMs < 1) {
    throw new ValidationError(
      'ROLE_BUDGET_EMPTY',
      `Role "${role.id}" has a budget that permits no work.`,
      { roleId: role.id },
    );
  }
  if (role.toolAllowlist.includes('*')) {
    throw new ValidationError(
      'ROLE_ALLOWLIST_WILDCARD',
      `Role "${role.id}" grants every tool with "*". Grant tools individually, or a whole server with "server.*".`,
      { roleId: role.id },
    );
  }
}

export interface RoleRegistry {
  list: () => Role[];
  get: (id: string) => Role | undefined;
  /** Creates or replaces a role. Returns what was actually stored. */
  save: (role: Role) => Role;
  /** Narrower entry point for the common edit. Returns the updated role. */
  setToolAllowlist: (id: string, toolAllowlist: readonly string[]) => Role;
}

/**
 * Opens the workspace's roles, seeding the starter set on first use.
 *
 * Reads go to SQLite on every call rather than through a cached copy: a role's
 * allowlist is a security decision, and a stale cache of one is a grant the
 * user believes they revoked. The table is small and the read is a single
 * indexed statement.
 */
export function createRoleRegistry(db: Database.Database): RoleRegistry {
  if (rolesRepository.isEmpty(db)) {
    for (const role of STARTER_ROLES) {
      validate(role);
      rolesRepository.upsert(db, toRecord(role));
    }
  }

  const registry: RoleRegistry = {
    list: () => rolesRepository.list(db).map(toRole),

    get: (id) => {
      const record = rolesRepository.get(db, id);
      return record ? toRole(record) : undefined;
    },

    save: (role) => {
      validate(role);
      return toRole(rolesRepository.upsert(db, toRecord(role)));
    },

    setToolAllowlist: (id, toolAllowlist) => {
      const existing = registry.get(id);
      if (!existing) {
        throw new ValidationError('ROLE_NOT_FOUND', `No role with id "${id}".`, { roleId: id });
      }
      return registry.save({ ...existing, toolAllowlist: [...toolAllowlist] });
    },
  };

  return registry;
}
