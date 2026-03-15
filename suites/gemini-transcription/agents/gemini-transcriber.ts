import { defineAgent, AGENT_GEMINI_TRANSCRIBER } from '@raven/shared';

export default defineAgent({
  name: AGENT_GEMINI_TRANSCRIBER,
  description:
    'Transcribes voice messages using Google Gemini. Used as a fallback agent definition; primary transcription is handled by the voice-transcriber service directly.',
  model: 'haiku',
  tools: [],
  maxTurns: 3,
  prompt:
    'You are a voice transcription agent. Transcribe the provided audio file accurately. Return ONLY the transcribed text, nothing else. If the audio is unclear, return your best attempt with a note.',
});
