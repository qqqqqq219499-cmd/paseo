/**
 * Pure swarm collaboration-graph model + dagre layout.
 * Consumed only by .web.tsx graph UI (not native).
 */
import { graphlib, layout as dagreLayout } from "@dagrejs/dagre";
import type { Edge, Node } from "@xyflow/react";
import type { SwarmCardViewModel } from "./swarm-cards";

export interface SwarmGraphNodeData extends Record<string, unknown> {
  /** null only for the root node (parent agent itself) */
  card: SwarmCardViewModel | null;
  isRoot: boolean;
  title: string;
  subtitle: string | null;
}

export interface SwarmGraph {
  nodes: Node<SwarmGraphNodeData>[];
  edges: Edge[];
}

const DEFAULT_DIRECTION = "LR" as const;
const DEFAULT_NODE_WIDTH = 260;
const DEFAULT_NODE_HEIGHT = 96;
const DEFAULT_NODESEP = 36;
const DEFAULT_RANKSEP = 72;

function rootNodeId(rootAgentId: string): string {
  return `root:${rootAgentId}`;
}

export function buildSwarmGraph(input: {
  cards: SwarmCardViewModel[];
  rootAgentId: string;
  rootTitle: string;
}): SwarmGraph {
  const { cards, rootAgentId, rootTitle } = input;
  const rootId = rootNodeId(rootAgentId);

  const nodes: Node<SwarmGraphNodeData>[] = [
    {
      id: rootId,
      position: { x: 0, y: 0 },
      data: {
        card: null,
        isRoot: true,
        title: rootTitle,
        subtitle: null,
      },
    },
  ];

  const cardBySubagentId = new Map<string, SwarmCardViewModel>();
  for (const card of cards) {
    cardBySubagentId.set(card.subagentId, card);
  }

  for (const card of cards) {
    nodes.push({
      id: card.key,
      position: { x: 0, y: 0 },
      data: {
        card,
        isRoot: false,
        title: card.title,
        subtitle: card.lastActivityPreview,
      },
    });
  }

  const edges: Edge[] = [];
  for (const card of cards) {
    let source: string;
    if (card.parentAgentId === rootAgentId) {
      source = rootId;
    } else {
      const parentCard = cardBySubagentId.get(card.parentAgentId);
      source = parentCard ? parentCard.key : rootId;
    }

    edges.push({
      id: `edge:${card.key}`,
      source,
      target: card.key,
      animated: card.status === "running",
      data: { kind: "spawn" },
    });
  }

  for (const card of cards) {
    const deps = card.dependsOn;
    if (!deps || deps.length === 0) continue;
    for (const depId of deps) {
      if (depId === rootAgentId) continue;
      const srcCard = cardBySubagentId.get(depId);
      if (!srcCard) continue;
      edges.push({
        id: `dep:${srcCard.key}->${card.key}`,
        source: srcCard.key,
        target: card.key,
        animated: false,
        data: { kind: "dep" },
      });
    }
  }

  return { nodes, edges };
}

export function layoutSwarmGraph(
  graph: SwarmGraph,
  options?: { direction?: "LR" | "TB"; nodeWidth?: number; nodeHeight?: number },
): SwarmGraph {
  const direction = options?.direction ?? DEFAULT_DIRECTION;
  const nodeWidth = options?.nodeWidth ?? DEFAULT_NODE_WIDTH;
  const nodeHeight = options?.nodeHeight ?? DEFAULT_NODE_HEIGHT;

  const g = new graphlib.Graph();
  g.setDefaultEdgeLabel(() => ({}));
  g.setGraph({
    rankdir: direction,
    nodesep: DEFAULT_NODESEP,
    ranksep: DEFAULT_RANKSEP,
  });

  for (const node of graph.nodes) {
    g.setNode(node.id, { width: nodeWidth, height: nodeHeight });
  }
  for (const edge of graph.edges) {
    g.setEdge(edge.source, edge.target);
  }

  dagreLayout(g);

  const nodes: Node<SwarmGraphNodeData>[] = graph.nodes.map((node) => {
    const laid = g.node(node.id);
    const x = typeof laid?.x === "number" ? laid.x - nodeWidth / 2 : 0;
    const y = typeof laid?.y === "number" ? laid.y - nodeHeight / 2 : 0;
    return {
      ...node,
      position: { x, y },
    };
  });

  const edges: Edge[] = graph.edges.map((edge) => ({ ...edge }));

  return { nodes, edges };
}
