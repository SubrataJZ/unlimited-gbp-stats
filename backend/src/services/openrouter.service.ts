/**
 * OpenRouter API service
 *
 * Thin wrapper around the OpenRouter chat-completions endpoint.
 * Uses axios (already a project dependency — ^1.6.2).
 * Throws typed AppError subclasses so the error middleware maps them to the
 * correct HTTP status codes.
 */

import axios, { AxiosError } from 'axios';
import { ServiceUnavailableError, InternalServerError } from '../utils/errors';
import logger from '../utils/logger';

export interface ChatCompletionResult {
  text: string;
  promptTokens: number;
  completionTokens: number;
  costUsd: number;
  model: string;
}

export interface ChatCompletionOpts {
  system: string;
  user: string;
  /** Override the default model for this request. */
  model?: string;
  /**
   * Sampling temperature. Defaults to 0.7, which suits prose generation.
   * Extraction callers that need reproducible, parseable output should pass 0.
   */
  temperature?: number;
}

const OPENROUTER_BASE_URL = 'https://openrouter.ai/api/v1';

/**
 * Send a chat-completion request to OpenRouter and return the generated text
 * together with token usage and the model that was actually used.
 *
 * @throws ServiceUnavailableError when the API key is not configured (HTTP 503)
 * @throws InternalServerError when the OpenRouter request fails (HTTP 500)
 */
export async function generateChatCompletion(
  opts: ChatCompletionOpts
): Promise<ChatCompletionResult> {
  const apiKey = process.env.OPENROUTER_API_KEY;

  if (!apiKey || apiKey.trim() === '') {
    throw new ServiceUnavailableError(
      'AI is not configured on the server. Please set OPENROUTER_API_KEY.'
    );
  }

  const model =
    opts.model ||
    process.env.OPENROUTER_MODEL ||
    'anthropic/claude-3.5-sonnet';

  // Build optional branding headers
  const extraHeaders: Record<string, string> = {};
  const appUrl = process.env.OPENROUTER_APP_URL;
  const appTitle = process.env.OPENROUTER_APP_TITLE;
  if (appUrl) extraHeaders['HTTP-Referer'] = appUrl;
  if (appTitle) extraHeaders['X-Title'] = appTitle;

  const requestBody = {
    model,
    messages: [
      { role: 'system', content: opts.system },
      { role: 'user', content: opts.user },
    ],
    temperature: opts.temperature ?? 0.7,
    usage: { include: true },
  };

  try {
    const response = await axios.post(
      `${OPENROUTER_BASE_URL}/chat/completions`,
      requestBody,
      {
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
          ...extraHeaders,
        },
        timeout: 60_000, // 60 seconds
      }
    );

    const data = response.data as {
      model?: string;
      choices: Array<{ message: { content: string } }>;
      usage?: {
        prompt_tokens?: number;
        completion_tokens?: number;
        cost?: number;
      };
    };

    const text = data.choices[0]?.message?.content ?? '';
    const promptTokens = data.usage?.prompt_tokens ?? 0;
    const completionTokens = data.usage?.completion_tokens ?? 0;
    const costUsd = data.usage?.cost ?? 0;
    const usedModel = data.model || model;

    logger.debug(
      `OpenRouter completion: model=${usedModel} promptTokens=${promptTokens} ` +
        `completionTokens=${completionTokens} costUsd=${costUsd}`
    );

    return { text, promptTokens, completionTokens, costUsd, model: usedModel };
  } catch (err) {
    const axiosErr = err as AxiosError;
    if (axiosErr.isAxiosError) {
      const status = axiosErr.response?.status;
      const detail = axiosErr.response?.data
        ? JSON.stringify(axiosErr.response.data).slice(0, 200)
        : axiosErr.message;

      logger.error(`OpenRouter request failed: status=${status ?? 'network'} detail=${detail}`);

      // Return a safe message — never include the API key
      throw new InternalServerError(
        `AI request failed (OpenRouter returned ${status ?? 'network error'}). ` +
          'Please try again later.'
      );
    }
    // Re-throw non-Axios errors as-is (they will be caught by the global handler)
    throw err;
  }
}
