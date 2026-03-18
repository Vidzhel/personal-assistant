import { describe, it, expect, beforeEach } from 'vitest';
import {
  useKnowledgeStore,
  getFilteredData,
  type GraphNode,
  type GraphEdge,
} from '../stores/knowledge-store';

function makeNode(overrides: Partial<GraphNode> = {}): GraphNode {
  return {
    id: crypto.randomUUID(),
    title: 'Test Node',
    domain: null,
    permanence: 'normal',
    tags: [],
    clusterLabel: null,
    connectionDegree: 0,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    lastAccessedAt: null,
    ...overrides,
  };
}

function makeEdge(source: string, target: string): GraphEdge {
  return { source, target, relationshipType: 'related', confidence: 0.8 };
}

describe('Knowledge Store', () => {
  beforeEach(() => {
    const {
      setGraphData,
      setFilters,
      setSearchResults,
      clearSelection,
      setViewMode,
      setColorDimension,
    } = useKnowledgeStore.getState();
    setGraphData([], []);
    setFilters({ tags: [], domains: [], permanence: [] });
    setSearchResults([]);
    clearSelection();
    setViewMode('links');
    setColorDimension('domain');
  });

  it('sets graph data', () => {
    const node = makeNode({ title: 'Hello' });
    useKnowledgeStore.getState().setGraphData([node], []);
    const state = useKnowledgeStore.getState();
    expect(state.nodes).toHaveLength(1);
    expect(state.nodes[0].title).toBe('Hello');
  });

  it('filters by tag', () => {
    const a = makeNode({ tags: ['react'] });
    const b = makeNode({ tags: ['vue'] });
    const edge = makeEdge(a.id, b.id);
    useKnowledgeStore.getState().setGraphData([a, b], [edge]);
    useKnowledgeStore.getState().setFilters({ tags: ['react'], domains: [], permanence: [] });

    const { filteredNodes, filteredEdges } = getFilteredData(useKnowledgeStore.getState());
    expect(filteredNodes).toHaveLength(1);
    expect(filteredNodes[0].id).toBe(a.id);
    expect(filteredEdges).toHaveLength(0); // edge between filtered-out nodes
  });

  it('filters by domain', () => {
    const a = makeNode({ domain: 'health' });
    const b = makeNode({ domain: 'work' });
    useKnowledgeStore.getState().setGraphData([a, b], []);
    useKnowledgeStore.getState().setFilters({ tags: [], domains: ['health'], permanence: [] });

    const { filteredNodes } = getFilteredData(useKnowledgeStore.getState());
    expect(filteredNodes).toHaveLength(1);
    expect(filteredNodes[0].domain).toBe('health');
  });

  it('filters by permanence', () => {
    const a = makeNode({ permanence: 'temporary' });
    const b = makeNode({ permanence: 'robust' });
    useKnowledgeStore.getState().setGraphData([a, b], []);
    useKnowledgeStore.getState().setFilters({ tags: [], domains: [], permanence: ['robust'] });

    const { filteredNodes } = getFilteredData(useKnowledgeStore.getState());
    expect(filteredNodes).toHaveLength(1);
    expect(filteredNodes[0].permanence).toBe('robust');
  });

  it('combines multiple filters', () => {
    const a = makeNode({ tags: ['react'], domain: 'work', permanence: 'robust' });
    const b = makeNode({ tags: ['react'], domain: 'health', permanence: 'robust' });
    const c = makeNode({ tags: ['vue'], domain: 'work', permanence: 'temporary' });
    useKnowledgeStore.getState().setGraphData([a, b, c], []);
    useKnowledgeStore
      .getState()
      .setFilters({ tags: ['react'], domains: ['work'], permanence: ['robust'] });

    const { filteredNodes } = getFilteredData(useKnowledgeStore.getState());
    expect(filteredNodes).toHaveLength(1);
    expect(filteredNodes[0].id).toBe(a.id);
  });

  it('returns all nodes when no filters active', () => {
    const nodes = [makeNode(), makeNode(), makeNode()];
    useKnowledgeStore.getState().setGraphData(nodes, []);

    const { filteredNodes } = getFilteredData(useKnowledgeStore.getState());
    expect(filteredNodes).toHaveLength(3);
  });

  it('filters edges based on visible nodes', () => {
    const a = makeNode({ tags: ['keep'] });
    const b = makeNode({ tags: ['keep'] });
    const c = makeNode({ tags: ['drop'] });
    const ab = makeEdge(a.id, b.id);
    const ac = makeEdge(a.id, c.id);
    useKnowledgeStore.getState().setGraphData([a, b, c], [ab, ac]);
    useKnowledgeStore.getState().setFilters({ tags: ['keep'], domains: [], permanence: [] });

    const { filteredEdges } = getFilteredData(useKnowledgeStore.getState());
    expect(filteredEdges).toHaveLength(1);
    expect(filteredEdges[0].source).toBe(a.id);
    expect(filteredEdges[0].target).toBe(b.id);
  });

  it('selects a node', () => {
    useKnowledgeStore.getState().selectNode('abc');
    expect(useKnowledgeStore.getState().selectedNodeIds).toEqual(['abc']);
  });

  it('toggles multi-select', () => {
    useKnowledgeStore.getState().toggleMultiSelect('a');
    useKnowledgeStore.getState().toggleMultiSelect('b');
    expect(useKnowledgeStore.getState().selectedNodeIds).toEqual(['a', 'b']);

    useKnowledgeStore.getState().toggleMultiSelect('a');
    expect(useKnowledgeStore.getState().selectedNodeIds).toEqual(['b']);
  });

  it('clears selection', () => {
    useKnowledgeStore.getState().selectNode('a');
    useKnowledgeStore.getState().clearSelection();
    expect(useKnowledgeStore.getState().selectedNodeIds).toEqual([]);
    expect(useKnowledgeStore.getState().multiSelectEnabled).toBe(false);
  });

  it('sets view mode', () => {
    useKnowledgeStore.getState().setViewMode('clusters');
    expect(useKnowledgeStore.getState().viewMode).toBe('clusters');
  });

  it('sets color dimension', () => {
    useKnowledgeStore.getState().setColorDimension('recency');
    expect(useKnowledgeStore.getState().colorDimension).toBe('recency');
  });

  it('sets search results', () => {
    useKnowledgeStore.getState().setSearchResults([{ bubbleId: 'x', score: 0.9 }]);
    expect(useKnowledgeStore.getState().searchResults).toHaveLength(1);
    expect(useKnowledgeStore.getState().searchResults[0].score).toBe(0.9);
  });
});
