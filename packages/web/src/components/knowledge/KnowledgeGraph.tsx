'use client';

import { useRef, useState, useEffect } from 'react';
import dynamic from 'next/dynamic';
import { useGraphBehaviors } from './graph-hooks';

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- dynamic import loses generic type params
const ForceGraph2D = dynamic(() => import('react-force-graph-2d'), { ssr: false }) as any;

function useContainerDims() {
  const containerRef = useRef<HTMLDivElement>(null);
  const [dims, setDims] = useState({ w: 0, h: 0 });

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    const update = () => setDims({ w: el.clientWidth, h: el.clientHeight });
    update();

    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  return { containerRef, dims };
}

export function KnowledgeGraph() {
  const { containerRef, dims } = useContainerDims();
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
    <div ref={containerRef} className="relative w-full h-full">
      {dims.w > 0 && dims.h > 0 && (
        <ForceGraph2D
          ref={graphRef}
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
          width={dims.w}
          height={dims.h}
        />
      )}
    </div>
  );
}
