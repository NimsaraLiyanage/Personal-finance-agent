'use client';

// Browser-side voice controllers — one per mode, behind a shared interface.
//
// Both implement `VoiceController`, so the UI has a single start/stop button
// and no knowledge of which transport is running. The differences are real and
// worth reading:
//
//   RealtimeController — WebRTC straight to the model. We upload an SDP offer
//     signed with the ephemeral secret, attach the mic track, and receive both
//     the agent's audio track and a data channel of events. Turn-taking is the
//     model's job. Tool calls arrive as events and are relayed to our server.
//
//   PipelineController — MediaRecorder + an RMS energy gate for endpointing.
//     On silence we cut the recording, transcribe it, hand the text to the
//     caller (which runs the ordinary chat turn), then play back synthesised
//     audio. Every tool call, card, and memory feature comes free because the
//     turn is the text turn.

import type { PendingClientAction } from '@/lib/agent/types';
import type { PipelineVoiceSession, RealtimeVoiceSession, VoiceSession } from '@/lib/voice/types';

export type VoiceState = 'idle' | 'connecting' | 'listening' | 'thinking' | 'speaking' | 'error';

export interface VoiceCallbacks {
  onState: (state: VoiceState) => void;
  onTranscript: (text: string, role: 'user' | 'assistant') => void;
  onAction: (action: PendingClientAction) => void;
  onError: (message: string) => void;
  /** Pipeline mode only: run a full text turn and return the reply. */
  runTextTurn?: (text: string) => Promise<string>;
}

export interface VoiceController {
  start(): Promise<void>;
  stop(): void;
}

// ── Realtime (WebRTC) ───────────────────────────────────────────────────────

export class RealtimeController implements VoiceController {
  private pc: RTCPeerConnection | null = null;
  private channel: RTCDataChannel | null = null;
  private stream: MediaStream | null = null;
  private audio: HTMLAudioElement | null = null;
  private stopped = false;

  constructor(
    private readonly session: RealtimeVoiceSession,
    private readonly cb: VoiceCallbacks,
    private readonly context: { timezone: string },
  ) {}

