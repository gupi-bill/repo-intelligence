/**
 * Scan worker.
 *
 * Receives batches of file descriptors, reads and measures each one, and
 * returns compact shape objects. Deliberately does no rendering, no sorting and
 * no aggregation: those happen once, on the main thread, so the output is
 * trivially deterministic and testable.
 */

import { readFile, stat } from 'node:fs/promises';
import { parentPort } from 'node:worker_threads';
import { shapeOf, measureCode, extractImports, releaseCode, looksBinary, DEFAULT_MAX_BYTES } from './scan.mjs';
import { languageFor, isBinaryPath } from './lang.mjs';

/**
 * How many files a worker reads at the same time.
 *
 * Deliberately much larger than the worker count. Reading is I/O-bound and the
 * queue depth is what matters: on a spinning disk, twelve concurrent reads move
 * roughly four times as many bytes per second as one, because each read is
 * mostly seek latency rather than transfer time. With three workers doing one
 * file at a time the disk is idle 70% of the time waiting for the next head
 * position. Measurement parsing is CPU-bound and stays limited by the worker
 * count instead.
 */
const READ_CONCURRENCY = 12;

/**
 * @param {{abs: string, rel: string, lang: object|null, maxBytes: number}[]} batch
 * @returns {Promise<object[]>} results in the same order as `batch`
 */
export async function processBatch(batch) {
  const results = new Array(batch.length);
  let next = 0;
  const workers = Math.min(READ_CONCURRENCY, batch.length);
  await Promise.all(Array.from({ length: workers }, async () => {
    for (;;) {
      const index = next;
      next += 1;
      if (index >= batch.length) return;
      results[index] = await processOne(batch[index]);
    }
  }));
  return results;
}

async function processOne({ abs, rel, lang, maxBytes }) {
  const language = lang ?? languageFor(rel);
  const empty = {
    rel,
    language: language?.name ?? null,
    skip: null,
    total: 0, code: 0, comment: 0, blank: 0, comments: 0,
    decisions: 0, depth: 0, funcs: 0, suppressed: 0, complexity: 0,
    debt: [], imports: [], bytes: 0, error: null,
  };

  if (isBinaryPath(rel)) return { ...empty, skip: 'binary' };

  let info;
  try {
    info = await stat(abs);
  } catch (error) {
    return { ...empty, skip: 'missing' };
  }
  if (info.size === 0) return { ...empty, skip: 'empty' };
  if (info.size > Math.min(maxBytes, DEFAULT_MAX_BYTES)) return { ...empty, skip: 'too-large', bytes: info.size };
  // Symlinked or non-regular (fifo, socket, device): do not read.
  if (!info.isFile()) return { ...empty, skip: 'not-regular' };

  let buf;
  try {
    buf = await readFile(abs);
  } catch (error) {
    return { ...empty, skip: 'unreadable' };
  }
  if (looksBinary(buf)) return { ...empty, skip: 'binary', bytes: buf.length };

  let text;
  try {
    text = buf.toString('utf8');
  } catch {
    return { ...empty, skip: 'binary', bytes: buf.length };
  }
  // Reject content that decoded to replacement characters wholesale.
  if (text.length > 0 && text.indexOf('\uFFFD') !== -1 && text.indexOf('\uFFFD') < 3) {
    return { ...empty, skip: 'binary', bytes: buf.length };
  }

  if (!language) return { ...empty, skip: 'unknown-language', bytes: buf.length, total: countLines(text) };

  try {
    const shape = shapeOf(text, language);
    // Order matters: both readers consume the stripped text, and only then is it
    // worth freeing. See `releaseCode`.
    measureCode(shape, language);
    const imports = extractImports(shape, language);
    releaseCode(shape);
    shape.debt.sort((a, b) => b.weight - a.weight);
    return {
      rel,
      language: language.name,
      skip: null,
      total: shape.total,
      code: shape.code,
      comment: shape.comment,
      blank: shape.blank,
      comments: shape.comments,
      decisions: shape.decisions,
      depth: shape.maxDepth,
      funcs: shape.funcs,
      suppressed: shape.suppressed,
      complexity: shape.complexity,
      debt: shape.debt,
      imports,
      bytes: buf.length,
      error: null,
    };
  } catch (error) {
    return { ...empty, error: String(error?.message ?? error), bytes: buf.length };
  }
}

function countLines(text) {
  let n = 0;
  for (let i = 0; i < text.length; i += 1) if (text[i] === '\n') n += 1;
  return text.length && text[text.length - 1] !== '\n' ? n + 1 : n;
}

// Wire up the request/response protocol. Without this handler the worker has an
// empty event loop, Node reaps it immediately, and the pool reports every
// batch as a mysterious "worker exited unexpectedly".
if (parentPort) {
  parentPort.on('message', (message) => {
    const { id, batch } = message ?? {};
    if (id === undefined) return;
    processBatch(batch)
      .then((result) => parentPort.postMessage({ id, result }))
      .catch((error) => parentPort.postMessage({ id, error: String(error?.stack ?? error?.message ?? error) }));
  });
  // A listener on `message` is enough to keep the worker's event loop alive,
  // but be explicit so the intent survives future edits.
  parentPort.ref();
}

export { processBatch as default };
