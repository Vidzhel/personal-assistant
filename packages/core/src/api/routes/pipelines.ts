import type { FastifyInstance } from 'fastify';
import type { PipelineEngine } from '../../pipeline-engine/pipeline-engine.ts';

export function registerPipelineRoutes(
  app: FastifyInstance,
  deps: { pipelineEngine: PipelineEngine },
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
}
