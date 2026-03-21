'use client';

import { useCallback, useRef, useEffect, useMemo } from 'react';
import { useKnowledgeStore, getFilteredData, type GraphNode } from '@/stores/knowledge-store';
import { getNodeColor, getLinkOpacity, LINK_DIMMED, getLinkWidth } from './graph-colors';

const COOLDOWN_TICKS = 200;
const CHARGE_STRENGTH = -120;
const LINK_DISTANCE = 80;
const NODE_BASE_SIZE = 4;
const NODE_MAX_SIZE = 14;
const LABEL_FONT_SIZE = 10;
const DIM_OPACITY = 0.15;
const CENTER_ANIM_MS = 500;
const SEARCH_ZOOM = 2;
const LABEL_MAX_CHARS = 30;
const D3_DEFAULT_DECAY = 0.0228;

interface GraphForceRef {
  centerAt: (x: number, y: number, ms: number) => void;
  zoom: (k: number, ms: number) => void;
  d3Force: (name: string) => { strength: (n: number) => void; distance?: (n: number) => void };
}

interface LinkObj {
  source: string | { id: string };
  target: string | { id: string };
  relationshipType: string;
  confidence: number | null;
}

// eslint-disable-next-line max-lines-per-function -- hook aggregates multiple graph behaviors
export function useGraphBehaviors(): {
  graphRef: React.RefObject<GraphForceRef | null>;
  graphData: { nodes: Array<GraphNode & Record<string, unknown>>; links: LinkObj[] };
  handleNodeClick: (node: { id?: string }, event: MouseEvent) => void;
  nodeCanvasObject: (
    node: { id?: string; x?: number; y?: number },
    ctx: CanvasRenderingContext2D,
  ) => void;
  linkColor: (link: LinkObj) => string;
  linkWidth: (link: LinkObj) => number;
  isTimeline: boolean;
  cooldownTicks: number;
  d3AlphaDecay: number;
} {
  const graphRef = useRef<GraphForceRef | null>(null);
  const state = useKnowledgeStore();
  const { filteredNodes, filteredEdges } = getFilteredData(state);
  const { colorDimension, searchResults, selectedNodeIds, highlightedNodeIds } = state;
  const isTimeline = state.viewMode === 'timeline';

  const maxDegree = useMemo(
    () => Math.max(1, ...filteredNodes.map((n) => n.connectionDegree)),
    [filteredNodes],
  );

  const searchResultIds = useMemo(
    () => new Set(searchResults.map((r) => r.bubbleId)),
    [searchResults],
  );

  const highlightedSet = useMemo(() => new Set(highlightedNodeIds), [highlightedNodeIds]);

  const hasHighlight = highlightedNodeIds.length > 0;

  const graphData = useMemo(
    () => ({
      nodes: filteredNodes.map((n) => ({ ...n })),
      links: filteredEdges.map((e) => ({ ...e })),
    }),
    [filteredNodes, filteredEdges],
  );

  useEffect(() => {
    const fg = graphRef.current;
    if (!fg) return;
    try {
      fg.d3Force('charge')?.strength(CHARGE_STRENGTH);
      const linkForce = fg.d3Force('link');
      if (linkForce?.distance) linkForce.distance(LINK_DISTANCE);
    } catch {
      // Force not yet ready
    }
  }, [graphData]);

  useEffect(() => {
    if (searchResults.length === 0 || !graphRef.current) return;
    const matchedNodes = filteredNodes.filter((n) => searchResultIds.has(n.id));
    if (matchedNodes.length === 0) return;
    type SimNode = GraphNode & { x?: number; y?: number };
    const simNodes = matchedNodes as SimNode[];
    const avgX = simNodes.reduce((s, n) => s + (n.x ?? 0), 0) / simNodes.length;
    const avgY = simNodes.reduce((s, n) => s + (n.y ?? 0), 0) / simNodes.length;
    graphRef.current.centerAt(avgX, avgY, CENTER_ANIM_MS);
    graphRef.current.zoom(SEARCH_ZOOM, CENTER_ANIM_MS);
  }, [searchResults, filteredNodes, searchResultIds]);

  useEffect(() => {
    if (!hasHighlight || !graphRef.current) return;
    const matchedNodes = filteredNodes.filter((n) => highlightedSet.has(n.id));
    if (matchedNodes.length === 0) return;
    type SimNode = GraphNode & { x?: number; y?: number };
    const simNodes = matchedNodes as SimNode[];
    const avgX = simNodes.reduce((s, n) => s + (n.x ?? 0), 0) / simNodes.length;
    const avgY = simNodes.reduce((s, n) => s + (n.y ?? 0), 0) / simNodes.length;
    graphRef.current.centerAt(avgX, avgY, CENTER_ANIM_MS);
    graphRef.current.zoom(SEARCH_ZOOM, CENTER_ANIM_MS);
  }, [hasHighlight, highlightedSet, filteredNodes]);

  const handleNodeClick = useCallback(
    (node: { id?: string }, event: MouseEvent) => {
      if (!node.id) return;
      if (event.shiftKey) state.toggleMultiSelect(String(node.id));
      else state.selectNode(String(node.id));
    },
    [state],
  );

  const nodeCanvasObject = useCallback(
    (node: { id?: string; x?: number; y?: number }, ctx: CanvasRenderingContext2D) => {
      const gNode = filteredNodes.find((n) => n.id === node.id);
      if (!gNode || node.x === undefined || node.y === undefined) return;

      const isDimmed =
        (searchResults.length > 0 && !searchResultIds.has(gNode.id)) ||
        (hasHighlight && !highlightedSet.has(gNode.id));
      const size =
        NODE_BASE_SIZE + (gNode.connectionDegree / maxDegree) * (NODE_MAX_SIZE - NODE_BASE_SIZE);
      const color = getNodeColor({
        node: gNode,
        dimension: colorDimension,
        searchResults,
        maxDegree,
      });

      ctx.globalAlpha = isDimmed ? DIM_OPACITY : 1;
      ctx.beginPath();
      ctx.arc(node.x, node.y, size, 0, 2 * Math.PI);
      ctx.fillStyle = color;
      ctx.fill();
      if (selectedNodeIds.includes(gNode.id)) {
        ctx.strokeStyle = '#fff';
        ctx.lineWidth = 2;
        ctx.stroke();
      }
      ctx.font = `${LABEL_FONT_SIZE}px sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'top';
      ctx.fillStyle = isDimmed ? 'rgba(148,163,184,0.3)' : 'rgba(255,255,255,0.85)';
      ctx.fillText(gNode.title.slice(0, LABEL_MAX_CHARS), node.x, node.y + size + 2);
      ctx.globalAlpha = 1;
    },
    [
      filteredNodes,
      colorDimension,
      searchResults,
      searchResultIds,
      selectedNodeIds,
      maxDegree,
      hasHighlight,
      highlightedSet,
    ],
  );

  const linkColor = useCallback(
    (link: LinkObj) => {
      const sourceId = typeof link.source === 'string' ? link.source : link.source.id;
      const targetId = typeof link.target === 'string' ? link.target : link.target.id;
      if (searchResults.length > 0) {
        if (!searchResultIds.has(sourceId) && !searchResultIds.has(targetId)) return LINK_DIMMED;
      }
      if (hasHighlight) {
        if (!highlightedSet.has(sourceId) && !highlightedSet.has(targetId)) return LINK_DIMMED;
      }
      return getLinkOpacity(link.confidence);
    },
    [searchResults, searchResultIds, hasHighlight, highlightedSet],
  );

  const linkWidth = useCallback((link: LinkObj) => getLinkWidth(link.confidence), []);

  return {
    graphRef,
    graphData,
    handleNodeClick,
    nodeCanvasObject,
    linkColor,
    linkWidth,
    isTimeline,
    cooldownTicks: isTimeline ? 0 : COOLDOWN_TICKS,
    d3AlphaDecay: isTimeline ? 1 : D3_DEFAULT_DECAY,
  };
}
