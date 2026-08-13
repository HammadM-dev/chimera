import { useCallback, useMemo, useRef, useState } from 'react';
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

function CanvasInner({ goal }: { goal: string }): JSX.Element {
  const roles = useRoles();
  const { choices, loaded } = useConnections();
  const [nodes, setNodes, onNodesChange] = useNodesState<AgentNode>([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const wrapper = useRef<HTMLDivElement | null>(null);
  const { screenToFlowPosition } = useReactFlow();

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
          },
        },
      ]);
      setSelectedId(id);
    },
    [setNodes],
  );

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

      <aside className="canvas__inspector scroll" aria-label="Step">
        {selected ? (
          <>
            <p className="canvas__section">{selected.data.role.name}</p>
            <p className="canvas__prompt">{selected.data.role.systemPrompt}</p>

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

export function CanvasView({ goal }: { goal: string }): JSX.Element {
  // The provider owns the viewport, so `screenToFlowPosition` can turn a drop
  // at a screen coordinate into the right place on a panned or zoomed canvas.
  return (
    <ReactFlowProvider>
      <CanvasInner goal={goal} />
    </ReactFlowProvider>
  );
}
