import type { FastifyInstance } from 'fastify';
import type { PipelineEngine } from '../../pipeline-engine/pipeline-engine.ts';
import type { PipelineStore } from '../../pipeline-engine/pipeline-store.ts';

export function registerPipelineRoutes(
  app: FastifyInstance,
  deps: { pipelineEngine: PipelineEngine; pipelineStore?: PipelineStore },
): void {
  app.get('/api/pipelines', async () => {
    return deps.pipelineEngine.getAllPipelines();
  });

  app.get<{ Params: { name: string } }>('/api/pipelines/:name', async (req, reply) => {
    const pipeline = deps.pipelineEngine.getPipeline(req.params.name);
    if (!pipeline) {
      return reply.status(404).send({ error: 'Pipeline not found' });
    }
    return pipeline;
  });

  app.post<{ Params: { name: string } }>('/api/pipelines/:name/trigger', async (req, reply) => {
    const pipeline = deps.pipelineEngine.getPipeline(req.params.name);
    if (!pipeline) {
      return reply.status(404).send({ error: 'Pipeline not found' });
    }
    if (!pipeline.config.enabled) {
      return reply.status(400).send({ error: 'Pipeline is disabled' });
    }

    // Non-blocking: start execution in background, return runId immediately
    const { runId, execution } = deps.pipelineEngine.triggerPipeline(req.params.name, 'manual');

    // Fire and forget — errors are logged and stored in pipeline_runs by the executor
    execution.catch(() => {});

    return reply.status(202).send({ runId, status: 'started' });
  });

  app.get<{ Params: { name: string }; Querystring: { limit?: string } }>(
    '/api/pipelines/:name/runs',
    async (req, reply) => {
      if (!deps.pipelineStore) {
        return reply.status(503).send({ error: 'Pipeline store not available' });
      }
      const limit = Math.min(parseInt(req.query.limit ?? '10', 10) || 10, 100);
      return deps.pipelineStore.getRecentRuns(req.params.name, limit);
    },
  );
}
