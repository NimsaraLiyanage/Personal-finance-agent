// Provider selection.
//
// `VOICE_PROVIDER` picks the default; a request may override it, which is what
// makes the two modes comparable in a live demo rather than a config choice
// made once at deploy time.

import { PipelineVoiceProvider } from './pipeline';
import { RealtimeVoiceProvider } from './realtime';
import type { VoiceMode, VoiceProvider } from './types';

export function defaultVoiceMode(): VoiceMode {
  return process.env.VOICE_PROVIDER?.trim() === 'realtime' ? 'realtime' : 'pipeline';
}

export function getVoiceProvider(mode?: VoiceMode | string | null): VoiceProvider {
  const resolved = mode === 'realtime' || mode === 'pipeline' ? mode : defaultVoiceMode();
  return resolved === 'realtime' ? new RealtimeVoiceProvider() : new PipelineVoiceProvider();
}

export * from './types';
