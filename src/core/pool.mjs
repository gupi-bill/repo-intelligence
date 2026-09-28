/**
 * Bounded worker pool over `node:worker_threads`.
 *
 * Two things matter here and both are about being a good citizen on a laptop:
 *
 *  1. Concurrency defaults to `min(cores - 1, 4)`. Parsing is CPU-bound, so
 *     oversubscribing the machine makes the whole run slower, not faster.
 *  2. Every batch is explicitly chunked with a byte budget, so a handful of huge
 *     files cannot blow up a worker's heap or stall the pool.
 *
 * When the pool is disabled (or when a worker cannot start -- sandboxes, low
 * memory, restricted environments) the same work runs inline, so results are
 * identical either way.
 */

import { Worker } from 'node:worker_threads';
import { cpus, freemem } from 'node:os';

const WORKER_URL = new URL('./worker.mjs', import.meta.url);

/** Default concurrency, conservative by design. */
export function defaultConcurrency() {
  const cores = typeof cpus === 'function' ? cpus().length : 4;
  const free = freemem();
  // Do not start a pool on a machine that is already starved.
  if (free < 512 * 1024 * 1024) return 0;
  return Math.max(0, Math.min(4, cores - 1));
}

/**
 * Split items into batches that respect a byte budget, largest-first so that a
 * single oversized file cannot sit at the end of the queue and become a tail
 * latency spike.
 */
export function planBatches(items, { targetBytes = 4 * 1024 * 1024, maxItems = 256 } = {}) {
  const sorted = [...items].sort((a, b) => (b.bytes ?? 0) - (a.bytes ?? 0));
  const batches = [];
  let current = [];
  let currentBytes = 0;
  for (const item of sorted) {
    const size = item.bytes ?? 32 * 1024;
    if (current.length >= maxItems || (current.length > 0 && currentBytes + size > targetBytes)) {
      batches.push(current);
      current = [];
      currentBytes = 0;
    }
    current.push(item);
    currentBytes += size;
  }
  if (current.length) batches.push(current);
  return batches;
}

/**
 * Run `workerTask` over `items` using a worker pool.
 *
 * @template T, R
 * @param {T[]} items
 * @param {{concurrency?: number, workerBytes?: number, maxBytes?: number, onProgress?: (done: number, total: number) => void}} opts
 * @param {(items: T[]) => Promise<R[]>} [inlineTask] used when concurrency is 0
 * @returns {Promise<R[]>}
 */
export async function mapWithPool(items, opts, inlineTask) {
  const concurrency = opts.concurrency ?? defaultConcurrency();
  const batches = planBatches(items, { targetBytes: opts.workerBytes });
  const results = [];
  if (items.length === 0) return results;

  if (concurrency <= 0 || batches.length <= 1) {
    // Sequential: still chunked so progress reporting and memory stay bounded.
    let done = 0;
    for (const batch of batches) {
      const out = await inlineTask(batch);
      results.push(...out);
      done += batch.length;
      opts.onProgress?.(done, items.length);
    }
    return results;
  }

  let next = 0;
  let done = 0;
  let failed = null;

  const workers = [];
  const runOne = async (worker) => {
    for (;;) {
      const index = next;
      next += 1;
      if (index >= batches.length) return;
      const batch = batches[index];
      const out = await worker.run(batch);
      results.push(...out);
      done += batch.length;
      opts.onProgress?.(done, items.length);
    }
  };

  const created = [];
  try {
    for (let i = 0; i < Math.min(concurrency, batches.length); i += 1) {
      const worker = await WorkerHandle.create();
      created.push(worker);
      workers.push(worker);
    }
  } catch (error) {
    // Could not spawn threads (resource limits, seccomp, ...). Degrade to inline.
    for (const worker of created) await worker.terminate();
    return mapWithPool(items, { ...opts, concurrency: 0 }, inlineTask);
  }

  try {
    await Promise.all(workers.map(runOne));
  } catch (error) {
    failed = error;
  } finally {
    await Promise.all(workers.map((worker) => worker.terminate()));
  }
  if (failed) throw failed;
  return results;
}

/** A single worker with a request/response protocol and a fresh module state. */
class WorkerHandle {
  constructor(worker) {
    this.worker = worker;
    this.pending = new Map();
    this.seq = 0;
    this.worker.on('message', (message) => {
      const entry = this.pending.get(message.id);
      if (!entry) return;
      this.pending.delete(message.id);
      if (message.error) entry.reject(new Error(message.error));
      else entry.resolve(message.result);
    });
    this.worker.on('error', (error) => {
      for (const entry of this.pending.values()) entry.reject(error);
      this.pending.clear();
    });
    this.worker.on('exit', () => {
      for (const entry of this.pending.values()) entry.reject(new Error('worker exited unexpectedly'));
      this.pending.clear();
    });
  }

  static async create() {
    const worker = new Worker(WORKER_URL, { stdout: true, stderr: true, env: process.env });
    // Workers must never inherit the parent's stdio for our purposes; silence
    // stray output but keep the streams drained so the process cannot block.
    worker.stdout.resume();
    worker.stderr.resume();
    // Wait for the online event so `postMessage` is never lost.
    if (worker.threadId === -1) {
      await new Promise((resolve, reject) => {
        worker.once('online', resolve);
        worker.once('error', reject);
      });
    }
    return new WorkerHandle(worker);
  }

  run(batch) {
    this.seq += 1;
    const id = this.seq;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.worker.postMessage({ id, batch });
    });
  }

  async terminate() {
    try {
      await this.worker.terminate();
    } catch {
      /* already gone */
    }
  }
}
