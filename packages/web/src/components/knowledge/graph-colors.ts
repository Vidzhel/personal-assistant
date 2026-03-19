import type { GraphNode } from '@/stores/knowledge-store';
import { DOMAIN_COLORS, PERMANENCE_COLORS } from './ColorLegend';

const NEUTRAL_COLOR = '#94a3b8';
const DEGREE_HIGH_COLOR = '#f97316';
const RECENCY_HIGH_COLOR = '#22d3ee';
const RELEVANCE_HIGH_COLOR = '#ef4444';
const NINETY_DAYS_MS = 7_776_000_000; // 90 * 24 * 60 * 60 * 1000
const HASH_SHIFT = 5;
const CLUSTER_COLORS = [
  '#4ade80',
  '#60a5fa',
  '#facc15',
  '#f472b6',
  '#a78bfa',
  '#f97316',
  '#22d3ee',
  '#14b8a6',
  '#e879f9',
  '#84cc16',
];

const HEX_RADIX = 16;
const R_START = 1;
const R_END = 3;
const G_START = 3;
const G_END = 5;
const B_START = 5;
const B_END = 7;

function parseHex(hex: string): [number, number, number] {
  return [
    parseInt(hex.slice(R_START, R_END), HEX_RADIX),
    parseInt(hex.slice(G_START, G_END), HEX_RADIX),
    parseInt(hex.slice(B_START, B_END), HEX_RADIX),
  ];
}

function lerpColor(a: string, b: string, t: number): string {
  const ca = parseHex(a);
  const cb = parseHex(b);
  const ch = ca.map((v, i) => Math.round(v + (cb[i] - v) * t));
  return `rgb(${ch[0]},${ch[1]},${ch[2]})`;
}

interface ColorContext {
  node: GraphNode;
  dimension: string;
  searchResults: Array<{ bubbleId: string; score: number }>;
  maxDegree: number;
}

// eslint-disable-next-line complexity -- one branch per color dimension
export function getNodeColor(ctx: ColorContext): string {
  const { node, dimension, searchResults, maxDegree } = ctx;

  if (dimension === 'domain') {
    return DOMAIN_COLORS[node.domain ?? 'default'] ?? DOMAIN_COLORS.default;
  }
  if (dimension === 'permanence') {
    return PERMANENCE_COLORS[node.permanence] ?? PERMANENCE_COLORS.normal;
  }
  if (dimension === 'connectionDegree') {
    const ratio = maxDegree > 0 ? node.connectionDegree / maxDegree : 0;
    return lerpColor(NEUTRAL_COLOR, DEGREE_HIGH_COLOR, ratio);
  }
  if (dimension === 'recency') {
    const age = Date.now() - new Date(node.createdAt).getTime();
    const ratio = Math.max(0, 1 - age / NINETY_DAYS_MS);
    return lerpColor(NEUTRAL_COLOR, RECENCY_HIGH_COLOR, ratio);
  }
  if (dimension === 'cluster') {
    if (!node.clusterLabel) return NEUTRAL_COLOR;
    let hash = 0;
    for (let i = 0; i < node.clusterLabel.length; i++) {
      hash = ((hash << HASH_SHIFT) - hash + node.clusterLabel.charCodeAt(i)) | 0;
    }
    return CLUSTER_COLORS[Math.abs(hash) % CLUSTER_COLORS.length];
  }
  if (dimension === 'relevance') {
    const match = searchResults.find((r) => r.bubbleId === node.id);
    if (!match) return NEUTRAL_COLOR;
    return lerpColor(NEUTRAL_COLOR, RELEVANCE_HIGH_COLOR, match.score);
  }
  return NEUTRAL_COLOR;
}

const DEFAULT_CONFIDENCE = 0.5;
const LINK_BASE_OPACITY = 0.6;
const LINK_OPACITY_RANGE = 0.4;

export function getLinkOpacity(confidence: number | null): string {
  const conf = confidence ?? DEFAULT_CONFIDENCE;
  return `rgba(148,163,184,${LINK_BASE_OPACITY + conf * LINK_OPACITY_RANGE})`;
}

export const LINK_DIMMED = 'rgba(148,163,184,0.05)';

export function getLinkWidth(confidence: number | null): number {
  const conf = confidence ?? DEFAULT_CONFIDENCE;
  return conf * 2 + 2;
}
