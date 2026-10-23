import type { CoreOperation } from './types';

const worker = new Worker(new URL('./core.worker.ts', import.meta.url), { type: 'module' });
let sequence = 0;
let terminalError: Error | undefined;
const pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
worker.onmessage = ({ data }) => {
  const request = pending.get(data.id);
  if (!request) return;
  pending.delete(data.id);
  if (data.error) request.reject(new Error(data.error));
  else request.resolve(data.result);
};
worker.onerror = event => {
  terminalError = new Error(event.message || 'The editor core could not load. Reload the page.');
  for (const request of pending.values()) request.reject(terminalError);
  pending.clear();
};
export function core<T>(operation: CoreOperation, ...args: unknown[]): Promise<T> {
  if (terminalError) return Promise.reject(terminalError);
  return new Promise((resolve, reject) => {
    const id = ++sequence;
    pending.set(id, { resolve: value => resolve(value as T), reject });
    worker.postMessage({ id, operation, args });
  });
}
export function download(name: string, bytes: Uint8Array | string, type = 'application/octet-stream') {
  const blob = new Blob([typeof bytes === 'string' ? bytes : new Uint8Array(bytes).buffer], { type });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url; anchor.download = name; anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
export function toBase64(data: Uint8Array) {
  let result = '';
  for (let i = 0; i < data.length; i += 8192) result += String.fromCharCode(...data.subarray(i, i + 8192));
  return btoa(result);
}
export function fromBase64(value: string) { return Uint8Array.from(atob(value), ch => ch.charCodeAt(0)); }
