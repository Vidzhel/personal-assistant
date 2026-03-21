import { create } from 'zustand';

export type GraphViewMode = 'links' | 'tags' | 'timeline' | 'clusters' | 'domains';
export type ColorDimension =
  | 'domain'
  | 'permanence'
  | 'connectionDegree'
  | 'recency'
  | 'cluster'
  | 'relevance';

export interface GraphNode {
  id: string;
  title: string;
  domain: string | null;
  permanence: 'temporary' | 'normal' | 'robust';
  tags: string[];
  clusterLabel: string | null;
  connectionDegree: number;
  createdAt: string;
  updatedAt: string;
  lastAccessedAt: string | null;
}

export interface GraphEdge {
  source: string;
  target: string;
  relationshipType: string;
  confidence: number | null;
}

export interface Filters {
  tags: string[];
  domains: string[];
  permanence: string[];
}

interface SearchResult {
  bubbleId: string;
  score: number;
}

interface KnowledgeState {
  nodes: GraphNode[];
  edges: GraphEdge[];
  viewMode: GraphViewMode;
  colorDimension: ColorDimension;
  filters: Filters;
  searchResults: SearchResult[];
  selectedNodeIds: string[];
  multiSelectEnabled: boolean;
  highlightedNodeIds: string[];
  loading: boolean;

  setGraphData: (nodes: GraphNode[], edges: GraphEdge[]) => void;
  setViewMode: (mode: GraphViewMode) => void;
  setColorDimension: (dim: ColorDimension) => void;
  setFilters: (filters: Filters) => void;
  setSearchResults: (results: SearchResult[]) => void;
  selectNode: (id: string) => void;
  toggleMultiSelect: (id: string) => void;
  clearSelection: () => void;
  setHighlightedNodeIds: (ids: string[]) => void;
  setLoading: (loading: boolean) => void;
}

function applyFilters(nodes: GraphNode[], filters: Filters): Set<string> {
  const ids = new Set<string>();
  const hasTagFilter = filters.tags.length > 0;
  const hasDomainFilter = filters.domains.length > 0;
  const hasPermanenceFilter = filters.permanence.length > 0;

  for (const node of nodes) {
    if (hasTagFilter && !node.tags.some((t) => filters.tags.includes(t))) continue;
    if (hasDomainFilter && (node.domain === null || !filters.domains.includes(node.domain)))
      continue;
    if (hasPermanenceFilter && !filters.permanence.includes(node.permanence)) continue;
    ids.add(node.id);
  }
  return ids;
}

export function getFilteredData(state: KnowledgeState): {
  filteredNodes: GraphNode[];
  filteredEdges: GraphEdge[];
} {
  const hasAnyFilter =
    state.filters.tags.length > 0 ||
    state.filters.domains.length > 0 ||
    state.filters.permanence.length > 0;

  if (!hasAnyFilter) {
    return { filteredNodes: state.nodes, filteredEdges: state.edges };
  }

  const visibleIds = applyFilters(state.nodes, state.filters);
  const filteredNodes = state.nodes.filter((n) => visibleIds.has(n.id));
  const filteredEdges = state.edges.filter(
    (e) => visibleIds.has(e.source) && visibleIds.has(e.target),
  );
  return { filteredNodes, filteredEdges };
}

export const useKnowledgeStore = create<KnowledgeState>((set) => ({
  nodes: [],
  edges: [],
  viewMode: 'links',
  colorDimension: 'domain',
  filters: { tags: [], domains: [], permanence: [] },
  searchResults: [],
  selectedNodeIds: [],
  multiSelectEnabled: false,
  highlightedNodeIds: [],
  loading: false,

  setGraphData: (nodes, edges) => set({ nodes, edges }),
  setViewMode: (viewMode) => set({ viewMode }),
  setColorDimension: (colorDimension) => set({ colorDimension }),
  setFilters: (filters) => set({ filters }),
  setSearchResults: (searchResults) => set({ searchResults }),
  selectNode: (id) => set({ selectedNodeIds: [id] }),
  toggleMultiSelect: (id) =>
    set((state) => ({
      multiSelectEnabled: true,
      selectedNodeIds: state.selectedNodeIds.includes(id)
        ? state.selectedNodeIds.filter((x) => x !== id)
        : [...state.selectedNodeIds, id],
    })),
  clearSelection: () => set({ selectedNodeIds: [], multiSelectEnabled: false }),
  setHighlightedNodeIds: (highlightedNodeIds) => set({ highlightedNodeIds }),
  setLoading: (loading) => set({ loading }),
}));
