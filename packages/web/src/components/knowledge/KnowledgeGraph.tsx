'use client';

import dynamic from 'next/dynamic';
import { useGraphBehaviors } from './graph-hooks';

const ForceGraph2D = dynamic(() => import('react-force-graph-2d'), { ssr: false });

export function KnowledgeGraph() {
  const {
    graphRef,
    graphData,
    handleNodeClick,
    nodeCanvasObject,
    linkColor,
    linkWidth,
    isTimeline,
    cooldownTicks,
    d3AlphaDecay,
  } = useGraphBehaviors();

  return (
    <div className="relative w-full h-full">
      <ForceGraph2D
        ref={graphRef as React.Ref<never>}
        graphData={graphData}
        nodeId="id"
        nodeCanvasObject={nodeCanvasObject}
        nodeCanvasObjectMode={() => 'replace'}
        linkColor={linkColor}
        linkWidth={linkWidth}
        onNodeClick={handleNodeClick}
        onNodeDragEnd={(node: { fx?: number; fy?: number; x?: number; y?: number }) => {
          node.fx = node.x;
          node.fy = node.y;
        }}
        cooldownTicks={cooldownTicks}
        enableNodeDrag={!isTimeline}
        d3AlphaDecay={d3AlphaDecay}
        width={undefined}
        height={undefined}
      />
    </div>
  );
}
