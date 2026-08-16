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

export interface AgentNodeData extends Record<string, unknown> {
  role: AgentRole;
  /** `connectionId::model`, or null while the step is still unbound. */
  binding: ModelChoice | null;
  /**
   * What this agent is told to do in *this* automation.
   *
   * Separate from the role's system prompt, which says what the agent is. A
   * researcher is a researcher in every automation; what it researches is this
   * step's business, and putting the two in one field would mean editing the
   * role every time you reused it.
   */
  instruction: string;
}

type AgentNode = Node<AgentNodeData, 'agent'>;

/** One step. Shows the two facts that decide what it will do: who, and on what. */
function AgentNodeBody({ data, selected }: NodeProps<AgentNode>): JSX.Element {
  const { role, binding } = data;

  return (
    <div
      className={`node ${selected === true ? 'node--selected' : ''}`}
      data-testid={`node-${role.id}`}
    >
      <Handle type="target" position={Position.Top} className="node__port" />
      <p className="node__name">{role.name}</p>
      <p className={`node__model ${binding === null ? 'node__model--unset' : ''}`}>
        {binding === null ? 'No model chosen' : binding.model}
      </p>
      <p className="node__tools">
        {role.toolAllowlist.length === 0
          ? 'No tools'
          : `${String(role.toolAllowlist.length)} tools`}
      </p>
      <Handle type="source" position={Position.Bottom} className="node__port" />
    </div>
  );
}

const NODE_TYPES = { agent: AgentNodeBody };

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

function CanvasInner({ goal, template }: CanvasProps): JSX.Element {
  const roles = useRoles();
  const { choices, loaded } = useConnections();
  const [nodes, setNodes, onNodesChange] = useNodesState<AgentNode>([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [brief, setBrief] = useState(goal);
  const [briefOpen, setBriefOpen] = useState(true);
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [attachNote, setAttachNote] = useState('');
  const appliedTemplate = useRef<AutomationTemplate | null>(null);
  const wrapper = useRef<HTMLDivElement | null>(null);
  const { screenToFlowPosition, fitView } = useReactFlow();

  const addAgent = useCallback(
    (role: AgentRole, position: { x: number; y: number }) => {
      nodeSeq += 1;
      const id = `${role.id}-${String(nodeSeq)}`;
      setNodes((current) => [
        ...current,
        {
          id,
          type: 'agent',
          position,
          data: {
            role,
            // Left unset rather than defaulted to the first model that happens
            // to exist: a step silently bound to a model nobody chose is how a
            // run ends up on the wrong provider.
            binding: null,
            instruction: '',
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

    const built: AgentNode[] = [];
    template.steps.forEach((step, index) => {
      const role = roles.find((candidate) => candidate.id === step.roleId);
      if (!role) return;
      nodeSeq += 1;
      built.push({
        id: `${role.id}-${String(nodeSeq)}`,
        type: 'agent',
        position: { x: 120, y: 60 + index * 132 },
        data: { role, binding: null, instruction: step.instruction },
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

  const onDrop = useCallback(
    (event: DragEvent<HTMLDivElement>) => {
      event.preventDefault();
      const roleId = event.dataTransfer.getData('application/chimera-role');
      const role = roles.find((candidate) => candidate.id === roleId);
      if (!role) return;
      addAgent(role, screenToFlowPosition({ x: event.clientX, y: event.clientY }));
    },
    [roles, addAgent, screenToFlowPosition],
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
      const choice = choices.find((candidate) => candidate.key === value) ?? null;
      setNodes((current) =>
        current.map((node) =>
          node.id === selectedId ? { ...node, data: { ...node.data, binding: choice } } : node,
        ),
      );
    },
    [choices, selectedId, setNodes],
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
                  addAgent(role, { x: 80 + nodeSeq * 24, y: 60 + nodeSeq * 72 });
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
            nodes={nodes}
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
                  disabled
                  title="The engine that executes a graph arrives in M4-1"
                >
                  Run
                </button>
              </div>
              <p className="brief__note">
                Running a graph arrives with the engine. The brief and its files are kept with the
                automation until then.
              </p>
            </div>
          )}
        </section>
      </div>

      <aside className="canvas__inspector scroll" aria-label="Step">
        {selected ? (
          <>
            <p className="canvas__section">{selected.data.role.name}</p>
            <p className="canvas__prompt">{selected.data.role.systemPrompt}</p>

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
                value={selected.data.binding?.key ?? ''}
                onChange={(event) => {
                  bind(event.target.value);
                }}
              >
                <option value="">Choose a model</option>
                {choices.map((choice) => (
                  <option key={choice.key} value={choice.key}>
                    {choice.connectionLabel} · {choice.model}
                  </option>
                ))}
              </select>
            )}

            <p className="canvas__section">Allowed tools</p>
            <div className="canvas__tags">
              {selected.data.role.toolAllowlist.length === 0 ? (
                <span className="tag">None</span>
              ) : (
                selected.data.role.toolAllowlist.map((tool) => (
                  <span key={tool} className="tag">
                    {tool}
                  </span>
                ))
              )}
            </div>

            <p className="canvas__section">Limits</p>
            <div className="canvas__tags">
              <span className="tag">{selected.data.role.maxIterations} iterations max</span>
              <span className="tag">
                {selected.data.role.maxCostUsd === null
                  ? 'No cost cap'
                  : `$${selected.data.role.maxCostUsd.toFixed(2)} cap`}
              </span>
            </div>
          </>
        ) : (
          <p className="canvas__prompt">
            Select a step to choose its model and see what it may do.
          </p>
        )}
      </aside>
    </div>
  );
}

export interface CanvasProps {
  goal: string;
  /** A draft from the Home planner, turned into nodes on arrival. */
  template?: AutomationTemplate | null;
}

export function CanvasView({ goal, template = null }: CanvasProps): JSX.Element {
  // The provider owns the viewport, so `screenToFlowPosition` can turn a drop
  // at a screen coordinate into the right place on a panned or zoomed canvas.
  return (
    <ReactFlowProvider>
      <CanvasInner goal={goal} template={template} />
    </ReactFlowProvider>
  );
}
