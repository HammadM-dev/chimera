import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { DragEvent, JSX } from 'react';
import {
  Background,
  Controls,
  Handle,
  Position,
  ReactFlow,
  ReactFlowProvider,
  addEdge,
  useEdgesState,
  useNodesState,
  useReactFlow,
  type Connection,
  type Edge,
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
  | 'swarm';

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
  /** Swarm: the goal, who leads, who works, and the three ways it stops. */
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
  swarm: 'Swarm',
};

const KIND_BLURB: Record<Exclude<StepKind, 'agent'>, string> = {
  condition: 'Sends the run one way or the other',
  loop: 'Repeats the steps below it, a set number of times',
  transform: 'Joins earlier answers together, without a model',
  approval: 'Pauses until a person says yes',
  subworkflow: 'Runs another saved automation here',
  fanout: 'Runs the steps below it once per item, several at a time',
  aggregate: 'Turns many answers into one',
  swarm: 'A team of agents on one goal, through a shared board',
};

const STRATEGY_LABEL: Record<StepSettings['strategy'], string> = {
  concat: 'One after another',
  json_merge: 'Merged as JSON',
  reduce_with_agent: 'Folded by an agent',
  vote: 'The most common answer',
  template: 'Into a template',
};

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
    case 'swarm':
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
      <Handle type="target" position={Position.Top} className="node__port" />
      <p className="node__name">{role?.name ?? 'Agent'}</p>
      <p
        className={`node__model ${binding === null && data.tier === undefined ? 'node__model--unset' : ''}`}
      >
        {data.tier !== undefined
          ? `${data.tier} tier`
          : binding === null
            ? 'No model chosen'
            : binding.model}
      </p>
      {typeof status === 'string' && status !== '' && (
        <p className={`node__status node__status--${status}`}>{status}</p>
      )}
      <p className="node__tools">
        {role === null || role.toolAllowlist.length === 0
          ? 'No tools'
          : `${String(role.toolAllowlist.length)} tools`}
      </p>
      <Handle type="source" position={Position.Bottom} className="node__port" />
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
      <Handle type="target" position={Position.Top} className="node__port" />
      <p className="node__name">{KIND_LABEL[kind]}</p>
      <p className="node__model">{summarise(data)}</p>
      {typeof status === 'string' && status !== '' && (
        <p className={`node__status node__status--${status}`}>{status}</p>
      )}
      {kind === 'condition' ? (
        <>
          <span className="node__portLabel node__portLabel--true">yes</span>
          <span className="node__portLabel node__portLabel--false">no</span>
          <Handle
            id="true"
            type="source"
            position={Position.Bottom}
            className="node__port node__port--true"
            style={{ left: '28%' }}
          />
          <Handle
            id="false"
            type="source"
            position={Position.Bottom}
            className="node__port node__port--false"
            style={{ left: '72%' }}
          />
        </>
      ) : (
        <Handle type="source" position={Position.Bottom} className="node__port" />
      )}
    </div>
  );
}

const NODE_TYPES = {
  agent: AgentNodeBody,
  condition: ShapingNodeBody,
  loop: ShapingNodeBody,
  transform: ShapingNodeBody,
  approval: ShapingNodeBody,
  subworkflow: ShapingNodeBody,
  fanout: ShapingNodeBody,
  aggregate: ShapingNodeBody,
  swarm: ShapingNodeBody,
};

let nodeSeq = 0;

export interface Attachment {
  path: string;
  name: string;
  kind: 'text' | 'image' | 'binary';
  bytes: number;
  content: string;
  note: string;
}

