import { describe, expect, test } from "vitest";
import type { SwarmCardViewModel } from "./swarm-cards";
import { buildSwarmGraph, layoutSwarmGraph, SWARM_GRAPH_NODE_TYPE } from "./swarm-graph-model";

const ROOT_ID = "parent-1";
const ROOT_TITLE = "Parent Agent";
const BASE_TS = "2026-07-12T10:00:00.000Z";

function makeCard(
  overrides: Partial<SwarmCardViewModel> & Pick<SwarmCardViewModel, "key" | "subagentId">,
): SwarmCardViewModel {
  return {
    kind: "paseo",
    parentAgentId: ROOT_ID,
    provider: "claude",
    title: overrides.title ?? overrides.subagentId,
    description: null,
    status: "completed",
    displayState: "completed",
    toolCallCount: 0,
    lastActivityPreview: null,
    createdAt: BASE_TS,
    updatedAt: BASE_TS,
    durationMs: 0,
    ...overrides,
  };
}

describe("buildSwarmGraph", () => {
  test("empty cards yields only the root node and zero edges", () => {
    const graph = buildSwarmGraph({
      cards: [],
      rootAgentId: ROOT_ID,
      rootTitle: ROOT_TITLE,
    });

    expect(graph.nodes).toHaveLength(1);
    expect(graph.nodes[0]).toMatchObject({
      id: `root:${ROOT_ID}`,
      data: {
        card: null,
        isRoot: true,
        title: ROOT_TITLE,
        subtitle: null,
      },
    });
    expect(graph.edges).toEqual([]);
  });

  test("every node carries the custom xyflow node type (else ReactFlow renders empty default nodes)", () => {
    const graph = buildSwarmGraph({
      cards: [makeCard({ key: "card-a", subagentId: "a" })],
      rootAgentId: ROOT_ID,
      rootTitle: ROOT_TITLE,
    });

    for (const node of graph.nodes) {
      expect(node.type).toBe(SWARM_GRAPH_NODE_TYPE);
    }
  });

  test("three flat children all link to root; only running edges are animated", () => {
    const cards = [
      makeCard({
        key: "card-a",
        subagentId: "a",
        title: "A",
        status: "running",
        displayState: "working",
        lastActivityPreview: "reading",
      }),
      makeCard({
        key: "card-b",
        subagentId: "b",
        title: "B",
        status: "completed",
        displayState: "completed",
      }),
      makeCard({
        key: "card-c",
        subagentId: "c",
        title: "C",
        status: "failed",
        displayState: "failed",
      }),
    ];

    const graph = buildSwarmGraph({
      cards,
      rootAgentId: ROOT_ID,
      rootTitle: ROOT_TITLE,
    });

    expect(graph.nodes).toHaveLength(4);
    expect(graph.edges).toHaveLength(3);

    for (const edge of graph.edges) {
      expect(edge.source).toBe(`root:${ROOT_ID}`);
    }

    const byId = Object.fromEntries(graph.edges.map((e) => [e.id, e]));
    expect(byId["edge:card-a"]?.animated).toBe(true);
    expect(byId["edge:card-b"]?.animated).toBe(false);
    expect(byId["edge:card-c"]?.animated).toBe(false);

    const nodeA = graph.nodes.find((n) => n.id === "card-a");
    expect(nodeA?.data).toMatchObject({
      isRoot: false,
      title: "A",
      subtitle: "reading",
      card: cards[0],
    });
  });

  test("multi-level: B parentAgentId is A subagentId → edge A→B", () => {
    const cardA = makeCard({
      key: "card-a",
      subagentId: "a",
      title: "A",
      parentAgentId: ROOT_ID,
    });
    const cardB = makeCard({
      key: "card-b",
      subagentId: "b",
      title: "B",
      parentAgentId: "a",
    });

    const graph = buildSwarmGraph({
      cards: [cardA, cardB],
      rootAgentId: ROOT_ID,
      rootTitle: ROOT_TITLE,
    });

    const edgeB = graph.edges.find((e) => e.id === "edge:card-b");
    expect(edgeB).toMatchObject({
      source: "card-a",
      target: "card-b",
    });
    const edgeA = graph.edges.find((e) => e.id === "edge:card-a");
    expect(edgeA).toMatchObject({
      source: `root:${ROOT_ID}`,
      target: "card-a",
    });
  });

  test("orphan parent hangs off the root", () => {
    const orphan = makeCard({
      key: "card-orphan",
      subagentId: "orphan",
      title: "Orphan",
      parentAgentId: "missing-parent",
    });

    const graph = buildSwarmGraph({
      cards: [orphan],
      rootAgentId: ROOT_ID,
      rootTitle: ROOT_TITLE,
    });

    expect(graph.edges).toEqual([
      {
        id: "edge:card-orphan",
        source: `root:${ROOT_ID}`,
        target: "card-orphan",
        animated: false,
        data: { kind: "spawn" },
      },
    ]);
  });

  test('kind="provider" cards enter the graph normally', () => {
    const card = makeCard({
      key: "prov-1",
      subagentId: "p1",
      kind: "provider",
      title: "Provider child",
      status: "running",
      displayState: "working",
    });

    const graph = buildSwarmGraph({
      cards: [card],
      rootAgentId: ROOT_ID,
      rootTitle: ROOT_TITLE,
    });

    expect(graph.nodes).toHaveLength(2);
    expect(graph.nodes.find((n) => n.id === "prov-1")?.data.card?.kind).toBe("provider");
    expect(graph.edges[0]).toMatchObject({
      id: "edge:prov-1",
      source: `root:${ROOT_ID}`,
      target: "prov-1",
      animated: true,
    });
  });

  test("sibling dep edge A→B coexists with spawn edges; unknown and root deps skipped", () => {
    const cardA = makeCard({
      key: "card-a",
      subagentId: "a",
      title: "A",
      parentAgentId: ROOT_ID,
    });
    const cardB = makeCard({
      key: "card-b",
      subagentId: "b",
      title: "B",
      parentAgentId: ROOT_ID,
      dependsOn: ["a", "missing-dep", ROOT_ID],
    });

    const graph = buildSwarmGraph({
      cards: [cardA, cardB],
      rootAgentId: ROOT_ID,
      rootTitle: ROOT_TITLE,
    });

    const spawnIds = graph.edges.filter((e) => e.data?.kind === "spawn").map((e) => e.id);
    expect(spawnIds.sort()).toEqual(["edge:card-a", "edge:card-b"]);
    for (const edge of graph.edges.filter((e) => e.data?.kind === "spawn")) {
      expect(edge.data).toEqual({ kind: "spawn" });
    }

    const depEdges = graph.edges.filter((e) => e.data?.kind === "dep");
    expect(depEdges).toHaveLength(1);
    expect(depEdges[0]).toMatchObject({
      id: "dep:card-a->card-b",
      source: "card-a",
      target: "card-b",
      animated: false,
      data: { kind: "dep" },
    });
  });

  test("dep pointing only at root draws no dep edge", () => {
    const card = makeCard({
      key: "card-a",
      subagentId: "a",
      title: "A",
      dependsOn: [ROOT_ID],
    });

    const graph = buildSwarmGraph({
      cards: [card],
      rootAgentId: ROOT_ID,
      rootTitle: ROOT_TITLE,
    });

    expect(graph.edges).toHaveLength(1);
    expect(graph.edges[0]).toMatchObject({
      id: "edge:card-a",
      data: { kind: "spawn" },
    });
    expect(graph.edges.some((e) => e.data?.kind === "dep")).toBe(false);
  });

  test("unknown dependsOn id draws no dep edge", () => {
    const card = makeCard({
      key: "card-a",
      subagentId: "a",
      title: "A",
      dependsOn: ["ghost"],
    });

    const graph = buildSwarmGraph({
      cards: [card],
      rootAgentId: ROOT_ID,
      rootTitle: ROOT_TITLE,
    });

    expect(graph.edges).toHaveLength(1);
    expect(graph.edges[0]?.data).toEqual({ kind: "spawn" });
  });
});

