import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { DragEvent, JSX } from 'react';
import {
  Background,
  BaseEdge,
  Controls,
  EdgeLabelRenderer,
  Handle,
  Position,
  getSmoothStepPath,
  ConnectionLineType,
  MarkerType,
  ReactFlow,
  ReactFlowProvider,
  addEdge,
  useEdgesState,
  useNodesState,
  useReactFlow,
  type Connection,
  type Edge,
  type EdgeProps,
  type Node,
  type NodeProps,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { AGENT_GROUPS, useRoles, type AgentRole } from './useRoles.ts';
import { useConnections, type ModelChoice } from './useConnections.ts';
import { bridge, describeError } from '../chat/useChimera.ts';
import './canvas.css';

// The automation canvas. Drag an agent out of the palette, drop it where you
// want it, join it to the next one, and click it to choose which model runs it.
//
// A list could express the same sequence and could not express a fan-out, a
// branch, or a join — and those are the shapes real automations take. The graph
// is the product's vocabulary, so it is on screen from the first step rather
// than hidden behind a mode.

export type StepKind =
  | 'agent'
  | 'condition'
  | 'loop'
  | 'transform'
  | 'approval'
  | 'subworkflow'
  | 'fanout'
  | 'aggregate'
  | 'team';

/**
 * Everything the shaping node types need, in one flat shape.
 *
 * Flat rather than a discriminated union in component state: a user who places
 * a branch, fills its test in, and changes their mind about the node type
 * should not lose what they typed. Only the fields belonging to the current
 * kind are read when the brief is built.
 */
export interface StepSettings {
  /** Condition: whose output to test. Empty means the step before it. */
  source: string;
  test: 'contains' | 'equals' | 'matches' | 'isEmpty' | 'notEmpty';
  value: string;
  /** Transform: a template with `{{step-id}}` placeholders. */
  template: string;
  /** Approval: what the person approving is asked. */
  prompt: string;
  showSource: string;
  /** Loop: the bound CLAUDE.md requires every loop to declare. */
  maxIterations: number;
  /** Subworkflow: the saved automation this step runs. */
  workflowId: string;
  /** Fan-out: how many items at a time, and how many at most. */
  concurrency: number;
  maxItems: number;
  parse: 'json' | 'lines';
  onItemError: 'continue' | 'halt';
  deadLetterLimit: number;
  /** Aggregate: how many answers become one, and how. */
  strategy: 'concat' | 'json_merge' | 'reduce_with_agent' | 'vote' | 'template';
  separator: string;
  chunkSize: number;
  /** Team: the goal, who leads, who works, and the three ways it stops. */
  goal: string;
  orchestratorRoleId: string;
  agents: { roleId: string; instruction: string }[];
  maxRounds: number;
  maxConcurrentAgents: number;
  stallRounds: number;
  /** Empty means no goal test — the rounds and the stall rule still bound it. */
  goalContains: string;
}

const DEFAULT_SETTINGS: StepSettings = {
  source: '',
  test: 'contains',
  value: '',
  template: '{{previous}}',
  prompt: '',
  showSource: '',
  maxIterations: 3,
  workflowId: '',
  concurrency: 5,
  maxItems: 100,
  parse: 'json',
  onItemError: 'continue',
  deadLetterLimit: 10,
  strategy: 'concat',
  separator: '',
  chunkSize: 10,
  goal: '',
  orchestratorRoleId: 'planner',
  agents: [],
  maxRounds: 3,
  maxConcurrentAgents: 5,
  stallRounds: 2,
  goalContains: '',
};

export interface StepNodeData extends Record<string, unknown> {
  kind: StepKind;
  /** The agent. Null for the shaping types, which make no model call. */
  role: AgentRole | null;
  /** `connectionId::model`, or null while the step is still unbound. */
  binding: ModelChoice | null;
  /**
   * Run on whatever this workspace calls this tier, instead of a named model.
   *
   * An automation built on tiers is one that runs on somebody else's machine
   * without an edit — which is the difference between a template you can ship
   * and a template that only works here.
   */
  tier?: 'cheap' | 'standard' | 'frontier';
  /** Live run state: running, succeeded, denied… Empty when idle. */
  status?: string;
  /**
   * What this agent is told to do in *this* automation.
   *
   * Separate from the role's system prompt, which says what the agent is. A
   * researcher is a researcher in every automation; what it researches is this
   * step's business, and putting the two in one field would mean editing the
   * role every time you reused it.
   */
  instruction: string;
  settings: StepSettings;
}

type StepNode = Node<StepNodeData>;

const KIND_LABEL: Record<StepKind, string> = {
  agent: 'Agent',
  condition: 'Branch',
  loop: 'Loop',
  transform: 'Reshape',
  approval: 'Approval',
  subworkflow: 'Automation',
  fanout: 'Fan out',
  aggregate: 'Combine',
  team: 'Team',
};

const KIND_BLURB: Record<Exclude<StepKind, 'agent'>, string> = {
  condition: 'Sends the run one way or the other',
  loop: 'Repeats the steps below it, a set number of times',
  transform: 'Joins earlier answers together, without a model',
  approval: 'Pauses until a person says yes',
  subworkflow: 'Runs another saved automation here',
  fanout: 'Runs the steps below it once per item, several at a time',
  aggregate: 'Turns many answers into one',
  team: 'A team of agents on one goal, through a shared board',
};

const STRATEGY_LABEL: Record<StepSettings['strategy'], string> = {
  concat: 'One after another',
  json_merge: 'Merged as JSON',
  reduce_with_agent: 'Folded by an agent',
  vote: 'The most common answer',
  template: 'Into a template',
};

/**
 * Everything on the Flow section of the palette, in the order people reach for
 * them.
 *
 * `satisfies` against the node-type union rather than a hand-written array of
 * strings: a type added to the union and left out of the palette is a node type
 * nobody can place, and that shipped twice before this line existed. It is
 * still possible to *omit* one here — the compiler cannot demand completeness
 * without demanding an order — so `canvas.spec.ts` asserts every kind has a
 * button.
 */
const FLOW_KINDS = [
  'condition',
  'loop',
  'fanout',
  'aggregate',
  'team',
  'transform',
  'approval',
  'subworkflow',
] as const satisfies readonly Exclude<StepKind, 'agent'>[];

/** The one line a shaping node shows about what it will do. */
function summarise(data: StepNodeData): string {
  const settings = data.settings;
  switch (data.kind) {
    case 'condition':
      return settings.test === 'isEmpty' || settings.test === 'notEmpty'
        ? `${settings.source === '' ? 'previous' : settings.source} is ${settings.test === 'isEmpty' ? 'empty' : 'not empty'}`
        : `${settings.source === '' ? 'previous' : settings.source} ${settings.test} "${settings.value}"`;
    case 'loop':
      return `Up to ${String(settings.maxIterations)} times`;
    case 'transform':
      return settings.template === '' ? 'No template' : settings.template;
    case 'approval':
      return settings.prompt === '' ? 'No question yet' : settings.prompt;
    case 'subworkflow':
      return settings.workflowId === '' ? 'No automation chosen' : settings.workflowId;
    case 'fanout':
      return `${String(settings.concurrency)} at a time, up to ${String(settings.maxItems)}`;
    case 'aggregate':
      return STRATEGY_LABEL[settings.strategy];
    case 'team':
      return settings.agents.length === 0
        ? 'No specialists yet'
        : `${String(settings.agents.length)} specialists, up to ${String(settings.maxRounds)} rounds`;
    default:
      return '';
  }
}

/** One agent step. Shows the two facts that decide what it will do: who, and on what. */
function AgentNodeBody({ data, selected }: NodeProps<StepNode>): JSX.Element {
  const { role, binding, status } = data;

  return (
    <div
      className={`node ${selected === true ? 'node--selected' : ''}`}
      data-testid={`node-${role?.id ?? 'agent'}`}
    >
      {/* Inputs on the left, outputs on the right. A node can take as many of
          each as the graph needs — the old one-in-one-out arrangement could
          only express a line, and the shapes real automations take are joins
          and splits. */}
      <Handle type="target" position={Position.Left} className="node__port node__port--in" />
      <div className="node__head">
        <p className="node__name">{role?.name ?? 'Agent'}</p>
        {typeof status === 'string' && status !== '' && (
          <span className={`node__status node__status--${status}`} title={status} />
        )}
      </div>
      <p
        className={`node__model ${binding === null && data.tier === undefined ? 'node__model--unset' : ''}`}
      >
        {data.tier !== undefined
          ? `${data.tier} tier`
          : binding === null
            ? 'No model chosen'
            : binding.model}
      </p>
      <p className="node__tools">
        {typeof status === 'string' && status !== ''
          ? status
          : countOf(role?.toolAllowlist.length ?? 0, 'tool', 'No tools')}
      </p>
      <Handle type="source" position={Position.Right} className="node__port node__port--out" />
    </div>
  );
}

/**
 * One shaping step.
 *
 * A branch gets two source ports, labelled, because which line means "yes" is
 * the single thing a reader of somebody else's automation most needs to know,
 * and an unlabelled pair of lines makes them guess.
 */
function ShapingNodeBody({ data, selected }: NodeProps<StepNode>): JSX.Element {
  const { kind, status } = data;

  return (
    <div
      className={`node node--shaping node--${kind} ${selected === true ? 'node--selected' : ''}`}
      data-testid={`node-${kind}`}
    >
      <Handle type="target" position={Position.Left} className="node__port node__port--in" />
      <div className="node__head">
        <p className="node__name">{KIND_LABEL[kind]}</p>
        {typeof status === 'string' && status !== '' && (
          <span className={`node__status node__status--${status}`} title={status} />
        )}
      </div>
      <p className="node__model">{summarise(data)}</p>
      {typeof status === 'string' && status !== '' && <p className="node__tools">{status}</p>}
      {kind === 'condition' ? (
        <>
          <span className="node__portLabel node__portLabel--true">yes</span>
          <span className="node__portLabel node__portLabel--false">no</span>
          <Handle
            id="true"
            type="source"
            position={Position.Right}
            className="node__port node__port--out node__port--true"
            style={{ top: '35%' }}
          />
          <Handle
            id="false"
            type="source"
            position={Position.Right}
            className="node__port node__port--out node__port--false"
            style={{ top: '70%' }}
          />
        </>
      ) : (
        <Handle type="source" position={Position.Right} className="node__port node__port--out" />
      )}
    </div>
  );
}

/**
 * A join, with a way to undo it.
 *
 * There was none. A line drawn between two steps could not be removed by any
 * means the interface offered — no click target, no key, no menu — so a graph
 * was only ever addable-to, and one mistaken drag meant starting the
 * automation again. The button appears on hover or when the edge is selected,
 * so a finished graph stays quiet.
 */
function DeletableEdge({
  id,
  sourceX,
  sourceY,
  targetX,
  targetY,
  sourcePosition,
  targetPosition,
  markerEnd,
  selected,
}: EdgeProps): JSX.Element {
  const [path, labelX, labelY] = getSmoothStepPath({
    sourceX,
    sourceY,
    targetX,
    targetY,
    sourcePosition,
    targetPosition,
  });
  const { setEdges } = useReactFlow();

  return (
    <>
      <BaseEdge id={id} path={path} markerEnd={markerEnd} />
      <EdgeLabelRenderer>
        <button
          type="button"
          className={`edge__cut ${selected === true ? 'edge__cut--on' : ''}`}
          style={{
            transform: `translate(-50%, -50%) translate(${String(labelX)}px, ${String(labelY)}px)`,
          }}
          data-testid={`edge-remove-${id}`}
          title="Remove this join"
          aria-label="Remove this join"
          onClick={(event) => {
            event.stopPropagation();
            setEdges((current) => current.filter((edge) => edge.id !== id));
          }}
        >
          ×
        </button>
      </EdgeLabelRenderer>
    </>
  );
}

const EDGE_TYPES = { deletable: DeletableEdge };

const NODE_TYPES = {
  agent: AgentNodeBody,
  condition: ShapingNodeBody,
  loop: ShapingNodeBody,
  transform: ShapingNodeBody,
  approval: ShapingNodeBody,
  subworkflow: ShapingNodeBody,
  fanout: ShapingNodeBody,
  aggregate: ShapingNodeBody,
  team: ShapingNodeBody,
};

let nodeSeq = 0;

/* ---- where a step goes --------------------------------------------------
 *
 * Steps used to be dropped along a diagonal — each one 24px right and 72px
 * down from the last — which overlapped as soon as there were three, and
 * carried on drifting off the canvas because the counter never reset. A graph
 * you have to untangle before you can read it is a graph nobody trusts.
 *
 * Both halves below work on one grid: columns are the order things run in,
 * rows are the things that run at the same time. */
/** How long the canvas waits, after the last join, before arranging itself. */
const TIDY_SETTLE_MS = 450;

/**
 * How much of a fetched page an automation reads, unless it says otherwise.
 *
 * Roughly ten thousand tokens of text. Kept as a default a person can change
 * rather than a limit they cannot: an automation reading contracts wants more,
 * one checking headlines wants far less.
 */
const DEFAULT_PAGE_CHARS = 40_000;
/** Bytes. The same figure `packages/tools` defaults to, and the same reason: a default, not a ceiling. */
const DEFAULT_FILE_BYTES = 1_000_000;

const COLUMN_PITCH = 264;
const ROW_PITCH = 108;
const ORIGIN_X = 48;
const ORIGIN_Y = 40;

/** The first grid slot no existing step is sitting on. */
function freeSlot(placed: { position: { x: number; y: number } }[]): { x: number; y: number } {
  for (let slot = 0; slot < 240; slot += 1) {
    const x = ORIGIN_X + Math.floor(slot / 4) * COLUMN_PITCH;
    const y = ORIGIN_Y + (slot % 4) * ROW_PITCH;
    const taken = placed.some(
      (node) =>
        Math.abs(node.position.x - x) < COLUMN_PITCH - 40 &&
        Math.abs(node.position.y - y) < ROW_PITCH - 24,
    );
    if (!taken) return { x, y };
  }
  return { x: ORIGIN_X, y: ORIGIN_Y };
}

/**
 * Every step laid out left to right in the order it can run.
 *
 * A step's column is the longest path to it from a step with no inputs, so
 * anything that has to wait sits to the right of what it waits for, and
 * anything that can run at the same time shares a column. Columns are centred
 * against each other so a fan-out reads as a fan rather than a staircase.
 *
 * Cycles are possible — a loop node can feed a step that feeds it back — so
 * the walk remembers what it is already inside and stops rather than
 * recursing forever.
 */
function tidyPositions(
  steps: { id: string; position: { x: number; y: number } }[],
  links: { source: string; target: string }[],
): Map<string, { x: number; y: number }> {
  const inputs = new Map<string, string[]>();
  for (const step of steps) inputs.set(step.id, []);
  for (const link of links) {
    if (!inputs.has(link.target) || !inputs.has(link.source)) continue;
    inputs.get(link.target)?.push(link.source);
  }

  const column = new Map<string, number>();
  const depthOf = (id: string, visiting: Set<string>): number => {
    const settled = column.get(id);
    if (settled !== undefined) return settled;
    if (visiting.has(id)) return 0;
    visiting.add(id);
    const feeders = inputs.get(id) ?? [];
    const depth =
      feeders.length === 0 ? 0 : Math.max(...feeders.map((from) => depthOf(from, visiting) + 1));
    visiting.delete(id);
    column.set(id, depth);
    return depth;
  };

  const columns = new Map<number, string[]>();
  for (const step of [...steps].sort((a, b) => a.position.y - b.position.y)) {
    const depth = depthOf(step.id, new Set());
    columns.set(depth, [...(columns.get(depth) ?? []), step.id]);
  }

  const tallest = Math.max(1, ...[...columns.values()].map((members) => members.length));
  const layout = new Map<string, { x: number; y: number }>();
  for (const [depth, members] of columns) {
    const offset = ((tallest - members.length) * ROW_PITCH) / 2;
    members.forEach((id, row) => {
      layout.set(id, {
        x: ORIGIN_X + depth * COLUMN_PITCH,
        y: ORIGIN_Y + offset + row * ROW_PITCH,
      });
    });
  }
  return layout;
}

/** "1 tool", not "1 tools". */
function countOf(count: number, noun: string, none: string): string {
  if (count === 0) return none;
  return `${String(count)} ${noun}${count === 1 ? '' : 's'}`;
}

export interface Attachment {
  path: string;
  name: string;
  kind: 'text' | 'image' | 'binary';
  bytes: number;
  content: string;
  note: string;
}

export interface TemplateStep {
  id?: string;
  /**
   * Any node the canvas can build, not only the two the planner emits.
   *
   * It was `'agent' | 'approval'`, which was right for a plan a model writes
   * and wrong for a shipped template: an invoice run is a fan-out, a triage run
   * is a branch, and neither could be expressed. A template that cannot say
   * "do this for each of them" is a template for a demo.
   */
  kind?: StepKind;
  roleId: string;
  instruction: string;
  /** Per-kind settings: the fan-out's concurrency, the branch's test, the loop's cap. */
  settings?: Partial<StepSettings>;
}

export interface AutomationTemplate {
  name: string;
  summary: string;
  steps: TemplateStep[];
  /** [from, to] over step ids. Absent means the steps run in the order given. */
  edges?: [string, string][];
  /** Hosts this automation may send to. Reading the public web needs no list. */
  egressAllowlist?: string[];
  egressMode?: 'allowlist' | 'browse' | 'open';
}

/** The wire shape of one saved or runnable step. */
interface BriefStepWire {
  nodeId: string;
  type?: StepKind;
  config?: Record<string, unknown>;
  tier?: 'cheap' | 'standard' | 'frontier';
  roleId: string;
  instruction: string;
  connectionId: string;
  model: string;
}

/** What starts this automation when nobody presses Run. */
type TriggerWire =
  | { kind: 'manual' }
  | { kind: 'schedule'; cron: string }
  | { kind: 'webhook'; token: string }
  | { kind: 'fileWatch'; path: string }
  | { kind: 'folderDrop'; path: string };

const TRIGGER_LABEL: Record<TriggerWire['kind'], string> = {
  manual: 'When you press Run',
  schedule: 'On a schedule',
  webhook: 'When something posts to a URL',
  fileWatch: 'When anything in a folder changes',
  folderDrop: 'When a file lands in a folder',
};

/** One golden case: what the automation is told, and what has to come back. */
interface EvalCaseWire {
  id: string;
  name: string;
  input: string;
  scriptedAnswer: string;
  assertions: { path: string; op: string; value: string }[];
}

interface EvalOutcomeWire {
  caseId: string;
  name: string;
  passed: boolean;
  runProblem: string;
  results: { passed: boolean; actual: string; assertion: { path: string; value: string } }[];
}

interface PendingApproval {
  nodeId: string;
  prompt: string;
  context: string;
}

interface AwaitingApproval extends PendingApproval {
  runId: string;
}

function CanvasInner({
  goal,
  template,
  openId = null,
  onSaved,
  onBuildAgent,
  rolesToken = 0,
}: CanvasProps): JSX.Element {
  const roles = useRoles(rolesToken);
  const { choices, loaded } = useConnections();
  const [nodes, setNodes, onNodesChange] = useNodesState<StepNode>([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [paletteOpen, setPaletteOpen] = useState(true);
  const [inspectorOpen, setInspectorOpen] = useState(true);

  // Clicking a step is asking what it does, so the panel that answers comes
  // back whether or not it was folded. Folding it is a request for room on the
  // canvas, not a decision never to see the settings again — and a person who
  // folds it, clicks a step, and gets nothing has found a bug, not a preference.
  useEffect(() => {
    if (selectedId !== null) setInspectorOpen(true);
  }, [selectedId]);
  const [brief, setBrief] = useState(goal);
  const [briefOpen, setBriefOpen] = useState(true);
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [attachNote, setAttachNote] = useState('');
  const [sites, setSites] = useState('');
  const [egressMode, setEgressMode] = useState<'allowlist' | 'browse' | 'open'>('browse');
  const [pageChars, setPageChars] = useState(DEFAULT_PAGE_CHARS);
  const [fileBytes, setFileBytes] = useState(DEFAULT_FILE_BYTES);
  const [triggers, setTriggers] = useState<TriggerWire[]>([]);
  const [evals, setEvals] = useState<EvalCaseWire[]>([]);
  const [evalOutcomes, setEvalOutcomes] = useState<EvalOutcomeWire[]>([]);
  const [checking, setChecking] = useState(false);
  const [webhookPort, setWebhookPort] = useState(0);
  const appliedTemplate = useRef<AutomationTemplate | null>(null);
  const [runId, setRunId] = useState<string | null>(null);
  const [stepStatus, setStepStatus] = useState<Record<string, string>>({});
  const [stepOutput, setStepOutput] = useState<Record<string, string>>({});
  const [resultOpen, setResultOpen] = useState(false);
  const [runNote, setRunNote] = useState('');
  const [runOutput, setRunOutput] = useState('');
  const [pending, setPending] = useState<PendingApproval | null>(null);
  const [approvalNote, setApprovalNote] = useState('');
  const [saved, setSaved] = useState<{ id: string; name: string }[]>([]);
  const [problems, setProblems] = useState<{ nodeId: string | null; message: string }[]>([]);
  const [preauthorised, setPreauthorised] = useState<string[]>([]);
  const [savedId, setSavedId] = useState<string | null>(null);
  const [name, setName] = useState('Untitled automation');
  const wrapper = useRef<HTMLDivElement | null>(null);
  const { screenToFlowPosition, fitView } = useReactFlow();

  const addStep = useCallback(
    (kind: StepKind, role: AgentRole | null, dropped: { x: number; y: number } | null) => {
      nodeSeq += 1;
      const id = `${role?.id ?? kind}-${String(nodeSeq)}`;
      setNodes((current) => [
        ...current,
        {
          id,
          type: kind,
          // Dropped where the pointer let go; clicked, into the first free
          // slot on the grid, worked out against what is already there.
          position: dropped ?? freeSlot(current),
          data: {
            kind,
            role,
            // Left unset rather than defaulted to the first model that happens
            // to exist: a step silently bound to a model nobody chose is how a
            // run ends up on the wrong provider.
            binding: null,
            instruction: '',
            settings: { ...DEFAULT_SETTINGS },
          },
        },
      ]);
      setSelectedId(id);
      // Bring it into view. `fitView` runs once on mount, so a node placed
      // afterwards can land below the fold — present, selectable by the app,
      // and unreachable by a person, which is exactly how it failed its test.
      requestAnimationFrame(() => {
        void fitView({ padding: 0.3, duration: 200 });
      });
    },
    [setNodes, fitView],
  );

  // A template from the planner becomes real nodes, joined in order. Applied
  // once — re-applying on every render would duplicate the graph each time the
  // roster refreshed, and applied only after the roster loads, because a step
  // naming an agent that has not arrived yet cannot be built.
  useEffect(() => {
    if (!template || roles.length === 0 || appliedTemplate.current === template) return;
    appliedTemplate.current = template;

    // The plan is a graph, so it is built as one. It used to be joined end to
    // end whatever it said, which turned every design — including the ones
    // that ran three things at once and combined them — into a straight line.
    const built: StepNode[] = [];
    const nodeIdFor = new Map<string, string>();

    template.steps.forEach((step, index) => {
      const kind: StepKind = step.kind ?? 'agent';
      const isAgent = kind === 'agent';
      const role = isAgent
        ? (roles.find((candidate) => candidate.id === step.roleId) ?? null)
        : null;
      // A template naming an agent this workspace does not have is skipped
      // rather than built empty — the same rule the planner's output follows.
      if (isAgent && role === null) return;

      nodeSeq += 1;
      const nodeId = `${isAgent ? role?.id : kind}-${String(nodeSeq)}`;
      nodeIdFor.set(step.id ?? `step-${String(index)}`, nodeId);
      built.push({
        id: nodeId,
        type: kind,
        position: { x: ORIGIN_X + index * COLUMN_PITCH, y: ORIGIN_Y },
        data: {
          kind,
          role,
          binding: null,
          instruction: isAgent ? step.instruction : '',
          settings: {
            ...DEFAULT_SETTINGS,
            ...(kind === 'approval' ? { prompt: step.instruction } : {}),
            ...(step.settings ?? {}),
          },
        },
      });
    });

    const planned = (template.edges ?? [])
      .map(([from, to]) => [nodeIdFor.get(from), nodeIdFor.get(to)])
      .filter((pair): pair is [string, string] => pair[0] !== undefined && pair[1] !== undefined);

    // No edges offered means the plan was written as a list, and a list runs in
    // the order it was written.
    const joins: [string, string][] =
      planned.length > 0
        ? planned
        : built.slice(1).map((node, index) => [built[index]?.id ?? '', node.id]);

    setNodes(built);
    setEdges(
      joins.map(([from, to]) => ({
        id: `edge-${from}-${to}`,
        source: from,
        target: to,
        type: 'deletable',
        markerEnd: { type: MarkerType.ArrowClosed, width: 14, height: 14 },
      })),
    );

    // Laid out in the order it runs rather than in a row, so a plan with three
    // parallel branches arrives looking like three parallel branches.
    const layout = tidyPositions(
      built,
      joins.map(([source, target]) => ({ source, target })),
    );
    setNodes(built.map((node) => ({ ...node, position: layout.get(node.id) ?? node.position })));

    if (template.egressMode !== undefined) setEgressMode(template.egressMode);
    if (template.egressAllowlist !== undefined) setSites(template.egressAllowlist.join(', '));
    setBrief(template.summary);
    setSelectedId(built[0]?.id ?? null);
    requestAnimationFrame(() => {
      void fitView({ padding: 0.24, maxZoom: 1 });
    });
  }, [template, roles, setNodes, setEdges, fitView]);

  // Restoring a saved automation: nodes back where they were, with their
  // instructions and bindings, and the brief and attachments as they were left.
  useEffect(() => {
    if (openId === null || openId === savedId || roles.length === 0) return;
    void (async () => {
      try {
        const loaded = await bridge().invoke<{
          id: string;
          name: string;
          definition: {
            instruction: string;
            attachments: Attachment[];
            steps: BriefStepWire[];
            edges: [string, string][];
            egressAllowlist?: string[];
            egressMode?: 'allowlist' | 'browse' | 'open';
            maxPageChars?: number;
            maxFileBytes?: number;
            triggers?: TriggerWire[];
            evals?: EvalCaseWire[];
            layout?: { nodeId: string; x: number; y: number }[];
          };
        }>('workflow:get', { id: openId });

        const restored: StepNode[] = [];
        // Which side of a branch each edge came off, recovered from the saved
        // condition rather than from the edge list — the wire format carries
        // edges as plain pairs, and the yes/no distinction lives in the config.
        const falseBranch = new Set<string>();

        loaded.definition.steps.forEach((step, index) => {
          const kind = step.type ?? 'agent';
          const role = roles.find((candidate) => candidate.id === step.roleId) ?? null;
          if (kind === 'agent' && role === null) return;
          const at = loaded.definition.layout?.find((entry) => entry.nodeId === step.nodeId);
          const settings = { ...DEFAULT_SETTINGS };

          const config = step.config;
          if (config && config['type'] === 'condition') {
            const condition = config['condition'] as {
              source: string;
              test: StepSettings['test'];
              value: string;
              whenFalse: string[];
            };
            settings.source = condition.source;
            settings.test = condition.test;
            settings.value = condition.value;
            for (const target of condition.whenFalse) {
              falseBranch.add(`${step.nodeId}->${target}`);
            }
          } else if (config && config['type'] === 'loop') {
            settings.maxIterations = (config['loop'] as { maxIterations: number }).maxIterations;
          } else if (config && config['type'] === 'transform') {
            settings.template = (config['transform'] as { template: string }).template;
          } else if (config && config['type'] === 'team') {
            const team = config['team'] as {
              goal: string;
              orchestratorRoleId: string;
              agents: { roleId: string; instruction: string }[];
              maxRounds: number;
              maxConcurrentAgents: number;
              stallRounds: number;
              goalPredicate?: { value: string };
            };
            settings.goal = team.goal;
            settings.orchestratorRoleId = team.orchestratorRoleId;
            settings.agents = team.agents;
            settings.maxRounds = team.maxRounds;
            settings.maxConcurrentAgents = team.maxConcurrentAgents;
            settings.stallRounds = team.stallRounds;
            settings.goalContains = team.goalPredicate?.value ?? '';
          } else if (config && config['type'] === 'aggregate') {
            const aggregate = config['aggregate'] as {
              source: string;
              strategy: StepSettings['strategy'];
              separator: string;
              template: string;
              chunkSize: number;
            };
            settings.source = aggregate.source;
            settings.strategy = aggregate.strategy;
            settings.separator = aggregate.separator;
            settings.template = aggregate.template;
            settings.chunkSize = aggregate.chunkSize;
          } else if (config && config['type'] === 'fanout') {
            const fanout = config['fanout'] as {
              source: string;
              parse: 'json' | 'lines';
              concurrency: number;
              maxItems: number;
              onItemError: 'continue' | 'halt';
              deadLetterLimit: number;
            };
            settings.source = fanout.source;
            settings.parse = fanout.parse;
            settings.concurrency = fanout.concurrency;
            settings.maxItems = fanout.maxItems;
            settings.onItemError = fanout.onItemError;
            settings.deadLetterLimit = fanout.deadLetterLimit;
          } else if (config && config['type'] === 'subworkflow') {
            settings.workflowId = (config['subworkflow'] as { workflowId: string }).workflowId;
          } else if (config && config['type'] === 'approval') {
            const approval = config['approval'] as { prompt: string; showSource: string };
            settings.prompt = approval.prompt;
            settings.showSource = approval.showSource;
          }

          restored.push({
            id: step.nodeId,
            type: kind,
            position: {
              x: at?.x ?? ORIGIN_X + index * COLUMN_PITCH,
              y: at?.y ?? ORIGIN_Y,
            },
            data: {
              kind,
              role,
              instruction: step.instruction,
              settings,
              ...(step.tier === undefined ? {} : { tier: step.tier }),
              binding:
                step.model === ''
                  ? null
                  : {
                      key: `${step.connectionId}::${step.model}`,
                      connectionId: step.connectionId,
                      connectionLabel: '',
                      model: step.model,
                    },
            },
          });
        });

        setNodes(restored);
        setEdges(
          loaded.definition.edges.map(([from, to]) => ({
            id: `edge-${from}-${to}`,
            source: from,
            target: to,
            ...(falseBranch.has(`${from}->${to}`) ? { sourceHandle: 'false' } : {}),
            animated: true,
          })),
        );
        setBrief(loaded.definition.instruction);
        setSites((loaded.definition.egressAllowlist ?? []).join(', '));
        setEgressMode(loaded.definition.egressMode ?? 'browse');
        setPageChars(loaded.definition.maxPageChars ?? DEFAULT_PAGE_CHARS);
        setFileBytes(loaded.definition.maxFileBytes ?? DEFAULT_FILE_BYTES);
        setTriggers(loaded.definition.triggers ?? []);
        setEvals(loaded.definition.evals ?? []);
        setAttachments(loaded.definition.attachments);
        setName(loaded.name);
        setSavedId(loaded.id);
      } catch (err) {
        setRunNote(describeError(err).message);
      }
    })();
  }, [openId, savedId, roles, setNodes, setEdges]);

  const attach = useCallback(async (mode: 'files' | 'folder') => {
    try {
      const result = await bridge().invoke<{ attachments: Attachment[]; truncated: boolean }>(
        'files:pick',
        { mode },
      );
      if (result.attachments.length === 0) return;
      setAttachments((current) => [...current, ...result.attachments]);
      setAttachNote(result.truncated ? 'Folder attached up to the first 25 files.' : '');
    } catch (err) {
      setAttachNote(describeError(err).message);
    }
  }, []);

  // Live run events. Subscribed for the panel's lifetime; a listener attached
  // after `run:start` resolves would miss the first step.
  useEffect(() => {
    return bridge().on<{ runId: string; type: string; data: unknown }>('run:event', (event) => {
      if (event.runId !== runId) return;

      if (event.type.startsWith('step:')) {
        const detail = event.data as {
          nodeId: string;
          phase: string;
          outcome?: { status: string; output: string };
        };
        setStepStatus((current) => ({
          ...current,
          [detail.nodeId]:
            detail.phase === 'started' ? 'running' : (detail.outcome?.status ?? 'done'),
        }));
        // Kept as they arrive, not just at the end: a run that halts at step
        // four still did three steps of work, and the user should be able to
        // read it.
        if (detail.outcome && detail.outcome.output !== '') {
          setStepOutput((current) => ({
            ...current,
            [detail.nodeId]: detail.outcome?.output ?? '',
          }));
        }
      } else if (event.type === 'approval:requested') {
        setPending(event.data as PendingApproval);
        setApprovalNote('');
      } else if (event.type === 'finished') {
        const detail = event.data as { status: string; summary: string | null; output: string };
        setRunNote(detail.summary ?? `Run ${detail.status}.`);
        setRunOutput(detail.output);
        // Opened, not tucked away. The commonest complaint about the first
        // version of this was "it says succeeded and there is no output" — and
        // there was: at the bottom of a panel that scrolls, under the settings.
        setResultOpen(true);
        setPending(null);
        setRunId(null);
      } else if (event.type === 'failed') {
        setRunNote((event.data as { message: string }).message);
        setPending(null);
        setRunId(null);
        // Opened on failure too, and this is the important half: a run that
        // stopped is exactly when somebody needs to see what the steps before
        // it produced, and the first version showed them nothing at all.
        setResultOpen(true);
      }
    });
  }, [runId]);

  // The automations a subworkflow node can name. Loaded once: this is a picker
  // of things the user has already saved, not a live feed.
  useEffect(() => {
    void (async () => {
      try {
        const result = await bridge().invoke<{ workflows: { id: string; name: string }[] }>(
          'workflow:list',
          {},
        );
        setSaved(result.workflows);
      } catch {
        // An empty picker is the honest answer when nothing has been saved.
      }
    })();
  }, [savedId]);

  // A gate left open by a previous session. Asked for once, on mount: a run
  // that stopped for a person and then disappeared from the screen when the app
  // restarted would be the one failure an approval gate cannot afford.
  useEffect(() => {
    void (async () => {
      try {
        const result = await bridge().invoke<{ waiting: AwaitingApproval[] }>('run:awaiting', {});
        const first = result.waiting[0];
        if (!first) return;
        setRunId(first.runId);
        setPending({ nodeId: first.nodeId, prompt: first.prompt, context: first.context });
        await bridge().invoke('run:subscribe', { runId: first.runId });
      } catch {
        // A workspace with no runs answers this fine; anything else here is not
        // worth an error banner over a canvas the user has not used yet.
      }
    })();
  }, []);

  const answer = useCallback(
    async (approved: boolean) => {
      if (pending === null || runId === null) return;
      const asked = pending;
      setPending(null);
      try {
        await bridge().invoke('run:approve', {
          runId,
          nodeId: asked.nodeId,
          approved,
          note: approvalNote,
        });
      } catch (err) {
        setRunNote(describeError(err).message);
      }
    },
    [pending, runId, approvalNote],
  );

  const currentBrief = useCallback(() => {
    const steps: BriefStepWire[] = nodes.map((node) => {
      const outgoing = edges.filter((edge) => edge.source === node.id);
      const settings = node.data.settings;
      const base: BriefStepWire = {
        nodeId: node.id,
        type: node.data.kind,
        roleId: node.data.role?.id ?? '',
        instruction: node.data.instruction,
        connectionId: node.data.binding?.connectionId ?? '',
        model: node.data.binding?.model ?? '',
        ...(node.data.tier === undefined ? {} : { tier: node.data.tier }),
      };

      switch (node.data.kind) {
        case 'condition':
          return {
            ...base,
            config: {
              type: 'condition',
              condition: {
                source: settings.source,
                test: settings.test,
                value: settings.value,
                // Which port a line leaves from is the whole answer here, so
                // the user says "this happens if yes" by drawing rather than
                // by naming node ids nobody wants to type.
                whenTrue: outgoing
                  .filter((edge) => edge.sourceHandle !== 'false')
                  .map((edge) => edge.target),
                whenFalse: outgoing
                  .filter((edge) => edge.sourceHandle === 'false')
                  .map((edge) => edge.target),
              },
            },
          };
        case 'loop':
          return {
            ...base,
            config: {
              type: 'loop',
              loop: {
                body: outgoing.map((edge) => edge.target),
                maxIterations: settings.maxIterations,
              },
            },
          };
        case 'transform':
          return {
            ...base,
            config: { type: 'transform', transform: { template: settings.template } },
          };
        case 'approval':
          return {
            ...base,
            config: {
              type: 'approval',
              approval: { prompt: settings.prompt, showSource: settings.showSource },
            },
          };
        case 'team':
          return {
            ...base,
            config: {
              type: 'team',
              team: {
                goal: settings.goal,
                orchestratorRoleId: settings.orchestratorRoleId,
                agents: settings.agents,
                maxRounds: settings.maxRounds,
                maxConcurrentAgents: settings.maxConcurrentAgents,
                stallRounds: settings.stallRounds,
                ...(settings.goalContains === ''
                  ? {}
                  : {
                      goalPredicate: {
                        source: '',
                        test: 'contains' as const,
                        value: settings.goalContains,
                        whenTrue: [],
                        whenFalse: [],
                      },
                    }),
              },
            },
          };
        case 'aggregate':
          return {
            ...base,
            config: {
              type: 'aggregate',
              aggregate: {
                source: settings.source,
                strategy: settings.strategy,
                separator: settings.separator,
                template: settings.template,
                roleId: node.data.role?.id ?? 'summariser',
                chunkSize: settings.chunkSize,
                instruction: node.data.instruction,
              },
            },
          };
        case 'fanout':
          return {
            ...base,
            config: {
              type: 'fanout',
              fanout: {
                source: settings.source,
                parse: settings.parse,
                // Same as a loop: the steps joined below it are its body.
                body: outgoing.map((edge) => edge.target),
                concurrency: settings.concurrency,
                maxItems: settings.maxItems,
                onItemError: settings.onItemError,
                deadLetterLimit: settings.deadLetterLimit,
              },
            },
          };
        case 'subworkflow':
          return {
            ...base,
            config: {
              type: 'subworkflow',
              // Version left empty: the latest at the time of the run. Pinning
              // a specific one is a control this canvas does not have yet, and
              // an id nobody chose is worse than the newest.
              subworkflow: { workflowId: settings.workflowId, version: '' },
            },
          };
        default:
          return { ...base, config: { type: 'agent' } };
      }
    });

    return {
      name,
      instruction: brief,
      attachments: attachments.map((file) => ({
        name: file.name,
        path: file.path,
        kind: file.kind,
        content: file.content,
        note: file.note,
      })),
      steps,
      edges: edges.map((edge) => [edge.source, edge.target] as [string, string]),
      preauthorised,
      triggers,
      evals,
      // Hosts, not URLs. Under the default mode these are the places the
      // automation may *send* to; reading the public web needs no list.
      egressAllowlist: sites
        .split(',')
        .map((entry) => entry.trim())
        .filter((entry) => entry !== ''),
      egressMode,
      maxPageChars: pageChars,
      maxFileBytes: fileBytes,
      // Positions are not part of the run, but they are part of the thing the
      // user arranged. Losing the layout on reload would make saving feel like
      // it half-worked.
      layout: nodes.map((node) => ({ nodeId: node.id, x: node.position.x, y: node.position.y })),
    };
  }, [name, brief, attachments, nodes, edges, preauthorised, sites, triggers, evals]);

  // The rules that decide whether this can run, asked of the one place that
  // implements them. Duplicating them in the renderer would mean two rule sets
  // that agree until the day they do not.
  useEffect(() => {
    if (nodes.length === 0) {
      setProblems([]);
      return;
    }
    const timer = setTimeout(() => {
      void (async () => {
        try {
          const result = await bridge().invoke<{
            problems: { nodeId: string | null; message: string }[];
          }>('automation:check', { definition: currentBrief() });
          setProblems(result.problems);
        } catch {
          // A check that could not run is not a reason to block the canvas; the
          // save and run paths enforce the same rules and will say so.
        }
      })();
    }, 250);
    return () => {
      clearTimeout(timer);
    };
  }, [nodes, edges, preauthorised, currentBrief]);

  // Where a webhook actually lives, so the user can copy the URL. Asked after
  // a save, because that is when a trigger becomes armed.
  useEffect(() => {
    void (async () => {
      try {
        const result = await bridge().invoke<{ webhookPort: number }>('trigger:list', {});
        setWebhookPort(result.webhookPort);
      } catch {
        setWebhookPort(0);
      }
    })();
  }, [savedId]);

  const addTrigger = useCallback(async (kind: TriggerWire['kind']) => {
    if (kind === 'manual') return;
    if (kind === 'schedule') {
      setTriggers((current) => [...current, { kind, cron: '0 9 * * *' }]);
      return;
    }
    if (kind === 'webhook') {
      // Long and random. A short token is a URL somebody can guess, and the
      // thing on the other end of it starts an automation.
      const bytes = new Uint8Array(24);
      crypto.getRandomValues(bytes);
      const token = [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
      setTriggers((current) => [...current, { kind, token }]);
      return;
    }

    try {
      const picked = await bridge().invoke<{ path: string }>('files:pickDirectory', {});
      if (picked.path === '') return;
      setTriggers((current) => [...current, { kind, path: picked.path }]);
    } catch (err) {
      setRunNote(describeError(err).message);
    }
  }, []);

  const save = useCallback(async () => {
    try {
      const result = await bridge().invoke<{ id: string; version: number }>('workflow:save', {
        ...(savedId === null ? {} : { id: savedId }),
        name,
        definition: currentBrief(),
      });
      setSavedId(result.id);
      setRunNote(`Saved as version ${String(result.version)}.`);
      onSaved?.();
    } catch (err) {
      setRunNote(describeError(err).message);
    }
  }, [savedId, name, currentBrief, onSaved]);

  const runChecks = useCallback(async () => {
    if (savedId === null) {
      setRunNote('Save the automation first — a check runs against a saved version.');
      return;
    }
    setChecking(true);
    try {
      const report = await bridge().invoke<{ outcomes: EvalOutcomeWire[]; untested: boolean }>(
        'evals:run',
        { workflowId: savedId },
      );
      setEvalOutcomes(report.outcomes);
      if (report.untested) setRunNote('This automation has no checks yet.');
    } catch (err) {
      setRunNote(describeError(err).message);
    } finally {
      setChecking(false);
    }
  }, [savedId]);

  const tagProduction = useCallback(async () => {
    if (savedId === null) return;
    try {
      const result = await bridge().invoke<{ tagged: boolean; reason: string }>(
        'evals:tagProduction',
        { workflowId: savedId },
      );
      setRunNote(result.reason);
    } catch (err) {
      setRunNote(describeError(err).message);
    }
  }, [savedId]);

  const start = useCallback(async () => {
    setRunNote('');
    setRunOutput('');
    setStepStatus({});
    setStepOutput({});
    setResultOpen(false);
    setPending(null);
    try {
      const started = await bridge().invoke<{ runId: string }>('run:start', {
        brief: currentBrief(),
      });
      setRunId(started.runId);
      await bridge().invoke('run:subscribe', { runId: started.runId });
    } catch (err) {
      setRunNote(describeError(err).message);
    }
  }, [currentBrief]);

  // Why Run is unavailable, said rather than left to a greyed-out button. An
  // unexplained disabled control is the same dead end as no control at all.
  const agentNodes = nodes.filter((node) => node.data.kind === 'agent');
  // A subworkflow and a fan-out act too, by running agents of their own.
  const workNodes = nodes.filter((node) =>
    ['agent', 'subworkflow', 'fanout', 'team'].includes(node.data.kind),
  );
  const badShaping = nodes.find((node) => {
    const settings = node.data.settings;
    switch (node.data.kind) {
      case 'loop':
        return settings.maxIterations < 1 || !Number.isFinite(settings.maxIterations);
      case 'approval':
        return settings.prompt.trim() === '';
      case 'transform':
        return settings.template.trim() === '';
      case 'condition':
        return edges.every((edge) => edge.source !== node.id);
      case 'subworkflow':
        return settings.workflowId === '';
      case 'team':
        return (
          settings.goal.trim() === '' ||
          settings.agents.length === 0 ||
          settings.maxRounds < 1 ||
          node.data.binding === null
        );
      case 'aggregate':
        return (
          (settings.strategy === 'reduce_with_agent' &&
            (node.data.binding === null || settings.chunkSize < 1)) ||
          (settings.strategy === 'template' && settings.template.trim() === '')
        );
      case 'fanout':
        return (
          settings.maxItems < 1 ||
          settings.concurrency < 1 ||
          edges.every((edge) => edge.source !== node.id)
        );
      default:
        return false;
    }
  });

  const blocked =
    workNodes.length === 0
      ? 'Add an agent first.'
      : agentNodes.some((node) => node.data.binding === null && node.data.tier === undefined)
        ? 'Every agent needs a model.'
        : badShaping
          ? badShaping.data.kind === 'loop'
            ? 'A loop needs a maximum number of passes.'
            : badShaping.data.kind === 'approval'
              ? 'An approval needs a question to ask.'
              : badShaping.data.kind === 'transform'
                ? 'A reshape needs a template.'
                : badShaping.data.kind === 'team'
                  ? 'A team needs a goal, at least one specialist, a round limit and a model.'
                  : badShaping.data.kind === 'aggregate'
                    ? 'That combine step needs a model and a chunk size, or a template.'
                    : badShaping.data.kind === 'fanout'
                      ? 'A fan-out needs a maximum, a concurrency of at least one, and steps to run.'
                      : badShaping.data.kind === 'subworkflow'
                        ? 'Choose which automation that step runs.'
                        : 'A branch needs somewhere to go — join it to a step.'
          : agentNodes.length > 0 &&
              brief.trim() === '' &&
              agentNodes.every((node) => node.data.instruction.trim() === '')
            ? 'Write a brief, or give a step its own instruction.'
            : (problems[0]?.message ?? '');

  const onDrop = useCallback(
    (event: DragEvent<HTMLDivElement>) => {
      event.preventDefault();
      const position = screenToFlowPosition({ x: event.clientX, y: event.clientY });

      const kind = event.dataTransfer.getData('application/chimera-node');
      if (kind !== '') {
        addStep(kind as StepKind, null, position);
        return;
      }

      const roleId = event.dataTransfer.getData('application/chimera-role');
      const role = roles.find((candidate) => candidate.id === roleId);
      if (!role) return;
      addStep('agent', role, position);
    },
    [roles, addStep, screenToFlowPosition],
  );

  /* True once a step has been dragged. Up to that point the canvas keeps
   * itself in order as lines are drawn; after it, the arrangement is the
   * user's and moving their nodes out from under them would be rude. */
  const arrangedByHand = useRef(false);

  /** Pending layout, so a burst of joins settles into one arrangement. */
  const tidyTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  /** The edges as they are now, for a layout that runs after the last join. */
  const edgesRef = useRef(edges);
  edgesRef.current = edges;

  useEffect(
    () => () => {
      if (tidyTimer.current !== null) clearTimeout(tidyTimer.current);
    },
    [],
  );

  /**
   * A step is gone, and so is everything that referred to it.
   *
   * React Flow removes the node and its edges on its own. What it cannot know
   * about is the rest of this panel's state — the selection, the per-step
   * output from the last run, the pre-authorisation somebody granted — and a
   * pre-authorisation left behind under a reused node id would be a safety
   * decision surviving the step it was made about.
   */
  const onNodesDelete = useCallback(
    (removed: Node[]) => {
      const gone = new Set(removed.map((node) => node.id));
      setSelectedId((current) => (current !== null && gone.has(current) ? null : current));
      setPreauthorised((current) => current.filter((nodeId) => !gone.has(nodeId)));
      setStepOutput((current) =>
        Object.fromEntries(Object.entries(current).filter(([nodeId]) => !gone.has(nodeId))),
      );
      setStepStatus((current) =>
        Object.fromEntries(Object.entries(current).filter(([nodeId]) => !gone.has(nodeId))),
      );
    },
    [setSelectedId, setPreauthorised, setStepOutput, setStepStatus],
  );

  /** Removes one step by id, from the inspector's own button. */
  const removeStep = useCallback(
    (nodeId: string) => {
      setNodes((current) => current.filter((node) => node.id !== nodeId));
      setEdges((current) =>
        current.filter((edge) => edge.source !== nodeId && edge.target !== nodeId),
      );
      onNodesDelete([{ id: nodeId }] as Node[]);
    },
    [setNodes, setEdges, onNodesDelete],
  );

  const onConnect = useCallback(
    (connection: Connection) => {
      setEdges((current) =>
        addEdge(
          {
            ...connection,
            type: 'deletable',
            markerEnd: { type: MarkerType.ArrowClosed, width: 14, height: 14 },
          },
          current,
        ),
      );
      if (arrangedByHand.current) return;

      // Laid out once the drawing stops, not after every line.
      //
      // Re-tidying on each connect moves every node the instant an edge lands
      // — including the one the pointer is on its way to for the next join.
      // Somebody joining three steps in a row watched the graph jump twice
      // under their hand, and a test doing the same thing dropped its second
      // line on a node that was no longer there.
      if (tidyTimer.current !== null) clearTimeout(tidyTimer.current);
      tidyTimer.current = setTimeout(() => {
        tidyTimer.current = null;
        if (arrangedByHand.current) return;
        setNodes((current) => {
          const layout = tidyPositions(current, edgesRef.current);
          return current.map((node) => ({
            ...node,
            position: layout.get(node.id) ?? node.position,
          }));
        });
        void fitView({ padding: 0.24, maxZoom: 1 });
      }, TIDY_SETTLE_MS);
    },
    [setEdges, setNodes, fitView],
  );

  /**
   * Steps that can reach the web, when nothing is reachable.
   *
   * Not a reason to block the run — plenty of automations never touch a site —
   * but a reason to say so first. Hammad's researcher spent 101,848 tokens and
   * twelve iterations discovering it one refused host at a time.
   */
  const webSteps = useMemo(
    () =>
      sites.trim() !== ''
        ? []
        : nodes
            .filter((node) =>
              (node.data.role?.toolAllowlist ?? []).some(
                (tool) => tool.startsWith('http.') || tool.startsWith('browser.'),
              ),
            )
            .map((node) => node.data.role?.name ?? 'A step'),
    [nodes, sites],
  );
  const needsSites = webSteps.length > 0;

  const selected = nodes.find((node) => node.id === selectedId);

  const bind = useCallback(
    (value: string) => {
      // A tier and a model are the same choice made two ways, so they are one
      // control: picking either clears the other.
      const tier = value.startsWith('tier:')
        ? (value.slice(5) as 'cheap' | 'standard' | 'frontier')
        : undefined;
      const choice = tier === undefined ? (choices.find((c) => c.key === value) ?? null) : null;

      setNodes((current) =>
        current.map((node) =>
          node.id === selectedId
            ? {
                ...node,
                data: {
                  ...node.data,
                  binding: choice,
                  ...(tier === undefined ? { tier: undefined } : { tier }),
                },
              }
            : node,
        ),
      );
    },
    [choices, selectedId, setNodes],
  );

  /** Edits one field of the selected step's settings. */
  const setSetting = useCallback(
    <K extends keyof StepSettings>(key: K, value: StepSettings[K]) => {
      setNodes((current) =>
        current.map((node) =>
          node.id === selectedId
            ? { ...node, data: { ...node.data, settings: { ...node.data.settings, [key]: value } } }
            : node,
        ),
      );
    },
    [selectedId, setNodes],
  );

  const grouped = useMemo(() => {
    const placed = new Set(AGENT_GROUPS.flatMap((group) => group.ids));
    const groups = AGENT_GROUPS.map((group) => ({
      label: group.label,
      members: group.ids
        .map((id) => roles.find((role) => role.id === id))
        .filter((role): role is AgentRole => role !== undefined),
    }));

    // Anything not in a shipped group — which is every agent the user builds.
    // A palette that only showed the eight CHIMERA ships would make the "build
    // an agent" button a place to send work that never comes back.
    const mine = roles.filter((role) => !placed.has(role.id));
    if (mine.length > 0) groups.push({ label: 'Yours', members: mine });

    return groups.filter((group) => group.members.length > 0);
  }, [roles]);

  return (
    <div
      className="canvas"
      data-testid="canvas-view"
      data-palette={paletteOpen ? 'open' : 'closed'}
      data-inspector={inspectorOpen ? 'open' : 'closed'}
    >
      <aside
        className={`canvas__palette scroll${paletteOpen ? '' : ' canvas__panel--closed'}`}
        aria-label="Agents"
      >
        <button
          type="button"
          className="panel-toggle panel-toggle--palette"
          data-testid="palette-toggle"
          aria-expanded={paletteOpen}
          aria-label={paletteOpen ? 'Hide agents' : 'Show agents'}
          title={paletteOpen ? 'Hide agents' : 'Show agents'}
          onClick={() => {
            setPaletteOpen((open) => !open);
          }}
        >
          {paletteOpen ? '‹' : '›'}
        </button>
        <button
          type="button"
          className="palette__agent palette__agent--new"
          data-testid="palette-add-agent"
          onClick={onBuildAgent}
        >
          <span className="palette__name">Build an agent</span>
          <span className="palette__meta">One you write yourself</span>
        </button>
        <p className="canvas__hint">Drag an agent onto the canvas, or click to place one.</p>
        {grouped.map((group) => (
          <div key={group.label}>
            <p className="canvas__section">{group.label}</p>
            {group.members.map((role) => (
              <button
                key={role.id}
                type="button"
                className="palette__agent"
                data-testid={`palette-${role.id}`}
                draggable
                onDragStart={(event) => {
                  event.dataTransfer.setData('application/chimera-role', role.id);
                  event.dataTransfer.effectAllowed = 'move';
                }}
                onClick={() => {
                  // Click-to-place as well as drag. Dragging is the natural
                  // gesture and the only one some people can make comfortably;
                  // a canvas reachable by exactly one input is a canvas some
                  // users cannot use at all.
                  addStep('agent', role, null);
                }}
              >
                <span className="palette__name">{role.name}</span>
                <span className="palette__meta">
                  {role.tier} · {countOf(role.toolAllowlist.length, 'tool', 'no tools')}
                </span>
              </button>
            ))}
          </div>
        ))}

        <p className="canvas__section">Flow</p>
        {FLOW_KINDS.map((kind) => (
          <button
            key={kind}
            type="button"
            className="palette__agent palette__agent--flow"
            data-testid={`palette-${kind}`}
            draggable
            onDragStart={(event) => {
              event.dataTransfer.setData('application/chimera-node', kind);
              event.dataTransfer.effectAllowed = 'move';
            }}
            onClick={() => {
              addStep(kind, null, null);
            }}
          >
            <span className="palette__name">{KIND_LABEL[kind]}</span>
            <span className="palette__meta">{KIND_BLURB[kind]}</span>
          </button>
        ))}
      </aside>

      <div className="canvas__main">
        <div
          className="canvas__surface"
          ref={wrapper}
          onDragOver={(event) => {
            event.preventDefault();
            event.dataTransfer.dropEffect = 'move';
          }}
          onDrop={onDrop}
        >
          <ReactFlow
            // Live status is merged in at render rather than written into the
            // node data, so a run cannot dirty the graph the user is editing.
            nodes={nodes.map((node) => ({
              ...node,
              data: { ...node.data, status: stepStatus[node.id] ?? '' },
            }))}
            edges={edges}
            nodeTypes={NODE_TYPES}
            edgeTypes={EDGE_TYPES}
            // Both keys: Delete is what a Windows or Linux user reaches for,
            // Backspace is what a Mac user reaches for, and a canvas that
            // honours one of them is broken for half the people using it.
            deleteKeyCode={['Delete', 'Backspace']}
            onNodesDelete={onNodesDelete}
            // Reaching for the next line cancels the arrangement waiting to
            // happen. The settle timer stops a layout landing in the middle of
            // a drag; this stops one landing between two, which on a slow
            // machine is the same thing — the node you are aiming at moves
            // while you are on your way to it.
            onConnectStart={() => {
              if (tidyTimer.current !== null) {
                clearTimeout(tidyTimer.current);
                tidyTimer.current = null;
              }
            }}
            onNodesChange={onNodesChange}
            onEdgesChange={onEdgesChange}
            onConnect={onConnect}
            onNodeClick={(_event, node) => {
              setSelectedId(node.id);
            }}
            onNodeDragStop={() => {
              arrangedByHand.current = true;
            }}
            onPaneClick={() => {
              setSelectedId(null);
            }}
            fitView
            fitViewOptions={{ padding: 0.24, maxZoom: 1 }}
            minZoom={0.35}
            maxZoom={1.6}
            /* A line with no arrowhead says two steps are related; it does not
               say which way the work flows, which is the only thing the line
               is there for. */
            defaultEdgeOptions={{
              type: 'deletable',
              markerEnd: { type: MarkerType.ArrowClosed, width: 14, height: 14 },
            }}
            connectionLineType={ConnectionLineType.SmoothStep}
            proOptions={{ hideAttribution: false }}
          >
            <Background gap={22} size={1} />
            <Controls showInteractive={false} position="bottom-left" />
          </ReactFlow>

          {nodes.length > 1 && (
            <button
              type="button"
              className="canvas__tidy"
              data-testid="canvas-tidy"
              title="Lay the steps out in the order they run"
              onClick={() => {
                const layout = tidyPositions(nodes, edges);
                setNodes((current) =>
                  current.map((node) => ({
                    ...node,
                    position: layout.get(node.id) ?? node.position,
                  })),
                );
                requestAnimationFrame(() => {
                  void fitView({ padding: 0.24, maxZoom: 1, duration: 220 });
                });
              }}
            >
              Tidy up
            </button>
          )}

          {nodes.length === 0 && (
            <p className="canvas__empty" data-testid="canvas-empty">
              {goal === ''
                ? 'Drag an agent here to start. Join one to the next to say what runs after what.'
                : `${goal} — drag the first agent here.`}
            </p>
          )}

          {resultOpen && (
            <section className="result" data-testid="run-result" aria-label="What the run produced">
              <header className="result__head">
                <p className="result__title">What it produced</p>
                <div className="brief__left">
                  <button
                    type="button"
                    className="button"
                    data-testid="result-copy"
                    onClick={() => {
                      void navigator.clipboard.writeText(runOutput);
                      setRunNote('Copied.');
                    }}
                  >
                    Copy
                  </button>
                  <button
                    type="button"
                    className="button"
                    data-testid="result-close"
                    onClick={() => {
                      setResultOpen(false);
                    }}
                  >
                    Close
                  </button>
                </div>
              </header>

              {runOutput === '' ? (
                <p className="canvas__prompt">
                  The run finished without producing any text. Open it in Runs to see what each step
                  did.
                </p>
              ) : (
                <pre className="result__answer" data-testid="run-output">
                  {runOutput}
                </pre>
              )}

              {/* Every step, not just the last. A run that halted at step four
                  still did three steps of work, and the answer to "what went
                  wrong" is usually in one of them. */}
              {nodes.some((node) => (stepOutput[node.id] ?? '') !== '') && (
                <div className="result__steps" data-testid="result-steps">
                  <p className="canvas__section">Step by step</p>
                  {nodes
                    .filter((node) => (stepOutput[node.id] ?? '') !== '')
                    .map((node) => (
                      <details key={node.id} className="result__step">
                        <summary>
                          {node.data.role?.name ?? KIND_LABEL[node.data.kind]}
                          <span
                            className={`node__status node__status--${stepStatus[node.id] ?? ''}`}
                          >
                            {stepStatus[node.id] ?? ''}
                          </span>
                        </summary>
                        <pre className="result__answer">{stepOutput[node.id]}</pre>
                      </details>
                    ))}
                </div>
              )}
            </section>
          )}

          {pending !== null && (
            <div className="approval" data-testid="approval" role="dialog" aria-label="Approval">
              <p className="approval__prompt">{pending.prompt}</p>
              {pending.context !== '' && (
                <pre className="approval__context" data-testid="approval-context">
                  {pending.context}
                </pre>
              )}
              <input
                className="control"
                data-testid="approval-note"
                value={approvalNote}
                placeholder="Add a note (optional)"
                aria-label="Note"
                onChange={(event) => {
                  setApprovalNote(event.target.value);
                }}
              />
              <div className="approval__actions">
                <button
                  type="button"
                  className="button"
                  data-testid="approval-refuse"
                  onClick={() => void answer(false)}
                >
                  Refuse
                </button>
                <button
                  type="button"
                  className="button button--primary"
                  data-testid="approval-approve"
                  onClick={() => void answer(true)}
                >
                  Approve
                </button>
              </div>
            </div>
          )}
        </div>

        <section className="brief" data-testid="brief" data-open={briefOpen}>
          <div className="brief__bar">
            <button
              type="button"
              className="brief__toggle"
              data-testid="brief-toggle"
              aria-expanded={briefOpen}
              onClick={() => {
                setBriefOpen((open) => !open);
              }}
            >
              {briefOpen ? '▾' : '▸'} Brief
            </button>
            <input
              className="brief__name"
              data-testid="brief-name"
              value={name}
              aria-label="Automation name"
              onChange={(event) => {
                setName(event.target.value);
              }}
            />
            <button
              type="button"
              className="button"
              data-testid="brief-save"
              onClick={() => void save()}
            >
              Save
            </button>
            {!briefOpen && (
              <span className="brief__summary">
                {brief === '' ? 'No instruction yet' : brief}
                {attachments.length > 0 && ` · ${String(attachments.length)} attached`}
              </span>
            )}
          </div>

          {briefOpen && (
            <div className="brief__body">
              {/* Two columns, because the brief was taller than the canvas it
                  belongs to: what the automation is asked to do on the left,
                  what governs it on the right. */}
              <div className="brief__col">
                <textarea
                  className="brief__input"
                  data-testid="brief-input"
                  rows={3}
                  value={brief}
                  placeholder="What should this automation do? This goes to the first agent."
                  onChange={(event) => {
                    setBrief(event.target.value);
                  }}
                />

                {attachments.length > 0 && (
                  <div className="brief__files" data-testid="brief-files">
                    {attachments.map((file) => (
                      <span
                        key={file.path}
                        className={`brief__file ${file.content === '' ? 'brief__file--unread' : ''}`}
                        title={file.note === '' ? file.path : `${file.path} — ${file.note}`}
                      >
                        {file.name}
                        {file.note !== '' && ` (${file.note})`}
                      </span>
                    ))}
                  </div>
                )}

                {attachNote !== '' && <p className="brief__note">{attachNote}</p>}

                <div className="field">
                  <label className="field__label" htmlFor="brief-egress-mode">
                    What it may reach
                  </label>
                  <select
                    id="brief-egress-mode"
                    className="control"
                    data-testid="brief-egress-mode"
                    value={egressMode}
                    onChange={(event) => {
                      setEgressMode(event.target.value as 'allowlist' | 'browse' | 'open');
                    }}
                  >
                    <option value="browse">Read any site, send only to the ones named below</option>
                    <option value="allowlist">Only the sites named below</option>
                    <option value="open">Anywhere, including sending</option>
                  </select>
                  <span className="agent-editor__toolNote" data-testid="brief-egress-note">
                    {egressMode === 'browse'
                      ? 'Agents can research the open web. Sending anything — a form, an API call, an email through a web service — still needs the site named below.'
                      : egressMode === 'allowlist'
                        ? 'Nothing outside the list below is reachable at all. Tightest, and the right choice when an automation talks to one API.'
                        : 'No restriction on where data can be sent. Only worth choosing when an automation must submit to sites it cannot name in advance.'}
                  </span>
                </div>

                <div className="field">
                  <label className="field__label" htmlFor="brief-sites">
                    {egressMode === 'allowlist' ? 'Sites it may use' : 'Sites it may send to'}
                  </label>
                  <input
                    id="brief-sites"
                    className="control brief__sites"
                    data-testid="brief-sites"
                    placeholder="example.com, api.example.com — nothing else is reachable"
                    value={sites}
                    onChange={(event) => {
                      setSites(event.target.value);
                    }}
                  />
                  {/* Said before the run rather than discovered during it. An
                      agent that can use the web, in an automation that allows
                      no sites, spends its whole iteration budget being refused
                      one address at a time. */}
                  <div className="field">
                    <label className="field__label" htmlFor="brief-page-chars">
                      How much of a page to read
                    </label>
                    <input
                      id="brief-page-chars"
                      className="control"
                      type="number"
                      min={1000}
                      step={1000}
                      data-testid="brief-page-chars"
                      value={pageChars}
                      onChange={(event) => {
                        setPageChars(
                          Math.max(1000, Number(event.target.value) || DEFAULT_PAGE_CHARS),
                        );
                      }}
                    />
                    <span className="agent-editor__toolNote">
                      Characters per page, after the markup is stripped out. About four characters
                      to a token, so {String(Math.round(pageChars / 4000))}k tokens a page at this
                      setting. Raise it for long documents; lower it to spend less.
                    </span>
                  </div>

                  <div className="field">
                    <label className="field__label" htmlFor="brief-file-bytes">
                      Largest file to read
                    </label>
                    <input
                      id="brief-file-bytes"
                      className="control"
                      type="number"
                      min={1000}
                      step={100000}
                      data-testid="brief-file-bytes"
                      value={fileBytes}
                      onChange={(event) => {
                        setFileBytes(
                          Math.max(1000, Number(event.target.value) || DEFAULT_FILE_BYTES),
                        );
                      }}
                    />
                    <span className="agent-editor__toolNote">
                      Bytes. A file over this is refused rather than read, which is about{' '}
                      {String(Math.round(fileBytes / 1000))}k characters at this setting. Raise it
                      for long contracts and exports.
                    </span>
                  </div>

                  {needsSites && egressMode === 'allowlist' && (
                    <p className="brief__warn" data-testid="brief-sites-warning">
                      {webSteps.join(' and ')}{' '}
                      {webSteps.length === 1 ? 'can use the web' : 'can use the web'}, and no sites
                      are allowed — every address will be refused. Name the sites here, or the run
                      will spend its whole budget finding that out.
                    </p>
                  )}
                </div>

                <div className="brief__actions">
                  <div className="brief__left">
                    <button
                      type="button"
                      className="button"
                      data-testid="brief-attach-files"
                      onClick={() => void attach('files')}
                    >
                      Attach files
                    </button>
                    <button
                      type="button"
                      className="button"
                      data-testid="brief-attach-folder"
                      onClick={() => void attach('folder')}
                    >
                      Attach folder
                    </button>
                  </div>
                  <button
                    type="button"
                    className="button button--primary"
                    data-testid="brief-run"
                    disabled={blocked !== '' || runId !== null}
                    title={blocked}
                    onClick={() => void start()}
                  >
                    {runId === null ? 'Run' : 'Running'}
                  </button>
                </div>
                {blocked !== '' && (
                  <p className="brief__note" data-testid="brief-blocked">
                    {blocked}
                  </p>
                )}
                {runNote !== '' && (
                  <p className="brief__note" data-testid="run-note">
                    {runNote}
                  </p>
                )}
                {runOutput !== '' && !resultOpen && (
                  <button
                    type="button"
                    className="button"
                    data-testid="brief-show-result"
                    onClick={() => {
                      setResultOpen(true);
                    }}
                  >
                    Show what it produced
                  </button>
                )}
              </div>

              <div className="brief__col brief__col--side scroll">
                <section className="brief__triggers" data-testid="brief-checks">
                  <p className="canvas__section">Checks</p>
                  {evals.length === 0 && (
                    <p className="brief__note">
                      Nothing is checked. A check runs this automation against a stand-in model and
                      says whether the answer still holds.
                    </p>
                  )}
                  {evals.map((evalCase, index) => {
                    const outcome = evalOutcomes.find((one) => one.caseId === evalCase.id);
                    return (
                      <div
                        key={evalCase.id}
                        className="brief__check"
                        data-testid={`check-${String(index)}`}
                      >
                        <input
                          className="control"
                          data-testid={`check-name-${String(index)}`}
                          aria-label="What this check is called"
                          placeholder="What this check is called"
                          value={evalCase.name}
                          onChange={(event) => {
                            const value = event.target.value;
                            setEvals((current) =>
                              current.map((one, at) =>
                                at === index ? { ...one, name: value } : one,
                              ),
                            );
                          }}
                        />
                        <input
                          className="control"
                          data-testid={`check-input-${String(index)}`}
                          aria-label="What the automation is told"
                          placeholder="What the automation is told"
                          value={evalCase.input}
                          onChange={(event) => {
                            const value = event.target.value;
                            setEvals((current) =>
                              current.map((one, at) =>
                                at === index ? { ...one, input: value } : one,
                              ),
                            );
                          }}
                        />
                        <input
                          className="control"
                          data-testid={`check-answer-${String(index)}`}
                          aria-label="What the stand-in model answers"
                          placeholder="What the stand-in model answers"
                          value={evalCase.scriptedAnswer}
                          onChange={(event) => {
                            const value = event.target.value;
                            setEvals((current) =>
                              current.map((one, at) =>
                                at === index ? { ...one, scriptedAnswer: value } : one,
                              ),
                            );
                          }}
                        />
                        <input
                          className="control"
                          data-testid={`check-contains-${String(index)}`}
                          aria-label="The answer has to contain"
                          placeholder="The answer has to contain…"
                          value={evalCase.assertions[0]?.value ?? ''}
                          onChange={(event) => {
                            const value = event.target.value;
                            setEvals((current) =>
                              current.map((one, at) =>
                                at === index
                                  ? { ...one, assertions: [{ path: '', op: 'contains', value }] }
                                  : one,
                              ),
                            );
                          }}
                        />
                        {outcome && (
                          <span
                            className={`brief__checkResult brief__checkResult--${outcome.passed ? 'pass' : 'fail'}`}
                            data-testid={`check-result-${String(index)}`}
                          >
                            {outcome.passed
                              ? 'passed'
                              : outcome.runProblem !== ''
                                ? `failed — ${outcome.runProblem}`
                                : `failed — got "${outcome.results[0]?.actual ?? ''}"`}
                          </span>
                        )}
                        <button
                          type="button"
                          className="button"
                          data-testid={`check-remove-${String(index)}`}
                          onClick={() => {
                            setEvals((current) => current.filter((_, at) => at !== index));
                          }}
                        >
                          Remove
                        </button>
                      </div>
                    );
                  })}

                  <div className="brief__left">
                    <button
                      type="button"
                      className="button"
                      data-testid="check-add"
                      onClick={() => {
                        setEvals((current) => [
                          ...current,
                          {
                            id: `check-${String(Date.now())}`,
                            name: 'It answers',
                            input: brief,
                            scriptedAnswer: '',
                            assertions: [{ path: '', op: 'contains', value: '' }],
                          },
                        ]);
                      }}
                    >
                      Add a check
                    </button>
                    <button
                      type="button"
                      className="button"
                      data-testid="check-run"
                      disabled={checking || evals.length === 0}
                      onClick={() => void runChecks()}
                    >
                      {checking ? 'Checking' : 'Run checks'}
                    </button>
                    <button
                      type="button"
                      className="button"
                      data-testid="check-tag"
                      onClick={() => void tagProduction()}
                    >
                      Mark as trusted
                    </button>
                  </div>
                </section>

                <section className="brief__triggers" data-testid="brief-triggers">
                  <p className="canvas__section">Runs when</p>
                  {triggers.length === 0 && <p className="brief__note">Only when you press Run.</p>}
                  {triggers.map((trigger, index) => (
                    <div key={`${trigger.kind}-${String(index)}`} className="brief__trigger">
                      <span className="brief__triggerKind">{TRIGGER_LABEL[trigger.kind]}</span>
                      {trigger.kind === 'schedule' && (
                        <input
                          className="control"
                          data-testid={`trigger-cron-${String(index)}`}
                          aria-label="Schedule"
                          value={trigger.cron}
                          onChange={(event) => {
                            const cron = event.target.value;
                            setTriggers((current) =>
                              current.map((one, at) =>
                                at === index && one.kind === 'schedule' ? { ...one, cron } : one,
                              ),
                            );
                          }}
                        />
                      )}
                      {(trigger.kind === 'fileWatch' || trigger.kind === 'folderDrop') && (
                        <span className="brief__triggerDetail">{trigger.path}</span>
                      )}
                      {trigger.kind === 'webhook' && (
                        <span
                          className="brief__triggerDetail"
                          data-testid={`trigger-url-${String(index)}`}
                        >
                          {webhookPort === 0
                            ? 'Save to get the URL'
                            : `http://127.0.0.1:${String(webhookPort)}/hook/${trigger.token}`}
                        </span>
                      )}
                      <button
                        type="button"
                        className="button"
                        data-testid={`trigger-remove-${String(index)}`}
                        onClick={() => {
                          setTriggers((current) => current.filter((_, at) => at !== index));
                        }}
                      >
                        Remove
                      </button>
                    </div>
                  ))}

                  <select
                    className="control"
                    data-testid="trigger-add"
                    aria-label="Add a trigger"
                    value=""
                    onChange={(event) => {
                      void addTrigger(event.target.value as TriggerWire['kind']);
                      event.target.value = '';
                    }}
                  >
                    <option value="">Add a trigger</option>
                    <option value="schedule">On a schedule</option>
                    <option value="folderDrop">When a file lands in a folder</option>
                    <option value="fileWatch">When anything in a folder changes</option>
                    <option value="webhook">When something posts to a URL</option>
                  </select>
                  <p className="brief__note">
                    A trigger is armed when the automation is saved, and stays armed while CHIMERA
                    is open.
                  </p>
                </section>
              </div>
            </div>
          )}
        </section>
      </div>

      <aside
        className={`canvas__inspector scroll${inspectorOpen ? '' : ' canvas__panel--closed'}`}
        aria-label="Step"
      >
        <button
          type="button"
          className="panel-toggle panel-toggle--inspector"
          data-testid="inspector-toggle"
          aria-expanded={inspectorOpen}
          aria-label={inspectorOpen ? 'Hide step settings' : 'Show step settings'}
          title={inspectorOpen ? 'Hide step settings' : 'Show step settings'}
          onClick={() => {
            setInspectorOpen((open) => !open);
          }}
        >
          {inspectorOpen ? '›' : '‹'}
        </button>
        {selected && (
          <div className="canvas__stepBar">
            <span className="canvas__stepKind">{KIND_LABEL[selected.data.kind]}</span>
            <button
              type="button"
              className="button button--quiet"
              data-testid="node-remove"
              onClick={() => {
                removeStep(selected.id);
              }}
            >
              Remove step
            </button>
          </div>
        )}
        {selected ? (
          selected.data.kind === 'agent' ? (
            <>
              {/* The step's name is the subject of this panel, not another
                  field label in it. Set in the same uppercase micro-type as
                  "Model" and "Limits", it read as one more heading in a stack
                  of headings. */}
              <h3 className="canvas__stepName">{selected.data.role?.name ?? 'Agent'}</h3>
              <p className="canvas__prompt">{selected.data.role?.systemPrompt}</p>

              <p className="canvas__section">Instruction for this step</p>
              <textarea
                className="canvas__instruction"
                data-testid="node-instruction"
                value={selected.data.instruction}
                placeholder="What should this agent do here? Leave empty to use the role as written."
                onChange={(event) => {
                  const instruction = event.target.value;
                  setNodes((current) =>
                    current.map((node) =>
                      node.id === selectedId
                        ? { ...node, data: { ...node.data, instruction } }
                        : node,
                    ),
                  );
                }}
              />

              <p className="canvas__section">Model</p>
              <ModelPicker
                choices={choices}
                loaded={loaded}
                value={
                  selected.data.tier === undefined
                    ? (selected.data.binding?.key ?? '')
                    : `tier:${selected.data.tier}`
                }
                onChange={bind}
              />

              {(stepOutput[selected.id] ?? '') !== '' && (
                <>
                  <p className="canvas__section">What it produced</p>
                  <pre className="result__answer" data-testid="node-output">
                    {stepOutput[selected.id]}
                  </pre>
                </>
              )}

              <p className="canvas__section">Allowed tools</p>
              <div className="canvas__tags">
                {selected.data.role === null || selected.data.role.toolAllowlist.length === 0 ? (
                  <span className="tag">None</span>
                ) : (
                  selected.data.role.toolAllowlist.map((tool) => (
                    <span key={tool} className="tag">
                      {tool}
                    </span>
                  ))
                )}
              </div>

              {problems.some(
                (problem) =>
                  problem.nodeId === selected.id && problem.message.includes('pre-authorise'),
              ) && (
                <>
                  <p className="canvas__section">Needs a decision</p>
                  <p className="canvas__prompt" data-testid="node-problem">
                    {problems.find((problem) => problem.nodeId === selected.id)?.message}
                  </p>
                  <label className="canvas__check">
                    <input
                      type="checkbox"
                      data-testid="node-preauthorise"
                      checked={preauthorised.includes(selected.id)}
                      onChange={(event) => {
                        const on = event.target.checked;
                        setPreauthorised((current) =>
                          on
                            ? [...current, selected.id]
                            : current.filter((nodeId) => nodeId !== selected.id),
                        );
                      }}
                    />
                    <span>
                      Let this step act without approval. Saved with the automation, so whoever
                      opens it next can see it.
                    </span>
                  </label>
                </>
              )}

              <p className="canvas__section">Limits</p>
              <div className="canvas__tags">
                <span className="tag">{selected.data.role?.maxIterations} iterations max</span>
                <span className="tag">
                  {selected.data.role?.maxCostUsd === null ||
                  selected.data.role?.maxCostUsd === undefined
                    ? 'No cost cap'
                    : `$${selected.data.role.maxCostUsd.toFixed(2)} cap`}
                </span>
              </div>
            </>
          ) : (
            <ShapingInspector
              data={selected.data}
              steps={nodes.map((node) => ({
                id: node.id,
                label: node.data.role?.name ?? KIND_LABEL[node.data.kind],
              }))}
              automations={saved.filter((workflow) => workflow.id !== savedId)}
              roles={roles}
              modelPicker={
                <ModelPicker
                  choices={choices}
                  loaded={loaded}
                  value={
                    selected.data.tier === undefined
                      ? (selected.data.binding?.key ?? '')
                      : `tier:${selected.data.tier}`
                  }
                  onChange={bind}
                />
              }
              selfId={selected.id}
              onChange={setSetting}
            />
          )
        ) : (
          <p className="canvas__prompt">
            Select a step to choose its model and see what it may do.
          </p>
        )}
      </aside>
    </div>
  );
}

/**
 * The model control.
 *
 * Shared, because the agent step is no longer the only thing that makes a model
 * call: a team's participants and an aggregate's reducing agent both spend
 * money, and a node that can spend money and cannot be bound to a model is a
 * node that cannot run. That was shipped, and the team's own E2E is what
 * caught it.
 */
function ModelPicker({
  choices,
  loaded,
  value,
  onChange,
}: {
  choices: ModelChoice[];
  loaded: boolean;
  value: string;
  onChange: (value: string) => void;
}): JSX.Element {
  if (loaded && choices.length === 0) {
    return (
      <p className="canvas__prompt">
        No models available. Connect a provider first, and its catalogue appears here.
      </p>
    );
  }

  return (
    <select
      className="control"
      data-testid="node-model"
      value={value}
      onChange={(event) => {
        onChange(event.target.value);
      }}
    >
      <option value="">Choose a model</option>
      <option value="tier:cheap">Cheap tier — whatever this workspace calls cheap</option>
      <option value="tier:standard">Standard tier</option>
      <option value="tier:frontier">Frontier tier</option>
      {choices.map((choice) => (
        <option key={choice.key} value={choice.key}>
          {choice.connectionLabel} · {choice.model}
        </option>
      ))}
    </select>
  );
}

interface ShapingInspectorProps {
  data: StepNodeData;
  /** Every step on the canvas, so a source is picked rather than typed. */
  steps: { id: string; label: string }[];
  /** Saved automations a subworkflow step can run, minus this one. */
  automations: { id: string; name: string }[];
  /** The roster, for the steps that name agents without being one. */
  roles: AgentRole[];
  /** Rendered for the shaping kinds that make model calls of their own. */
  modelPicker: JSX.Element;
  selfId: string;
  onChange: <K extends keyof StepSettings>(key: K, value: StepSettings[K]) => void;
}

/** The settings panel for the four shaping node types. */
function ShapingInspector({
  data,
  steps,
  automations,
  roles,
  modelPicker,
  selfId,
  onChange,
}: ShapingInspectorProps): JSX.Element {
  const settings = data.settings;
  const others = steps.filter((step) => step.id !== selfId);

  return (
    <>
      <h3 className="canvas__stepName">{KIND_LABEL[data.kind]}</h3>
      <p className="canvas__prompt">
        {data.kind === 'agent' ? '' : KIND_BLURB[data.kind as Exclude<StepKind, 'agent'>]}
      </p>

      {data.kind === 'condition' && (
        <>
          <p className="canvas__section">Look at</p>
          <select
            className="control"
            data-testid="condition-source"
            value={settings.source}
            onChange={(event) => {
              onChange('source', event.target.value);
            }}
          >
            <option value="">The step before this one</option>
            {others.map((step) => (
              <option key={step.id} value={step.id}>
                {step.label}
              </option>
            ))}
          </select>

          <p className="canvas__section">Test</p>
          <select
            className="control"
            data-testid="condition-test"
            value={settings.test}
            onChange={(event) => {
              onChange('test', event.target.value as StepSettings['test']);
            }}
          >
            <option value="contains">contains</option>
            <option value="equals">equals</option>
            <option value="matches">matches (regular expression)</option>
            <option value="isEmpty">is empty</option>
            <option value="notEmpty">is not empty</option>
          </select>

          {settings.test !== 'isEmpty' && settings.test !== 'notEmpty' && (
            <input
              className="control"
              data-testid="condition-value"
              value={settings.value}
              placeholder="What to look for"
              aria-label="Value"
              onChange={(event) => {
                onChange('value', event.target.value);
              }}
            />
          )}

          <p className="canvas__prompt">
            Join the yes port to what happens when the test passes, and the no port to what happens
            when it does not.
          </p>
        </>
      )}

      {data.kind === 'loop' && (
        <>
          <p className="canvas__section">Maximum passes</p>
          <input
            className="control"
            type="number"
            min={1}
            max={100}
            data-testid="loop-max"
            value={settings.maxIterations}
            aria-label="Maximum passes"
            onChange={(event) => {
              onChange('maxIterations', Number(event.target.value));
            }}
          />
          <p className="canvas__prompt">
            Every step joined below this one runs again on each pass. A loop cannot run without a
            maximum — that is what keeps a mistake from costing a month of credit.
          </p>
        </>
      )}

      {data.kind === 'transform' && (
        <>
          <p className="canvas__section">Template</p>
          <textarea
            className="canvas__instruction"
            data-testid="transform-template"
            value={settings.template}
            placeholder="Findings: {{previous}}"
            onChange={(event) => {
              onChange('template', event.target.value);
            }}
          />
          <p className="canvas__prompt">
            Use {'{{previous}}'} for the step before this one, or {'{{step-id}}'} for any earlier
            step. No model runs here, so this costs nothing.
          </p>
        </>
      )}

      {(data.kind === 'team' ||
        (data.kind === 'aggregate' && data.settings.strategy === 'reduce_with_agent')) && (
        <>
          <p className="canvas__section">Model</p>
          {modelPicker}
        </>
      )}

      {data.kind === 'team' && (
        <>
          <p className="canvas__section">Goal</p>
          <textarea
            className="canvas__instruction"
            data-testid="team-goal"
            value={settings.goal}
            placeholder="What are they all working on?"
            onChange={(event) => {
              onChange('goal', event.target.value);
            }}
          />

          <p className="canvas__section">Led by</p>
          <select
            className="control"
            data-testid="team-orchestrator"
            value={settings.orchestratorRoleId}
            onChange={(event) => {
              onChange('orchestratorRoleId', event.target.value);
            }}
          >
            {roles.map((role) => (
              <option key={role.id} value={role.id}>
                {role.name}
              </option>
            ))}
          </select>

          <p className="canvas__section">Specialists</p>
          {settings.agents.map((agent, index) => (
            <div key={`${agent.roleId}-${String(index)}`} className="team__agent">
              <select
                className="control"
                data-testid={`team-agent-${String(index)}`}
                value={agent.roleId}
                aria-label="Specialist"
                onChange={(event) => {
                  const next = [...settings.agents];
                  next[index] = { ...agent, roleId: event.target.value };
                  onChange('agents', next);
                }}
              >
                {roles.map((role) => (
                  <option key={role.id} value={role.id}>
                    {role.name}
                  </option>
                ))}
              </select>
              <input
                className="control"
                data-testid={`team-agent-instruction-${String(index)}`}
                value={agent.instruction}
                aria-label="What they do"
                placeholder="What this one does"
                onChange={(event) => {
                  const next = [...settings.agents];
                  next[index] = { ...agent, instruction: event.target.value };
                  onChange('agents', next);
                }}
              />
              <button
                type="button"
                className="button"
                data-testid={`team-remove-${String(index)}`}
                onClick={() => {
                  onChange(
                    'agents',
                    settings.agents.filter((_, at) => at !== index),
                  );
                }}
              >
                Remove
              </button>
            </div>
          ))}
          <button
            type="button"
            className="button"
            data-testid="team-add-agent"
            onClick={() => {
              onChange('agents', [
                ...settings.agents,
                { roleId: roles[0]?.id ?? 'researcher', instruction: '' },
              ]);
            }}
          >
            Add a specialist
          </button>

          <p className="canvas__section">Rounds at most</p>
          <input
            className="control"
            type="number"
            min={1}
            max={20}
            data-testid="team-rounds"
            aria-label="Rounds at most"
            value={settings.maxRounds}
            onChange={(event) => {
              onChange('maxRounds', Number(event.target.value));
            }}
          />

          <p className="canvas__section">Working at once</p>
          <input
            className="control"
            type="number"
            min={1}
            max={20}
            data-testid="team-concurrency"
            aria-label="Working at once"
            value={settings.maxConcurrentAgents}
            onChange={(event) => {
              onChange('maxConcurrentAgents', Number(event.target.value));
            }}
          />
          <p className="canvas__prompt">
            Twenty at once is the ceiling, whatever you type here. Past that, the agents spend more
            on coordinating than they produce.
          </p>

          <p className="canvas__section">Stop early when the lead says</p>
          <input
            className="control"
            data-testid="team-goal-contains"
            aria-label="Stop when the lead says"
            placeholder="DONE"
            value={settings.goalContains}
            onChange={(event) => {
              onChange('goalContains', event.target.value);
            }}
          />

          <p className="canvas__section">Or after this many rounds that change nothing</p>
          <input
            className="control"
            type="number"
            min={0}
            data-testid="team-stall"
            aria-label="Rounds without change"
            value={settings.stallRounds}
            onChange={(event) => {
              onChange('stallRounds', Number(event.target.value));
            }}
          />
        </>
      )}

      {data.kind === 'aggregate' && (
        <>
          <p className="canvas__section">Answers come from</p>
          <select
            className="control"
            data-testid="aggregate-source"
            value={settings.source}
            onChange={(event) => {
              onChange('source', event.target.value);
            }}
          >
            <option value="">The step before this one</option>
            {others.map((step) => (
              <option key={step.id} value={step.id}>
                {step.label}
              </option>
            ))}
          </select>

          <p className="canvas__section">Combine them</p>
          <select
            className="control"
            data-testid="aggregate-strategy"
            value={settings.strategy}
            onChange={(event) => {
              onChange('strategy', event.target.value as StepSettings['strategy']);
            }}
          >
            <option value="concat">One after another</option>
            <option value="json_merge">Merged as JSON</option>
            <option value="vote">Take the most common answer</option>
            <option value="template">Into a template</option>
            <option value="reduce_with_agent">Folded by an agent</option>
          </select>

          {settings.strategy === 'concat' && (
            <input
              className="control"
              data-testid="aggregate-separator"
              aria-label="Separator"
              placeholder="Blank line between answers"
              value={settings.separator}
              onChange={(event) => {
                onChange('separator', event.target.value);
              }}
            />
          )}

          {settings.strategy === 'template' && (
            <textarea
              className="canvas__instruction"
              data-testid="aggregate-template"
              placeholder="{{count}} answers:\n{{items}}"
              value={settings.template}
              onChange={(event) => {
                onChange('template', event.target.value);
              }}
            />
          )}

          {settings.strategy === 'reduce_with_agent' && (
            <>
              <p className="canvas__section">A chunk at a time</p>
              <input
                className="control"
                type="number"
                min={1}
                data-testid="aggregate-chunk"
                aria-label="Answers per call"
                value={settings.chunkSize}
                onChange={(event) => {
                  onChange('chunkSize', Number(event.target.value));
                }}
              />
              <p className="canvas__prompt">
                This is the only way of combining that costs anything. The answers are folded a
                chunk at a time, and the results folded again, so a thousand of them never have to
                fit in one context window. Give this step an instruction and a model like any agent.
              </p>
            </>
          )}

          {settings.strategy !== 'reduce_with_agent' && (
            <p className="canvas__prompt">No model runs here, so this costs nothing.</p>
          )}
        </>
      )}

      {data.kind === 'fanout' && (
        <>
          <p className="canvas__section">Items come from</p>
          <select
            className="control"
            data-testid="fanout-source"
            value={settings.source}
            onChange={(event) => {
              onChange('source', event.target.value);
            }}
          >
            <option value="">The step before this one</option>
            {others.map((step) => (
              <option key={step.id} value={step.id}>
                {step.label}
              </option>
            ))}
          </select>

          <p className="canvas__section">Read that as</p>
          <select
            className="control"
            data-testid="fanout-parse"
            value={settings.parse}
            onChange={(event) => {
              onChange('parse', event.target.value as StepSettings['parse']);
            }}
          >
            <option value="json">A JSON list</option>
            <option value="lines">One item per line</option>
          </select>

          <p className="canvas__section">At a time</p>
          <input
            className="control"
            type="number"
            min={1}
            max={50}
            data-testid="fanout-concurrency"
            aria-label="Items at a time"
            value={settings.concurrency}
            onChange={(event) => {
              onChange('concurrency', Number(event.target.value));
            }}
          />

          <p className="canvas__section">At most</p>
          <input
            className="control"
            type="number"
            min={1}
            data-testid="fanout-max"
            aria-label="Maximum items"
            value={settings.maxItems}
            onChange={(event) => {
              onChange('maxItems', Number(event.target.value));
            }}
          />

          <p className="canvas__section">When an item fails</p>
          <select
            className="control"
            data-testid="fanout-on-error"
            value={settings.onItemError}
            onChange={(event) => {
              onChange('onItemError', event.target.value as StepSettings['onItemError']);
            }}
          >
            <option value="continue">Keep going, and list it afterwards</option>
            <option value="halt">Stop the whole fan-out</option>
          </select>

          {settings.onItemError === 'continue' && (
            <>
              <p className="canvas__section">Stop after this many failures</p>
              <input
                className="control"
                type="number"
                min={0}
                data-testid="fanout-dead-letter"
                aria-label="Failures allowed"
                value={settings.deadLetterLimit}
                onChange={(event) => {
                  onChange('deadLetterLimit', Number(event.target.value));
                }}
              />
            </>
          )}

          <p className="canvas__prompt">
            Every step joined below this one runs once per item. Failed items are listed in Runs
            rather than thrown away, and one bad item does not cost the rest.
          </p>
        </>
      )}

      {data.kind === 'subworkflow' && (
        <>
          <p className="canvas__section">Automation</p>
          <select
            className="control"
            data-testid="subworkflow-id"
            value={settings.workflowId}
            onChange={(event) => {
              onChange('workflowId', event.target.value);
            }}
          >
            <option value="">Choose an automation</option>
            {automations.map((workflow) => (
              <option key={workflow.id} value={workflow.id}>
                {workflow.name}
              </option>
            ))}
          </select>
          <p className="canvas__prompt">
            {automations.length === 0
              ? 'Save an automation first, and it appears here.'
              : 'It runs the latest saved version, and what it produces carries on to the next step. Automations can be nested five deep.'}
          </p>
        </>
      )}

      {data.kind === 'approval' && (
        <>
          <p className="canvas__section">Question</p>
          <input
            className="control"
            data-testid="approval-prompt"
            value={settings.prompt}
            placeholder="Send this email?"
            aria-label="Question"
            onChange={(event) => {
              onChange('prompt', event.target.value);
            }}
          />

          <p className="canvas__section">Show them</p>
          <select
            className="control"
            data-testid="approval-source"
            value={settings.showSource}
            onChange={(event) => {
              onChange('showSource', event.target.value);
            }}
          >
            <option value="">The step before this one</option>
            {others.map((step) => (
              <option key={step.id} value={step.id}>
                {step.label}
              </option>
            ))}
          </select>

          <p className="canvas__prompt">
            The run stops here until somebody answers. Nothing after it runs on a refusal.
          </p>
        </>
      )}
    </>
  );
}

export interface CanvasProps {
  goal: string;
  /** Opens the agent editor. The palette is where somebody realises they need one. */
  onBuildAgent?: () => void;
  /** A draft from the Home planner, turned into nodes on arrival. */
  template?: AutomationTemplate | null;
  /** A saved automation to open. */
  openId?: string | null;
  /** Called after a save, so the sidebar's list refreshes. */
  onSaved?: () => void;
  /** Bumped when the roster changes, so a new agent shows up without a restart. */
  rolesToken?: number;
}

export function CanvasView({
  goal,
  template = null,
  openId = null,
  onSaved,
  onBuildAgent,
  rolesToken = 0,
}: CanvasProps): JSX.Element {
  // The provider owns the viewport, so `screenToFlowPosition` can turn a drop
  // at a screen coordinate into the right place on a panned or zoomed canvas.
  return (
    <ReactFlowProvider>
      <CanvasInner
        goal={goal}
        template={template}
        openId={openId}
        onSaved={onSaved}
        rolesToken={rolesToken}
        {...(onBuildAgent ? { onBuildAgent } : {})}
      />
    </ReactFlowProvider>
  );
}