export interface AutomationTemplate {
  name: string;
  summary: string;
  steps: { roleId: string; instruction: string }[];
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

interface PendingApproval {
  nodeId: string;
  prompt: string;
  context: string;
}

interface AwaitingApproval extends PendingApproval {
  runId: string;
}

function CanvasInner({ goal, template, openId = null, onSaved }: CanvasProps): JSX.Element {
  const roles = useRoles();
  const { choices, loaded } = useConnections();
  const [nodes, setNodes, onNodesChange] = useNodesState<StepNode>([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [brief, setBrief] = useState(goal);
  const [briefOpen, setBriefOpen] = useState(true);
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [attachNote, setAttachNote] = useState('');
  const appliedTemplate = useRef<AutomationTemplate | null>(null);
  const [runId, setRunId] = useState<string | null>(null);
  const [stepStatus, setStepStatus] = useState<Record<string, string>>({});
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
    (kind: StepKind, role: AgentRole | null, position: { x: number; y: number }) => {
      nodeSeq += 1;
      const id = `${role?.id ?? kind}-${String(nodeSeq)}`;
      setNodes((current) => [
        ...current,
        {
          id,
          type: kind,
          position,
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

    const built: StepNode[] = [];
    template.steps.forEach((step, index) => {
      const role = roles.find((candidate) => candidate.id === step.roleId);
      if (!role) return;
      nodeSeq += 1;
      built.push({
        id: `${role.id}-${String(nodeSeq)}`,
        type: 'agent',
        position: { x: 120, y: 60 + index * 132 },
        data: {
          kind: 'agent',
          role,
          binding: null,
          instruction: step.instruction,
          settings: { ...DEFAULT_SETTINGS },
        },
      });
    });

    setNodes(built);
    setEdges(
      built.slice(1).map((node, index) => ({
        id: `edge-${node.id}`,
        source: built[index]?.id ?? '',
        target: node.id,
        animated: true,
      })),
    );
    setBrief(template.summary);
    setSelectedId(built[0]?.id ?? null);
  }, [template, roles, setNodes, setEdges]);

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
          } else if (config && config['type'] === 'swarm') {
            const swarm = config['swarm'] as {
              goal: string;
              orchestratorRoleId: string;
              agents: { roleId: string; instruction: string }[];
              maxRounds: number;
              maxConcurrentAgents: number;
              stallRounds: number;
              goalPredicate?: { value: string };
            };
            settings.goal = swarm.goal;
            settings.orchestratorRoleId = swarm.orchestratorRoleId;
            settings.agents = swarm.agents;
            settings.maxRounds = swarm.maxRounds;
            settings.maxConcurrentAgents = swarm.maxConcurrentAgents;
            settings.stallRounds = swarm.stallRounds;
            settings.goalContains = swarm.goalPredicate?.value ?? '';
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
            position: { x: at?.x ?? 120, y: at?.y ?? 60 + index * 132 },
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
          outcome?: { status: string };
        };
        setStepStatus((current) => ({
          ...current,
          [detail.nodeId]:
            detail.phase === 'started' ? 'running' : (detail.outcome?.status ?? 'done'),
        }));
      } else if (event.type === 'approval:requested') {
        setPending(event.data as PendingApproval);
        setApprovalNote('');
      } else if (event.type === 'finished') {
        const detail = event.data as { status: string; summary: string | null; output: string };
        setRunNote(detail.summary ?? `Run ${detail.status}.`);
        setRunOutput(detail.output);
        setPending(null);
        setRunId(null);
      } else if (event.type === 'failed') {
        setRunNote((event.data as { message: string }).message);
        setPending(null);
        setRunId(null);
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
        case 'swarm':
          return {
            ...base,
            config: {
              type: 'swarm',
              swarm: {
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
      // Positions are not part of the run, but they are part of the thing the
      // user arranged. Losing the layout on reload would make saving feel like
      // it half-worked.
      layout: nodes.map((node) => ({ nodeId: node.id, x: node.position.x, y: node.position.y })),
    };
  }, [name, brief, attachments, nodes, edges, preauthorised]);

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

  const start = useCallback(async () => {
    setRunNote('');
    setRunOutput('');
    setStepStatus({});
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
    ['agent', 'subworkflow', 'fanout', 'swarm'].includes(node.data.kind),
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
      case 'swarm':
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
                : badShaping.data.kind === 'swarm'
                  ? 'A swarm needs a goal, at least one specialist, a round limit and a model.'
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

  const onConnect = useCallback(
    (connection: Connection) => {
      setEdges((current) => addEdge({ ...connection, animated: true }, current));
    },
    [setEdges],
  );

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

  const grouped = useMemo(
    () =>
      AGENT_GROUPS.map((group) => ({
        label: group.label,
        members: group.ids
          .map((id) => roles.find((role) => role.id === id))
          .filter((role): role is AgentRole => role !== undefined),
      })).filter((group) => group.members.length > 0),
    [roles],
  );

  return (
    <div className="canvas" data-testid="canvas-view">
      <aside className="canvas__palette scroll" aria-label="Agents">
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
                  addStep('agent', role, { x: 80 + nodeSeq * 24, y: 60 + nodeSeq * 72 });
                }}
              >
                <span className="palette__name">{role.name}</span>
                <span className="palette__meta">
                  {role.tier} ·{' '}
                  {role.toolAllowlist.length === 0
                    ? 'no tools'
                    : `${String(role.toolAllowlist.length)} tools`}
                </span>
              </button>
            ))}
          </div>
        ))}

        <p className="canvas__section">Flow</p>
        {(['condition', 'loop', 'fanout', 'transform', 'approval', 'subworkflow'] as const).map(
          (kind) => (
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
                addStep(kind, null, { x: 80 + nodeSeq * 24, y: 60 + nodeSeq * 72 });
              }}
            >
              <span className="palette__name">{KIND_LABEL[kind]}</span>
              <span className="palette__meta">{KIND_BLURB[kind]}</span>
            </button>
          ),
        )}
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
            onNodesChange={onNodesChange}
            onEdgesChange={onEdgesChange}
            onConnect={onConnect}
            onNodeClick={(_event, node) => {
              setSelectedId(node.id);
            }}
            onPaneClick={() => {
              setSelectedId(null);
            }}
            fitView
            proOptions={{ hideAttribution: false }}
          >
            <Background gap={20} size={1} />
            <Controls showInteractive={false} />
          </ReactFlow>

          {nodes.length === 0 && (
            <p className="canvas__empty" data-testid="canvas-empty">
              {goal === ''
                ? 'Drag an agent here to start. Join one to the next to say what runs after what.'
                : `${goal} — drag the first agent here.`}
            </p>
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
              {runOutput !== '' && (
                <pre className="brief__output" data-testid="run-output">
                  {runOutput}
                </pre>
              )}
            </div>
          )}
        </section>
      </div>

      <aside className="canvas__inspector scroll" aria-label="Step">
        {selected ? (
          selected.data.kind === 'agent' ? (
            <>
              <p className="canvas__section">{selected.data.role?.name ?? 'Agent'}</p>
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
              {loaded && choices.length === 0 ? (
                <p className="canvas__prompt">
                  No models available. Connect a provider first, and its catalogue appears here.
                </p>
              ) : (
                <select
                  className="control"
                  data-testid="node-model"
                  value={
                    selected.data.tier === undefined
                      ? (selected.data.binding?.key ?? '')
                      : `tier:${selected.data.tier}`
                  }
                  onChange={(event) => {
                    bind(event.target.value);
                  }}
                >
                  <option value="">Choose a model</option>
                  <option value="tier:cheap">
                    Cheap tier — whatever this workspace calls cheap
                  </option>
                  <option value="tier:standard">Standard tier</option>
                  <option value="tier:frontier">Frontier tier</option>
                  {choices.map((choice) => (
                    <option key={choice.key} value={choice.key}>
                      {choice.connectionLabel} · {choice.model}
                    </option>
                  ))}
                </select>
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

interface ShapingInspectorProps {
  data: StepNodeData;
  /** Every step on the canvas, so a source is picked rather than typed. */
  steps: { id: string; label: string }[];
  /** Saved automations a subworkflow step can run, minus this one. */
  automations: { id: string; name: string }[];
  /** The roster, for the steps that name agents without being one. */
  roles: AgentRole[];
  selfId: string;
  onChange: <K extends keyof StepSettings>(key: K, value: StepSettings[K]) => void;
}

/** The settings panel for the four shaping node types. */
function ShapingInspector({
  data,
  steps,
  automations,
  roles,
  selfId,
  onChange,
}: ShapingInspectorProps): JSX.Element {
  const settings = data.settings;
  const others = steps.filter((step) => step.id !== selfId);

  return (
    <>
      <p className="canvas__section">{KIND_LABEL[data.kind]}</p>
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

      {data.kind === 'swarm' && (
        <>
          <p className="canvas__section">Goal</p>
          <textarea
            className="canvas__instruction"
            data-testid="swarm-goal"
            value={settings.goal}
            placeholder="What are they all working on?"
            onChange={(event) => {
              onChange('goal', event.target.value);
            }}
          />

          <p className="canvas__section">Led by</p>
          <select
            className="control"
            data-testid="swarm-orchestrator"
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
            <div key={`${agent.roleId}-${String(index)}`} className="swarm__agent">
              <select
                className="control"
                data-testid={`swarm-agent-${String(index)}`}
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
                data-testid={`swarm-agent-instruction-${String(index)}`}
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
                data-testid={`swarm-remove-${String(index)}`}
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
            data-testid="swarm-add-agent"
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
            data-testid="swarm-rounds"
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
            data-testid="swarm-concurrency"
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
            data-testid="swarm-goal-contains"
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
            data-testid="swarm-stall"
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
  /** A draft from the Home planner, turned into nodes on arrival. */
  template?: AutomationTemplate | null;
  /** A saved automation to open. */
  openId?: string | null;
  /** Called after a save, so the sidebar's list refreshes. */
  onSaved?: () => void;
}

export function CanvasView({
  goal,
  template = null,
  openId = null,
  onSaved,
}: CanvasProps): JSX.Element {
  // The provider owns the viewport, so `screenToFlowPosition` can turn a drop
  // at a screen coordinate into the right place on a panned or zoomed canvas.
  return (
    <ReactFlowProvider>
      <CanvasInner goal={goal} template={template} openId={openId} onSaved={onSaved} />
    </ReactFlowProvider>
  );
}
