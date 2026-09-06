import {
  encodingForModel,
  getEncoding,
  type Tiktoken,
  type TiktokenEncoding,
  type TiktokenModel,
} from 'js-tiktoken';
import type { ChatMessage } from './index.js';

export type ModelTokenizerEncoding = TiktokenEncoding;

const encoderCache = new Map<string, Tiktoken>();

export function countModelTextTokens(
  model: string,
  text: string,
  fallbackEncoding: ModelTokenizerEncoding = 'o200k_base',
): number {
  if (!text) return 0;
  return encoderFor(model, fallbackEncoding).encode(text).length;
}

export function countModelTextsTokens(
  model: string,
  texts: readonly string[],
  fallbackEncoding: ModelTokenizerEncoding = 'o200k_base',
): number {
  const encoder = encoderFor(model, fallbackEncoding);
  return texts.reduce((sum, text) => sum + encoder.encode(text).length, 0);
}

export function countModelChatTokens(
  model: string,
  messages: readonly ChatMessage[],
  fallbackEncoding: ModelTokenizerEncoding = 'o200k_base',
): number {
  const encoder = encoderFor(model, fallbackEncoding);
  return messages.reduce((sum, message) => sum + encoder.encode(message.content).length + 4, 2);
}

export function truncateModelTextToTokens(
  model: string,
  text: string,
  maxTokens: number,
  fallbackEncoding: ModelTokenizerEncoding = 'o200k_base',
): string {
  const boundedMaxTokens = Math.max(0, Math.floor(maxTokens));
  if (!text || boundedMaxTokens === 0) return '';
  const encoder = encoderFor(model, fallbackEncoding);
  const tokens = encoder.encode(text);
  if (tokens.length <= boundedMaxTokens) return text;
  return encoder.decode(tokens.slice(0, boundedMaxTokens)).trimEnd();
}

function encoderFor(model: string, fallbackEncoding: ModelTokenizerEncoding): Tiktoken {
  const modelKey = `model:${model}`;
  const cachedModel = encoderCache.get(modelKey);
  if (cachedModel) return cachedModel;
  try {
    const encoder = encodingForModel(model as TiktokenModel);
    encoderCache.set(modelKey, encoder);
    return encoder;
  } catch {
    const fallbackKey = `encoding:${fallbackEncoding}`;
    const cachedFallback = encoderCache.get(fallbackKey);
    const encoder = cachedFallback ?? getEncoding(fallbackEncoding);
    encoderCache.set(fallbackKey, encoder);
    encoderCache.set(modelKey, encoder);
    return encoder;
  }
}
