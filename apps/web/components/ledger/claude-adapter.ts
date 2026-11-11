'use client';

import type {
  AgAiEvent,
  AgLlmAdapter,
  AgLlmRequest,
  AgLlmResponse,
  AgLlmResponseHandler,
} from 'ag-studio';

/**
 * AG Studio's LLM adapter for Claude. Studio calls `executeTurn` for every turn of every agent; the
 * turn goes to our own route (`/api/ai`), which holds the key, talks to the Anthropic Messages API
 * and streams AG-UI events back. Tools still run here in the browser, against live Studio state.
 */
export function claudeAdapter(endpoint = '/api/ai'): AgLlmAdapter {
  return {
    executeTurn(request: AgLlmRequest, options?: { signal?: AbortSignal }): AgLlmResponseHandler {
      let resolve!: (r: AgLlmResponse) => void;
      let reject!: (e: Error) => void;
      const complete = new Promise<AgLlmResponse>((res, rej) => {
        resolve = res;
        reject = rej;
      });
      // Observed here so an abandoned stream never surfaces as an unhandled rejection.
      complete.catch(() => {});

      async function* events(): AsyncIterableIterator<AgAiEvent> {
        let response: AgLlmResponse | null = null;
        let failure: Error | null = null;
        try {
          const res = await fetch(endpoint, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              input: request.input,
              instructions: request.instructions,
              tools: request.tools,
              toolChoice: request.toolChoice,
              responseFormat: request.responseFormat,
            }),
            signal: options?.signal,
          });
          if (!res.ok || !res.body) {
            const body = (await res.json().catch(() => ({}))) as { message?: string };
            throw new Error(body.message ?? `The assistant is unavailable (${res.status}).`);
          }
          const reader = res.body.getReader();
          const decoder = new TextDecoder();
          let buffer = '';
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });
            const frames = buffer.split('\n\n');
            buffer = frames.pop() ?? '';
            for (const frame of frames) {
              if (!frame.startsWith('data: ')) continue;
              const msg = JSON.parse(frame.slice(6)) as {
                event?: AgAiEvent;
                response?: AgLlmResponse;
                error?: string;
              };
              if (msg.event) yield msg.event;
              if (msg.response) response = msg.response;
              if (msg.error) failure = new Error(msg.error);
            }
          }
        } catch (err) {
          failure = err instanceof Error ? err : new Error(String(err));
        }
        if (failure) reject(failure);
        else if (response) resolve(response);
        else reject(new Error('The assistant stopped before finishing its reply.'));
      }

      const iterator = events();
      return { stream: { [Symbol.asyncIterator]: () => iterator }, complete };
    },
  };
}
