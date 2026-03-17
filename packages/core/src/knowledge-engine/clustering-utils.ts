import { cosineSimilarity } from './embeddings.ts';

/**
 * Agglomerative clustering with centroid-linkage.
 * Groups items by embedding similarity above a threshold.
 */
// eslint-disable-next-line max-lines-per-function, complexity -- clustering algorithm needs the full loop
export function agglomerativeCluster(
  items: Array<{ id: string; embedding: Float32Array }>,
  threshold: number,
): string[][] {
  if (items.length === 0) return [];

  const clusters: Map<number, string[]> = new Map();
  const clusterCentroids: Map<number, Float32Array> = new Map();

  // Initialize: each item is its own cluster
  for (let i = 0; i < items.length; i++) {
    clusters.set(i, [items[i].id]);
    clusterCentroids.set(i, items[i].embedding);
  }

  let nextId = items.length;

  while (true) {
    const clusterIds = [...clusters.keys()];
    if (clusterIds.length <= 1) break;

    let bestI = -1;
    let bestJ = -1;
    let bestSim = -1;

    for (let i = 0; i < clusterIds.length; i++) {
      for (let j = i + 1; j < clusterIds.length; j++) {
        const centA = clusterCentroids.get(clusterIds[i]);
        const centB = clusterCentroids.get(clusterIds[j]);
        if (!centA || !centB) continue;
        const sim = cosineSimilarity(centA, centB);
        if (sim > bestSim) {
          bestSim = sim;
          bestI = i;
          bestJ = j;
        }
      }
    }

    if (bestSim < threshold) break;

    // Merge clusters
    const membersA = clusters.get(clusterIds[bestI]) ?? [];
    const membersB = clusters.get(clusterIds[bestJ]) ?? [];
    const mergedMembers = [...membersA, ...membersB];
    const centA = clusterCentroids.get(clusterIds[bestI]);
    const centB = clusterCentroids.get(clusterIds[bestJ]);
    if (!centA || !centB) break;
    const newCentroid = new Float32Array(centA.length);
    for (let k = 0; k < centA.length; k++) {
      newCentroid[k] = (centA[k] + centB[k]) / 2;
    }

    clusters.delete(clusterIds[bestI]);
    clusters.delete(clusterIds[bestJ]);
    clusterCentroids.delete(clusterIds[bestI]);
    clusterCentroids.delete(clusterIds[bestJ]);

    clusters.set(nextId, mergedMembers);
    clusterCentroids.set(nextId, newCentroid);
    nextId++;
  }

  return [...clusters.values()];
}
