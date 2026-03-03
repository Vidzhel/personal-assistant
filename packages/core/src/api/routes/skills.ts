import type { FastifyInstance } from 'fastify';
import type { ApiDeps } from '../server.ts';

export function registerSkillRoutes(app: FastifyInstance, deps: ApiDeps): void {
  app.get('/api/skills', async () => {
    const skills = deps.skillRegistry.getAllSkills();
    return skills.map((s) => ({
      name: s.manifest.name,
      displayName: s.manifest.displayName,
      version: s.manifest.version,
      description: s.manifest.description,
      capabilities: s.manifest.capabilities,
      mcpServers: Object.keys(s.getMcpServers()),
      agentDefinitions: Object.keys(s.getAgentDefinitions()),
    }));
  });
}
