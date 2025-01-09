import { createParser } from 'eventsource-parser';
import { OpenAI } from 'openai';
import { type ChatCompletionChunk } from 'openai/resources/chat/completions';

export interface OpenAIStreamCallbacks {
  onStart?(): void;
  onCompletion?(completion: string): void | Promise<void>;
  onToken?(token: string): void | Promise<void>;
  onFinal?(completion: string): void | Promise<void>;
}

export function OpenAIStream(
  response: AsyncIterable<ChatCompletionChunk>,
  callbacks?: OpenAIStreamCallbacks,
) {
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();

  let counter = 0;
  let completion = '';

  return new ReadableStream({
    async start(controller) {
      callbacks?.onStart?.();

      try {
        for await (const chunk of response) {
          const content = chunk.choices[0]?.delta?.content;
          if (!content) continue;

          completion += content;
          counter++;

          if (callbacks?.onToken) {
            await callbacks.onToken(content);
          }

          controller.enqueue(encoder.encode(content));
        }

        if (callbacks?.onCompletion) {
          await callbacks.onCompletion(completion);
        }

        if (callbacks?.onFinal) {
          await callbacks.onFinal(completion);
        }
      } catch (error) {
        console.error('Error in OpenAIStream:', error);
        controller.error(error);
      } finally {
        controller.close();
      }
    },
  });
} 