  async start(): Promise<void> {
    this.cb.onState('connecting');

    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        // Browser AEC is the first line of defence against the agent hearing
        // itself through the speakers and interrupting its own reply.
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
    });

    const pc = new RTCPeerConnection();
    this.pc = pc;

    // The agent's voice arrives as a remote track.
    this.audio = new Audio();
    this.audio.autoplay = true;
    pc.ontrack = (event) => {
      if (this.audio) this.audio.srcObject = event.streams[0];
    };

    for (const track of this.stream.getTracks()) pc.addTrack(track, this.stream);

    const channel = pc.createDataChannel('oai-events');
    this.channel = channel;
    channel.onmessage = (event) => void this.handleEvent(event.data);
    channel.onopen = () => this.cb.onState('listening');

    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);

    const response = await fetch(`${this.session.callsUrl}?model=${encodeURIComponent(this.session.model)}`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.session.clientSecret}`,
        'Content-Type': 'application/sdp',
      },
      body: offer.sdp ?? '',
    });

    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      throw new Error(`Realtime connect failed (${response.status}): ${detail.slice(0, 200)}`);
    }

    await pc.setRemoteDescription({ type: 'answer', sdp: await response.text() });
  }

  private async handleEvent(raw: string): Promise<void> {
    if (this.stopped) return;

    let event: Record<string, unknown>;
    try {
      event = JSON.parse(raw);
    } catch {
      return;
    }

    switch (event.type) {
      case 'input_audio_buffer.speech_started':
        this.cb.onState('listening');
        break;

      case 'response.created':
        this.cb.onState('thinking');
        break;

      case 'response.output_audio.delta':
        this.cb.onState('speaking');
        break;

      case 'response.done':
        this.cb.onState('listening');
        break;

      // Final transcript of what the agent said.
      case 'response.output_audio_transcript.done':
        if (typeof event.transcript === 'string') {
          this.cb.onTranscript(event.transcript, 'assistant');
        }
        break;

      // Final transcript of what the user said.
      case 'conversation.item.input_audio_transcription.completed':
        if (typeof event.transcript === 'string') {
          this.cb.onTranscript(event.transcript, 'user');
        }
        break;

      case 'response.function_call_arguments.done':
        await this.runTool(event);
        break;

      case 'error':
        this.cb.onError(
          (event.error as { message?: string } | undefined)?.message ?? 'Realtime error',
        );
        break;
    }
  }

  /**
   * Relay a tool call to our server, then hand the output back to the model.
   *
   * `response.create` after the output is required: submitting a function
   * result does not itself resume generation, and without it the agent goes
   * silent mid-turn — which reads as a hang rather than a bug.
   */
  private async runTool(event: Record<string, unknown>): Promise<void> {
    const toolName = String(event.name ?? '');
    let args: unknown = {};
    try {
      args = JSON.parse(String(event.arguments ?? '{}'));
    } catch {
      /* malformed arguments still get a reply, so the model can recover */
    }

    let output = 'That failed.';
    try {
      const response = await fetch('/api/voice/tool-call', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          toolName,
          args,
          threadId: this.session.threadId,
          timezone: this.context.timezone,
          clientNow: new Date().toISOString(),
        }),
      });
      const json = (await response.json()) as { output?: string; actions?: PendingClientAction[] };
      output = json.output ?? output;
      for (const action of json.actions ?? []) {
        this.cb.onAction(action);
        if (action.type === 'end_session') {
          // Let the farewell finish playing before tearing the session down.
          setTimeout(() => this.stop(), 2500);
        }
      }
    } catch (err) {
      output = `That failed: ${(err as Error).message}`;
    }

    this.send({
      type: 'conversation.item.create',
      item: {
        type: 'function_call_output',
        call_id: event.call_id,
        output,
      },
    });
    this.send({ type: 'response.create' });
  }

  private send(payload: unknown): void {
    if (this.channel?.readyState === 'open') {
      this.channel.send(JSON.stringify(payload));
    }
  }

  stop(): void {
    this.stopped = true;
    this.channel?.close();
    this.pc?.close();
    this.stream?.getTracks().forEach((t) => t.stop());
    if (this.audio) {
      this.audio.srcObject = null;
      this.audio = null;
    }
    this.channel = null;
    this.pc = null;
    this.stream = null;
    this.cb.onState('idle');
  }
}

// ── Pipeline (STT → text agent → TTS) ───────────────────────────────────────

export class PipelineController implements VoiceController {
  private stream: MediaStream | null = null;
  private recorder: MediaRecorder | null = null;
  private audioContext: AudioContext | null = null;
  private analyser: AnalyserNode | null = null;
  private chunks: Blob[] = [];
  private vadTimer: number | null = null;
  private stopped = false;
  private speaking = false;
  private player: HTMLAudioElement | null = null;

  constructor(
    private readonly session: PipelineVoiceSession,
    private readonly cb: VoiceCallbacks,
  ) {}

  async start(): Promise<void> {
    this.cb.onState('connecting');
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });

    this.audioContext = new AudioContext();
    const source = this.audioContext.createMediaStreamSource(this.stream);
    this.analyser = this.audioContext.createAnalyser();
    this.analyser.fftSize = 2048;
    source.connect(this.analyser);

    this.beginTurn();
  }

  /** Record until the energy gate has seen `silenceMs` of quiet. */
  private beginTurn(): void {
    if (this.stopped || !this.stream) return;

    this.chunks = [];
    const recorder = new MediaRecorder(this.stream, { mimeType: pickMimeType() });
    this.recorder = recorder;
    recorder.ondataavailable = (e) => {
      if (e.data.size > 0) this.chunks.push(e.data);
    };
    recorder.onstop = () => void this.finishTurn();
    recorder.start(250);

    this.cb.onState('listening');
    this.watchForSilence();
  }

  private watchForSilence(): void {
    const buffer = new Float32Array(this.analyser!.fftSize);
    let quietFor = 0;
    let sawSpeech = false;
    let last = performance.now();

    const tick = () => {
      if (this.stopped || !this.analyser || this.recorder?.state !== 'recording') return;

      const now = performance.now();
      const elapsed = now - last;
      last = now;

      this.analyser.getFloatTimeDomainData(buffer);
      let sum = 0;
      for (let i = 0; i < buffer.length; i++) sum += buffer[i] * buffer[i];
      const rms = Math.sqrt(sum / buffer.length);

      // While our own audio is playing, ignore the mic entirely. Browser AEC
      // is good but not perfect, and a half-cancelled echo above the gate
      // makes the agent transcribe and answer itself.
      if (this.speaking) {
        quietFor = 0;
      } else if (rms > this.session.vad.threshold) {
        sawSpeech = true;
        quietFor = 0;
      } else {
        quietFor += elapsed;
      }

      // Only end a turn that actually contained speech — otherwise an empty
      // room submits a silent clip every `silenceMs`.
      if (sawSpeech && quietFor >= this.session.vad.silenceMs) {
        this.recorder?.stop();
        return;
      }

      this.vadTimer = requestAnimationFrame(tick);
    };

    this.vadTimer = requestAnimationFrame(tick);
  }

  private async finishTurn(): Promise<void> {
    if (this.stopped) return;
    const blob = new Blob(this.chunks, { type: this.chunks[0]?.type || 'audio/webm' });
    this.chunks = [];

    if (blob.size < 2000) {
      this.beginTurn();
      return;
    }

    this.cb.onState('thinking');

    try {
      const form = new FormData();
      form.append('audio', blob, 'turn.webm');
      const sttResponse = await fetch(this.session.endpoints.transcribe, {
        method: 'POST',
        body: form,
      });
      const { text } = (await sttResponse.json()) as { text?: string };

      if (!text?.trim()) {
        this.beginTurn();
        return;
      }

      this.cb.onTranscript(text, 'user');

      const reply = this.cb.runTextTurn ? await this.cb.runTextTurn(text) : '';
      if (reply.trim()) await this.speak(reply);
    } catch (err) {
      this.cb.onError((err as Error).message);
    }

    this.beginTurn();
  }

  private async speak(text: string): Promise<void> {
    this.cb.onState('speaking');
    this.speaking = true;
    try {
      const response = await fetch(this.session.endpoints.speak, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text }),
      });
      if (!response.ok) return;

      const url = URL.createObjectURL(await response.blob());
      const player = new Audio(url);
      this.player = player;
      await new Promise<void>((resolve) => {
        player.onended = () => resolve();
        player.onerror = () => resolve();
        void player.play().catch(() => resolve());
      });
      URL.revokeObjectURL(url);
    } finally {
      this.speaking = false;
      this.player = null;
    }
  }

  stop(): void {
    this.stopped = true;
    if (this.vadTimer !== null) cancelAnimationFrame(this.vadTimer);
    if (this.recorder?.state === 'recording') this.recorder.stop();
    this.player?.pause();
    this.stream?.getTracks().forEach((t) => t.stop());
    void this.audioContext?.close();
    this.recorder = null;
    this.stream = null;
    this.audioContext = null;
    this.analyser = null;
    this.cb.onState('idle');
  }
}

function pickMimeType(): string {
  const candidates = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4'];
  for (const type of candidates) {
    if (typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported(type)) return type;
  }
  return '';
}

// ── Factory ─────────────────────────────────────────────────────────────────

export function createVoiceController(
  session: VoiceSession,
  cb: VoiceCallbacks,
  context: { timezone: string },
): VoiceController {
  return session.mode === 'realtime'
    ? new RealtimeController(session, cb, context)
    : new PipelineController(session, cb);
}
