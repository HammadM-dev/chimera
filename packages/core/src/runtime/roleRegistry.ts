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
  /** Names one of M2-8's BUILTIN_SCHEMAS. Null for free text. */
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
  /**
   * What to do when the output contract is not satisfied (M2-8). Optional
   * because `docs/WORKFLOW_SCHEMA.md` puts this on the *node*; a role-level
   * value is the default a node inherits when it does not state its own.
   */
  onInvalid?: 'repair_once' | 'repair_until_attempts' | 'fail';
  /**
   * True for an agent several others are meant to feed at once.
   *
   * The canvas refuses more than three of the same agent into one node — five
   * copies of the same reviewer cost five times as much and usually say the
   * same thing five times. An agent whose whole job is to take many things and
   * return one is the exception, and it says so here rather than being guessed
   * at from its name, because a user's own agent can be one too.
   */
  combinesMany: boolean;
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
    toolAllowlist: ['memory.recall'],
    modelBinding: { tier: 'frontier', preferredModel: null },
    budget: { ...DEFAULT_BUDGET, maxTokens: 100_000 },
    outputContract: { format: 'json', schemaId: 'plan' },
    maxIterations: 3,
    combinesMany: true,
    isBuiltin: true,
  },
  {
    id: 'researcher',
    name: 'Researcher',
    systemPrompt:
      'You answer questions from what you have read: the material you are given, and anything your tools return. When you are asked something the material does not cover, search for it, read the most promising results, and answer from those — you do not need to be handed a link first. Every claim carries where it came from. Say plainly which part of a question you could not settle, and do not refuse to answer for want of a citation when the answer is in front of you.',
    toolAllowlist: [
      'search.web',
      'http.request',
      'filesystem.readFile',
      'filesystem.listDirectory',
      'memory.*',
    ],
    modelBinding: { tier: 'balanced', preferredModel: null },
    budget: DEFAULT_BUDGET,
    outputContract: { format: 'text', schemaId: null },
    maxIterations: 12,
    combinesMany: false,
    isBuiltin: true,
  },
  {
    id: 'coder',
    name: 'Coder',
    systemPrompt:
      'You write and change code in the run workspace. You read the surrounding code before changing it and match its conventions. You run the project checks after a change and report failures rather than describing the change as done.',
    toolAllowlist: ['filesystem.*', 'shell.exec', 'memory.*'],
    modelBinding: { tier: 'frontier', preferredModel: null },
    budget: { ...DEFAULT_BUDGET, maxTokens: 400_000, maxWallClockMs: 20 * 60_000 },
    outputContract: { format: 'text', schemaId: null },
    maxIterations: 25,
    combinesMany: false,
    isBuiltin: true,
  },
  {
    id: 'reviewer',
    name: 'Reviewer',
    systemPrompt:
      'You review work against the task it was meant to do. You report only defects you can point at a line for, and you state what would fail rather than how the code feels. You change nothing.',
    // Read-only by construction: a reviewer that could edit would quietly
    // become the author of what it is reviewing.
    toolAllowlist: ['filesystem.readFile', 'filesystem.listDirectory', 'memory.recall'],
    modelBinding: { tier: 'frontier', preferredModel: null },
    budget: DEFAULT_BUDGET,
    outputContract: { format: 'json', schemaId: 'review' },
    maxIterations: 8,
    combinesMany: true,
    isBuiltin: true,
  },
  {
    id: 'qa',
    name: 'QA',
    systemPrompt:
      'You verify that work does what was asked by exercising it, not by reading it. You write and run checks, and you report the output you actually saw.',
    toolAllowlist: ['filesystem.*', 'shell.exec', 'memory.*'],
    modelBinding: { tier: 'balanced', preferredModel: null },
    budget: DEFAULT_BUDGET,
    outputContract: { format: 'json', schemaId: 'verification' },
    maxIterations: 15,
    combinesMany: true,
    isBuiltin: true,
  },
  {
    id: 'data-extractor',
    name: 'Data extractor',
    systemPrompt:
      'You pull structured records out of unstructured text. You copy values, you do not infer them: a field the source does not state is null, never a plausible guess.',
    toolAllowlist: ['filesystem.readFile', 'filesystem.listDirectory', 'memory.*'],
    modelBinding: { tier: 'cheap', preferredModel: null },
    budget: { ...DEFAULT_BUDGET, maxCostUsd: 0.5 },
    outputContract: { format: 'json', schemaId: 'extraction' },
    maxIterations: 5,
    combinesMany: false,
    isBuiltin: true,
  },
  {
    id: 'browser-operator',
    name: 'Browser operator',
    systemPrompt:
      'You operate a web browser to complete a stated task. You report what is on the page, and you stop and ask before any action that sends, buys, publishes, or deletes.',
    // The browser server arrives in M6. Declared now, matches nothing until then.
    // Plus search: an operator that can open any page and cannot find one is
    // waiting for a person to paste a URL, which is the job it was meant to do.
    toolAllowlist: ['browser.*', 'search.web'],
    modelBinding: { tier: 'frontier', preferredModel: null },
    budget: { ...DEFAULT_BUDGET, maxWallClockMs: 15 * 60_000 },
    outputContract: { format: 'text', schemaId: null },
    maxIterations: 20,
    combinesMany: false,
    isBuiltin: true,
  },
  {
    id: 'app-operator',
    name: 'App operator',
    systemPrompt: [
      'You do things in the apps somebody already uses — Gmail, Slack, Notion, Jira, Sheets, HubSpot, Stripe and several hundred others — through Composio.',
      '',
      'Work in this order, every time. Search for the tools that fit the job in plain words; there are thousands of them and their names cannot be guessed. Read what the search tells you: it says which apps are actually connected, what arguments each tool takes, and the mistakes people make with it. An app nobody has signed into cannot be used, and saying so plainly is the right answer — far better than forming a perfect call to an account that does not exist.',
      '',
      'Then act, using the exact slug and argument names the search returned rather than ones that seem likely.',
      '',
      'Anything that sends, posts, creates, buys or deletes is stopped in front of a person before it happens. That is not a formality to work around: state clearly what you are about to do and to whom, so the person approving knows what they are approving.',
    ].join('\n'),
    // Composio and nothing else. An operator that could also read the
    // filesystem or run a shell would be a much larger thing to trust with
    // somebody's mailbox, and none of it is needed to do this job.
    toolAllowlist: ['composio.*'],
    // `balanced`, which is what a role calls the middle tier. The workspace
    // settings call the same idea `standard`; the two vocabularies meet in
    // `resolveTier` and not before.
    modelBinding: { tier: 'balanced', preferredModel: null },
    budget: { ...DEFAULT_BUDGET, maxWallClockMs: 10 * 60_000 },
    outputContract: { format: 'text', schemaId: null },
    maxIterations: 15,
    combinesMany: false,
    isBuiltin: true,
  },
  {
    id: 'assistant',
    name: 'Assistant',
    systemPrompt:
      "You are the person's own assistant inside CHIMERA, and you can see everything this workspace holds: the automations they have built, the agents they have written, every run and what it cost, what has been remembered, the plugins and providers connected, and the folders they have granted. Look things up rather than guessing — you have tools for all of it, and an answer you invented about their own work is worse than saying you could not find it. When they ask for something to be built, automated or set up, design it with planAutomation and then tell them what you designed and why, in plain terms. You change nothing: you read, you explain, and you design. Talk like somebody who knows the workspace, not like a manual.",
    // Everything readable, nothing that writes. `search.web` and `http.request`
    // are here because a question about the user's own work often turns on
    // something outside it — what a provider charges now, whether a site they
    // scrape has changed.
    // `memory.recall`, not `memory.*`. The assistant reads this workspace and
    // writes nothing to it — a role test already enforces that only roles doing
    // the work may write memory, and it was right: an assistant quietly
    // recording notes during a conversation about the notes is a thing nobody
    // asked for and nobody would find.
    toolAllowlist: ['workspace.*', 'memory.recall', 'search.web', 'http.request'],
    modelBinding: { tier: 'frontier', preferredModel: null },
    budget: { ...DEFAULT_BUDGET, maxTokens: 150_000, maxCostUsd: 1 },
    outputContract: { format: 'text', schemaId: null },
    maxIterations: 10,
    combinesMany: false,
    isBuiltin: true,
  },
  {
    id: 'summariser',
    name: 'Summariser',
    systemPrompt:
      'You compress text without changing what it claims. You keep numbers, names, and caveats exactly as stated, and you drop repetition rather than detail.',
    toolAllowlist: ['memory.recall'],
    modelBinding: { tier: 'cheap', preferredModel: null },
    budget: { ...DEFAULT_BUDGET, maxTokens: 100_000, maxCostUsd: 0.5 },
    outputContract: { format: 'text', schemaId: null },
    // Four, not two. A role with a JSON contract is checked by its schema and
    // is done the moment the shape is right; a role that produces prose has
    // only a model's opinion to go on, and at two iterations one adverse
    // opinion is the whole budget. Observed live: the same summariser, on the
    // same input, succeeded and then exhausted on consecutive runs. Summarising
    // is the cheapest thing this app does, so the extra room costs almost
    // nothing and buys the difference between working and mostly working.
    maxIterations: 4,
    combinesMany: true,
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
    combinesMany: record.combinesMany,
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
    combinesMany: role.combinesMany,
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
  /**
   * Deletes an agent the user made.
   *
   * A shipped one cannot be deleted — an automation somebody saved refers to it
   * by id, and a roster that could lose `summariser` would break files that
   * were working. Editing a shipped one is allowed; removing it is not.
   */
  remove: (id: string) => { removed: boolean; reason: string };
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

    remove: (id) => {
      const existing = registry.get(id);
      if (!existing) return { removed: false, reason: `No agent called "${id}".` };
      if (existing.isBuiltin) {
        return {
          removed: false,
          reason: `${existing.name} is one of the agents CHIMERA ships. You can change it, but automations refer to it by name, so it cannot be deleted.`,
        };
      }
      return { ...rolesRepository.remove(db, id), reason: '' };
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
