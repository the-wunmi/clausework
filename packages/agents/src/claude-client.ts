import Anthropic from '@anthropic-ai/sdk';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import type { z } from 'zod';

const DEFAULT_MODEL = 'claude-opus-5-5';

type Effort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';

/** Thinking counts against the limit, and at `high` effort and above it can run long. */
const MAX_TOKENS: Record<Effort, number> = {
  low: 16_000,
  medium: 16_000,
  high: 32_000,
  xhigh: 64_000,
  max: 64_000,
};
/** The most the API accepts for one reply. */
const LARGEST_MAX_TOKENS = 128_000;

/** Until the first response headers. Covers compiling the schema and a declined first attempt. */
const HEADERS_TIMEOUT_MS = 5 * 60_000;

/** A streamed reply has no SDK timeout, so it gets the time the SDK allows a request of this size. */
const replyDeadlineMs = (maxTokens: number) =>
  Math.max(10 * 60_000, (3_600_000 * maxTokens) / LARGEST_MAX_TOKENS);

/** The API will refuse these again until someone changes the key, the model or the request. */
const REJECTED_STATUSES = [400, 401, 403, 404];

export type ModelContent =
  | { type: 'text'; text: string }
  | { type: 'document'; mediaType: 'application/pdf'; base64: string }
  | { type: 'image'; mediaType: 'image/png' | 'image/jpeg' | 'image/webp'; base64: string };

export interface ModelRequest {
  system: string;
  content: ModelContent[];
  /** The shape the reply must have. */
  schema: z.ZodType;
  /** Only worth setting if the system prompt reaches the model's minimum cacheable length. */
  cacheSystem?: boolean;
}

export interface ModelReply {
  output: unknown;
  metadata: Record<string, unknown>;
}

/** The one thing agents need from a model. Small, so tests can replace it. */
export interface ModelClient {
  readonly model: string;
  complete(request: ModelRequest): Promise<ModelReply>;
}

/**
 * A reply that cannot be used and that repeating the same request would not change. The decision
 * gateway records `reason` and passes the case to the next decider without retrying.
 */
export class ModelUnusableError extends Error {
  readonly retryable = false;

  constructor(
    readonly reason: 'refused' | 'cut_off' | 'malformed' | 'configuration',
    message: string,
  ) {
    super(message);
  }
}

export class ClaudeModelClient implements ModelClient {
  readonly model: string;
  readonly #client: Anthropic;
  readonly #effort: Effort;

  constructor(opts: { client?: Anthropic; model?: string; effort?: Effort } = {}) {
    this.#client = opts.client ?? new Anthropic({ timeout: HEADERS_TIMEOUT_MS });
    this.model = opts.model ?? DEFAULT_MODEL;
    this.#effort = opts.effort ?? 'high';
  }

  async complete(request: ModelRequest): Promise<ModelReply> {
    const limit = MAX_TOKENS[this.#effort];
    let message = await this.#ask(request, limit);
    if (message.stop_reason === 'max_tokens') {
      message = await this.#ask(request, Math.min(limit * 2, LARGEST_MAX_TOKENS));
    }
    return replyFrom(message, request.schema);
  }

  async #ask(request: ModelRequest, maxTokens: number): Promise<Anthropic.Beta.BetaMessage> {
    // Without `parse`, so a cut-off reply reaches the stop reason checks instead of throwing here.
    const { parse: _parse, ...format } = zodOutputFormat(request.schema);
    try {
      return await this.#client.beta.messages
        .stream(
          {
            model: this.model,
            max_tokens: maxTokens,
            betas: ['server-side-fallback-2026-07-01'],
            fallbacks: 'default',
            thinking: { type: 'adaptive' },
            output_config: { effort: this.#effort, format },
            system: [
              {
                type: 'text',
                text: request.system,
                ...(request.cacheSystem ? { cache_control: { type: 'ephemeral' as const } } : {}),
              },
            ],
            messages: [{ role: 'user', content: request.content.map(toBlock) }],
          },
          { signal: AbortSignal.timeout(replyDeadlineMs(maxTokens)) },
        )
        .finalMessage();
    } catch (err) {
      if (err instanceof Anthropic.APIError && REJECTED_STATUSES.includes(err.status as number)) {
        throw new ModelUnusableError('configuration', `model request rejected: ${err.message}`);
      }
      throw err;
    }
  }
}

function replyFrom(message: Anthropic.Beta.BetaMessage, schema: z.ZodType): ModelReply {
  if (message.stop_reason === 'refusal') {
    throw new ModelUnusableError('refused', 'model declined the case');
  }
  if (
    message.stop_reason === 'max_tokens' ||
    message.stop_reason === 'model_context_window_exceeded'
  ) {
    throw new ModelUnusableError('cut_off', 'reply was cut off');
  }
  return {
    output: parseOutput(answerText(message), schema),
    metadata: {
      model: message.model,
      fellBack: message.usage.iterations?.some((i) => i.type === 'fallback_message') ?? false,
      inputTokens: message.usage.input_tokens,
      outputTokens: message.usage.output_tokens,
      cacheReadTokens: message.usage.cache_read_input_tokens ?? 0,
    },
  };
}

/** Streaming keeps what a declining model wrote before the handoff. Only the last model counts. */
function answerText(message: Anthropic.Beta.BetaMessage): string | undefined {
  const start = message.content.map((b) => b.type).lastIndexOf('fallback') + 1;
  const block = message.content.slice(start).find((b) => b.type === 'text');
  return block?.type === 'text' ? block.text : undefined;
}

function parseOutput(text: string | undefined, schema: z.ZodType): unknown {
  try {
    return zodOutputFormat(schema).parse(text ?? '');
  } catch {
    throw new ModelUnusableError('malformed', 'reply did not match the schema');
  }
}

function toBlock(c: ModelContent): Anthropic.Beta.BetaContentBlockParam {
  switch (c.type) {
    case 'text':
      return { type: 'text', text: c.text };
    case 'document':
      return {
        type: 'document',
        source: { type: 'base64', media_type: c.mediaType, data: c.base64 },
      };
    case 'image':
      return { type: 'image', source: { type: 'base64', media_type: c.mediaType, data: c.base64 } };
  }
}
