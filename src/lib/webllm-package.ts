// Lazy boundary for the @mlc-ai/web-llm npm package.
//
// This module is imported dynamically by `webllm.ts` only after the user gives
// consent, so the package and its weights are never loaded on first paint.
// `WEBLLM_PACKAGE_TAG` lets the smoke test find and replace this exact chunk
// with a local stub; it is not user-facing.

export const WEBLLM_PACKAGE_TAG = 'ontographia-webllm-package-v1';

export interface IntentEngineConfig {
  initProgressCallback?: (report: { progress: number; text: string }) => void;
}

export interface IntentEngine {
  reload(modelId: string): Promise<void>;
  unload(): Promise<void>;
  chat: {
    completions: {
      create(request: {
        messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>;
        temperature?: number;
        max_tokens?: number;
        stream?: false;
        response_format?: { type: 'json_object'; schema: string };
      }): Promise<{ choices: Array<{ message: { content: string | null } }> }>;
    };
  };
}

export async function createIntentEngine(config: IntentEngineConfig): Promise<IntentEngine> {
  const { MLCEngine } = await import('@mlc-ai/web-llm');
  const engine = new MLCEngine(config as never);
  // Keeps the build tag in this lazy chunk (the smoke test locates the chunk by
  // it); it is not read by the app.
  (engine as unknown as { __ontographiaPackageTag?: string }).__ontographiaPackageTag =
    WEBLLM_PACKAGE_TAG;
  return engine as unknown as IntentEngine;
}
