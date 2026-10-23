import init, * as bindings from './wasm/core';
import wasmUrl from './wasm/core_bg.wasm?url';

const ready = init({ module_or_path: wasmUrl });
self.onmessage = async (event: MessageEvent) => {
  const { id, operation, args } = event.data;
  try {
    await ready;
    const fn = (bindings as unknown as Record<string, (...args: unknown[]) => unknown>)[operation];
    if (typeof fn !== 'function') throw new Error(`Core operation unavailable: ${operation}`);
    const value = fn(...args);
    const result = typeof value === 'string' ? JSON.parse(value) : value;
    self.postMessage({ id, result });
  } catch (error) {
    self.postMessage({ id, error: error instanceof Error ? error.message : String(error) });
  }
};
