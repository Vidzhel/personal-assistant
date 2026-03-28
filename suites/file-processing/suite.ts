import { defineSuite, SUITE_FILE_PROCESSING } from '@raven/shared';

export default defineSuite({
  name: SUITE_FILE_PROCESSING,
  displayName: 'File Processing',
  version: '0.1.0',
  description: 'Document reading/creation, media processing via ffmpeg, and format conversion',
  capabilities: ['mcp-server', 'agent-definition'],
  requiresEnv: [],
  services: [],
  vendorPlugins: ['anthropic-skills', 'claude-plugin-marketplace/plugins/ffmpeg-master'],
});
