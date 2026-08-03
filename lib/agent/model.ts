// Model factory — plain OpenAI, no cloud-vendor wrapper.
//
// The transport is the OpenAI **Responses API** (`useResponsesApi: true`).
// Reasoning-class models (gpt-5.x / o-series) reject the combination of
// function tools + `reasoning_effort` on Chat Completions; Responses supports
// both. It is also the surface where reasoning summaries and server-side tools
// live, so it is the forward-looking default.
//
// Everything is env-driven so switching model — or provider — is a config
// change. Any OpenAI-compatible endpoint (Groq, Together, OpenRouter, a local
// Ollama/vLLM server) works by setting OPENAI_BASE_URL.

import { ChatOpenAI } from '@langchain/openai';
import type { BaseChatModel } from '@langchain/core/language_models/chat_models';

export type AgentLlm = BaseChatModel;

/** Reasoning-class models take `reasoning.effort` and reject sampling params. */
export function isReasoningModel(model: string): boolean {
  return /^(gpt-5|o[1-9])/.test(model.toLowerCase());
}

export function resolveModel(): string {
  return process.env.OPENAI_MODEL?.trim() || 'gpt-5.6-luna';
}

export function buildChatModel(): AgentLlm {
  const model = resolveModel();
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error('OPENAI_API_KEY is not set — copy .env.example to .env');

  const maxTokens = Number(process.env.OPENAI_MAX_OUTPUT_TOKENS) || 2000;
  const reasoningEffort = (process.env.OPENAI_REASONING_EFFORT?.trim() || 'low') as
    | 'minimal'
    | 'low'
    | 'medium'
    | 'high';
  const baseURL = process.env.OPENAI_BASE_URL?.trim();
  const reasoning = isReasoningModel(model);

  return new ChatOpenAI({
    model,
    apiKey,
    maxTokens,
    // Reasoning models accept only temperature 1; sending anything else 400s.
    // Non-reasoning models get a low temperature for stable tool arguments.
    temperature: reasoning ? 1 : 0.2,
    useResponsesApi: true,
    // Responses defaults to store:true (OpenAI retains the turns server-side).
    // A finance ledger is personal data — opt out and keep the transcript in
    // our own Postgres only.
    zdrEnabled: true,
    ...(reasoning ? { reasoning: { effort: reasoningEffort } } : {}),
    ...(baseURL ? { configuration: { baseURL } } : {}),
  });
}