describe("layoutSwarmGraph", () => {
  test("all node positions are finite numbers; deeper LR nodes have greater x", () => {
    const cardA = makeCard({
      key: "card-a",
      subagentId: "a",
      title: "A",
      parentAgentId: ROOT_ID,
    });
    const cardB = makeCard({
      key: "card-b",
      subagentId: "b",
      title: "B",
      parentAgentId: "a",
    });

    const built = buildSwarmGraph({
      cards: [cardA, cardB],
      rootAgentId: ROOT_ID,
      rootTitle: ROOT_TITLE,
    });

    const originalNodesSnapshot = structuredClone(built.nodes);
    const laid = layoutSwarmGraph(built, { direction: "LR" });

    // does not mutate input
    expect(built.nodes).toEqual(originalNodesSnapshot);

    for (const node of laid.nodes) {
      expect(Number.isFinite(node.position.x)).toBe(true);
      expect(Number.isFinite(node.position.y)).toBe(true);
    }

    const root = laid.nodes.find((n) => n.id === `root:${ROOT_ID}`)!;
    const a = laid.nodes.find((n) => n.id === "card-a")!;
    const b = laid.nodes.find((n) => n.id === "card-b")!;

    expect(a.position.x).toBeGreaterThan(root.position.x);
    expect(b.position.x).toBeGreaterThan(a.position.x);
  });
});
