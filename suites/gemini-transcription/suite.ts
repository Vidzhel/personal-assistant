import { defineSuite, SUITE_GEMINI_TRANSCRIPTION } from '@raven/shared';

export default defineSuite({
  name: SUITE_GEMINI_TRANSCRIPTION,
  displayName: 'Gemini Voice Transcription',
  version: '0.2.0',
  description: 'Voice message and file transcription via Google Gemini',
  capabilities: ['agent-definition'],
  requiresEnv: ['GOOGLE_API_KEY'],
  services: ['voice-transcriber'],
});
