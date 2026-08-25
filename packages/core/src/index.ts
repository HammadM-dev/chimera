// packages/core — engine, Governor, and agent runtime.
// Rest of the surface (Governor, engine, runtime) populated starting M2.
// See docs/ARCHITECTURE.md.
//
// The error taxonomy deliberately does NOT live here and is NOT re-exported.
// It is `@chimera/errors`, a leaf package, so that packages/providers and
// packages/tools can raise typed errors without importing packages/core — an
// edge docs/ARCHITECTURE.md section 3 forbids and
// scripts/check-package-boundaries.mjs enforces. Re-exporting it here would
// quietly recreate the second import path this move exists to close.
export { Governor, createGovernor, deny } from './governor/Governor.ts';
export type { GovernorMode } from './governor/Governor.ts';
export type {
  Authorized,
  AuthorizationResult,
  CallContext,
  CallPurpose,
  Denied,
  DenialCode,
  ModelCallAuthorization,
  ModelCallRequest,
  RequiredCapability,
  ToolCallAuthorization,
  ToolCallRequest,
} from './governor/types.ts';

export { createRoleRegistry, STARTER_ROLES } from './runtime/roleRegistry.ts';
export type {
  ModelBinding,
  ModelTier,
  OutputContract,
  Role,
  RoleBudget,
  RoleRegistry,
} from './runtime/roleRegistry.ts';

export {
  assemblePrompt,
  assembleSystemMessage,
  renderObservation,
} from './runtime/promptAssembly.ts';
export type {
  AssembleOptions,
  AssembledPrompt,
  InstructionSource,
  StepPlacement,
  ToolObservation,
  ToolSummary,
} from './runtime/promptAssembly.ts';

export { runAgentLoop, parseVerification } from './runtime/agentLoop.ts';
export type {
  AgentLoopDeps,
  AgentTask,
  Cancellation,
  LoopResult,
  LoopStatus,
  LoopStep,
  Verification,
} from './runtime/agentLoop.ts';

export {
  BUILTIN_SCHEMAS,
  enforceOutputContract,
  extractJson,
  repairInstruction,
} from './runtime/outputContract.ts';
export type {
  ContractAttempt,
  ContractResult,
  OnInvalid,
  OutputContractSpec,
} from './runtime/outputContract.ts';
export { validateAgainstSchema, describeViolations } from './runtime/jsonSchema.ts';
export type { SchemaViolation } from './runtime/jsonSchema.ts';

export {
  createCheckpointStore,
  idempotencyKeyFor,
  EMPTY_CHECKPOINT,
} from './runtime/checkpoint.ts';
export type {
  CheckpointStore,
  CompletedToolCall,
  NodeStatus,
  RunCheckpoint,
} from './runtime/checkpoint.ts';

export {
  createScratchpad,
  discardScratchpad,
  discardAllScratchpads,
} from './runtime/memory/scratchpad.ts';
export type { Scratchpad, ScratchpadEntry } from './runtime/memory/scratchpad.ts';
export { createWorkspaceFacts } from './runtime/memory/workspaceFacts.ts';
export type { WorkspaceFactsStore, FactSource } from './runtime/memory/workspaceFacts.ts';
export {
  assertMemoryAvailable,
  createVectorStore,
  VectorStoreUnavailableError,
} from './runtime/memory/vectorStore.ts';
export type {
  VectorStore,
  VectorSearchResult,
  MemoryConfig,
} from './runtime/memory/vectorStore.ts';

export { createTraceSink, NULL_TRACE_SINK } from './runtime/trace.ts';

// The swarm: a simulated population, an event dropped into it, and whatever
// they arrive at. See `swarm/simulate.ts` for why it has two fidelity modes.
export { NODE_KINDS } from './engine/nodeTypes.ts';
export { simulate, archetypeCountFor, distributionOf } from './swarm/simulate.ts';
export type {
  SwarmSpec,
  SwarmResult,
  SwarmMode,
  SimulateDeps,
  RoundReport,
  Distribution,
} from './swarm/simulate.ts';
export { grow, wire, propagate, movement, seededRandom } from './swarm/population.ts';
export type { Persona, Population, Stance, Tie } from './swarm/population.ts';
export type { TraceEvent, TraceSink, TraceSinkOptions } from './runtime/trace.ts';

export { estimate, describePreview, DEFAULT_MS_PER_ITERATION } from './governor/costPreview.ts';
export type {
  CostPreview,
  NodePreview,
  PreviewNode,
  PreviewOptions,
  PreviewWorkflow,
} from './governor/costPreview.ts';
export { BudgetLedger, costOf } from './governor/budget.ts';
export type { BudgetLimit, BudgetPolicy, Consumption } from './governor/budget.ts';
export { LimitTracker, NO_LIMITS } from './governor/limits.ts';
export type { LimitPolicy, LimitBreach } from './governor/limits.ts';
export { StallDetector, toolSignature, DEFAULT_STALL_POLICY } from './governor/stallDetector.ts';
export type { StallPolicy, IterationOutcome, StallVerdict } from './governor/stallDetector.ts';
export type { GovernorPolicy } from './governor/Governor.ts';
export { denialToError } from './governor/Governor.ts';

export { createSpendMeter } from './governor/spendMeter.ts';
export type { SpendMeter, SpendMeterOptions, SpendSnapshot } from './governor/spendMeter.ts';
export { finalizeRun, outcomeOf } from './runtime/runOutcome.ts';
export type { RunOutcome, RunStatus } from './runtime/runOutcome.ts';

export { RateLimiter, backoffDelayMs, DEFAULT_RATE_POLICY } from './governor/rateLimiter.ts';
export type { BucketPolicy, RateLimitPolicy, RateVerdict } from './governor/rateLimiter.ts';

export { runAutomation } from './engine/runAutomation.ts';
export type { RunAutomationDeps, RunOutcomeSummary, StepOutcome } from './engine/runAutomation.ts';
export { validateBrief, executionOrder } from './engine/runBrief.ts';
export { validateForSave } from './engine/validator.ts';
export { parseCron, nextFireAfter, firedInLastMinute, describeCron } from './triggers/cron.ts';
export type { CronFields } from './triggers/cron.ts';
export { validateTrigger, describeTrigger } from './triggers/types.ts';
export { checkCase, checkAssertion, readPath, parseOutput } from './evals/assertions.ts';
export { promptKey, cosine, lookup, remember, CACHE_OFF } from './runtime/promptCache.ts';
export type { CachePolicy, CachedAnswer } from './runtime/promptCache.ts';
export type { PromptCacheHook } from './runtime/agentLoop.ts';
export type {
  Assertion,
  AssertOp,
  AssertionResult,
  EvalCase,
  EvalOutcome,
} from './evals/assertions.ts';
export type { Trigger, TriggerProblem } from './triggers/types.ts';
export type { SaveContext, StepCapabilities } from './engine/validator.ts';
export type { RunBrief, BriefStep, BriefAttachment, BriefProblem } from './engine/runBrief.ts';

export { evaluateCondition, applyTransform } from './engine/nodeTypes.ts';
export type {
  NodeType,
  NodeConfig,
  ConditionConfig,
  LoopConfig,
  TransformConfig,
  ApprovalConfig,
} from './engine/nodeTypes.ts';
