// Realtime provider — OpenAI's speech-native model over WebRTC.
//
// The server's only job is to mint a short-lived client secret with the
// session already configured (instructions, tools, voice, turn detection).
// The browser then negotiates audio directly with OpenAI; our API key never
// leaves this process and the token it does receive expires in minutes.
//
// VAD defaults are deliberately conservative. At a low threshold with a short
// silence window the model endpoints on a one-second thinking pause, and
// residual speaker echo that survives the browser's AEC retriggers it into
// answering itself. Longer silence feels marginally slower and is dramatically
// less broken.

import { getVoiceSystemPrompt } from '../agent/prompts';
import { loadAccountSnapshot, renderSnapshot } from '../agent/context';
import { historyWindow, loadRecentMessages, loadSummaryState } from '../agent/persistence';
import { createToolRuntime } from '../agent/types';
import { buildRealtimeToolManifest } from './tools';
import type { RealtimeVoiceSession, VoiceProvider, VoiceSessionRequest } from './types';

const OPENAI_BASE = () => process.env.OPENAI_BASE_URL?.trim() || 'https://api.openai.com/v1';

export function realtimeModel(): string {
  return process.env.OPENAI_REALTIME_MODEL?.trim() || 'gpt-realtime';
}

function num(name: string, fallback: number): number {
  const raw = Number(process.env[name]);
  return Number.isFinite(raw) && raw > 0 ? raw : fallback;
}

/**
 * The voice session's instructions: the spoken-surface prompt plus the same
 * account snapshot, rolling summary, and recent history the text head sees —
 * rendered as inline dialogue, because a Realtime session has no message array
 * to replay into.
 *
 * This is what makes the two surfaces continuous: end a chat, start a call,
 * and the agent already knows what you were talking about.
 */
export async function buildVoiceInstructions(request: VoiceSessionRequest): Promise<string> {
  const [systemPrompt, snapshot, summaryState] = await Promise.all([
    getVoiceSystemPrompt(),
    loadAccountSnapshot({
      userId: request.userId,
      currency: request.currency,
      timezone: request.timezone,
      clientNow: request.clientNow,
    }),
    loadSummaryState(request.threadId),
  ]);

  const blocks = [systemPrompt, renderSnapshot(snapshot, request.timezone)];

  if (summaryState?.summary) {
    blocks.push(`## EARLIER IN THIS CONVERSATION\n${summaryState.summary}`);
  }

  const recent = await loadRecentMessages(request.threadId, historyWindow());
  if (recent.length > 0) {
    const lines = recent
      .map((m) => `${m.role === 'user' ? 'User' : 'You'}: ${m.content}`)
      .join('\n');
    blocks.push(`## RECENT MESSAGES (most recent last)\n${lines}`);
  }

  return blocks.join('\n\n');
}

export function buildRealtimeSessionConfig(args: {
  instructions: string;
  tools: unknown[];
  voice?: string;
}): Record<string, unknown> {
  return {
    session: {
      type: 'realtime',
      model: realtimeModel(),
      instructions: args.instructions,
      tools: args.tools,
      tool_choice: 'auto',
      audio: {
        input: {
          // Attenuate residual echo and room noise BEFORE server VAD sees it.
          noise_reduction: { type: process.env.REALTIME_NOISE_REDUCTION?.trim() || 'near_field' },
          turn_detection: {
            type: 'server_vad',
            threshold: num('REALTIME_VAD_THRESHOLD', 0.7),
            prefix_padding_ms: num('REALTIME_VAD_PREFIX_PADDING_MS', 400),
            silence_duration_ms: num('REALTIME_VAD_SILENCE_MS', 1500),
            // Without these the server detects speech but keeps generating —
            // the user hears a brief mute and then the agent talks over them.
            create_response: true,
            interrupt_response: true,
          },
        },
        output: { voice: args.voice ?? process.env.REALTIME_VOICE?.trim() ?? 'marin' },
      },
    },
  };
}

export class RealtimeVoiceProvider implements VoiceProvider {
  readonly mode = 'realtime' as const;

  async createSession(request: VoiceSessionRequest): Promise<RealtimeVoiceSession> {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) throw new Error('OPENAI_API_KEY is not set');

    const instructions = await buildVoiceInstructions(request);

    // The manifest only needs tool shapes, so the runtime here is a throwaway —
    // real execution happens per call in /api/voice/tool-call with a runtime
    // built from that request's session.
    const manifestRuntime = createToolRuntime({
      userId: request.userId,
      threadId: request.threadId,
      currency: request.currency,
      timezone: request.timezone,
      clientNow: request.clientNow,
    });
    const tools = buildRealtimeToolManifest(manifestRuntime);

    const config = buildRealtimeSessionConfig({ instructions, tools });

    const response = await fetch(`${OPENAI_BASE()}/realtime/client_secrets`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(config),
    });

    if (!response.ok) {
      const body = await response.text().catch(() => '');
      throw new Error(`Realtime session mint failed (${response.status}): ${body.slice(0, 300)}`);
    }

    const json = (await response.json()) as {
      value?: string;
      expires_at?: number;
      session?: { id?: string };
    };
    if (!json.value) throw new Error('Realtime mint returned no client secret');

    return {
      mode: 'realtime',
      sessionId: json.session?.id ?? '',
      clientSecret: json.value,
      expiresAt: json.expires_at ?? 0,
      model: realtimeModel(),
      callsUrl: `${OPENAI_BASE()}/realtime/calls`,
      threadId: request.threadId,
    };
  }
}
