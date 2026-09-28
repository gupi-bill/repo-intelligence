/**
 * Progress reporting.
 *
 * Analysing a large repository takes tens of seconds, and a tool that prints
 * nothing for that long reads as a hung process. So while a phase is running
 * this writes a single, self-erasing line to stderr.
 *
 * Three rules keep it from becoming a nuisance:
 *
 *  - It goes to stderr, never stdout, so `oc --json | jq` stays clean.
 *  - It stays silent for the first few hundred milliseconds, so the common case
 *    of a small repository never flashes a bar that vanishes immediately.
 *  - It disappears entirely when stderr is not a TTY, so CI logs and redirected
 *    output contain exactly the report and nothing else.
 */

const FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
const FRAMES_ASCII = ['-', '\\', '|', '/'];

const SPINNER_DELAY_MS = 250;
const MIN_INTERVAL_MS = 80;

export class Progress {
  /**
   * @param {object} opts
   * @param {NodeJS.WriteStream} opts.stream
   * @param {boolean} opts.enabled
   * @param {boolean} [opts.unicode]
   * @param {number} [opts.width]
   * @param {boolean} [opts.verbose] show per-phase lines even when quiet
   */
  constructor({ stream, enabled, unicode = true, width = 80, verbose = false }) {
    this.stream = stream;
    this.enabled = Boolean(enabled);
    this.unicode = unicode;
    this.width = width;
    this.verbose = verbose;
    this.frames = unicode ? FRAMES : FRAMES_ASCII;
    this.timer = null;
    this.lastDraw = 0;
    this.frame = 0;
    this.lineOpen = false;
    this.startedAt = Date.now();
    this.phase = null;
  }

  /** Start (or switch to) a phase. */
  begin(phase, label, total = 0) {
    if (!this.enabled) return;
    this.phase = { name: phase, label, total, done: 0, startedAt: Date.now() };
    this.#startTimer();
  }

  /**
   * Report progress within the current phase.
   * Pass `done` as null to update only the note -- used when a second signal
   * (bytes streamed from git, say) arrives without a meaningful item count.
   */
  update(done, note) {
    if (!this.enabled || !this.phase) return;
    if (done !== null && done !== undefined) this.phase.done = done;
    if (note !== undefined) this.phase.note = note;
    this.#maybeDraw();
  }

  /** Finish the current phase, clearing the line. */
  end(note) {
    if (!this.enabled) return;
    this.#stopTimer();
    this.#clear();
    if (this.verbose && this.phase) {
      const ms = Date.now() - this.phase.startedAt;
      const detail = note ?? this.phase.note;
      this.stream.write(`  ${this.phase.label} ${formatDuration(ms)}${detail ? ` ${detail}` : ''}\n`);
    }
    this.phase = null;
  }

  /** Print a permanent line above the spinner (errors, hints). */
  say(text) {
    this.#clear();
    this.stream.write(`${text}\n`);
  }

  stop() {
    this.#stopTimer();
    this.#clear();
  }

  #startTimer() {
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.lastDraw = 0;
      this.#draw();
      this.timer = setInterval(() => this.#draw(), 100);
      if (this.timer.unref) this.timer.unref();
    }, SPINNER_DELAY_MS);
    if (this.timer.unref) this.timer.unref();
  }

  #stopTimer() {
    if (!this.timer) return;
    clearTimeout(this.timer);
    clearInterval(this.timer);
    this.timer = null;
  }

  #maybeDraw() {
    const now = Date.now();
    if (now - this.lastDraw < MIN_INTERVAL_MS) return;
    this.#draw();
  }

  #draw() {
    if (!this.phase) return;
    this.lastDraw = Date.now();
    const phase = this.phase;
    const elapsed = (Date.now() - this.startedAt) / 1000;
    const spinner = this.frames[this.frame % this.frames.length];
    this.frame += 1;

    let progress = '';
    if (phase.total > 0) {
      const ratio = Math.max(0, Math.min(1, phase.done / phase.total));
      const cells = Math.max(8, Math.min(28, this.width - 46));
      const filled = Math.round(ratio * cells);
      const bar = '█'.repeat(filled) + '░'.repeat(cells - filled);
      progress = ` ${bar} ${String(Math.round(ratio * 100)).padStart(3)}%`;
    } else if (phase.done > 0) {
      // No known total: show a running count, or nothing at all before the
      // first item lands. A permanent `0` reads as "stalled", not "starting".
      progress = ` ${formatCount(phase.done)}`;
    }

    // Bound the note rather than the assembled string: slicing a string that
    // contains escape sequences can cut one in half and leave garbage on screen.
    const noteBudget = Math.max(8, this.width - 46);
    const parts = [
      this.unicode ? `\x1b[90m${spinner}\x1b[0m` : spinner,
      phase.label,
      progress,
      phase.note ? `\x1b[90m${truncateNote(phase.note, noteBudget)}\x1b[0m` : '',
      `\x1b[90m${elapsed.toFixed(1)}s\x1b[0m`,
    ].filter(Boolean);

    this.stream.write(`\r\x1b[2K${parts.join(' ')}`);
    this.lineOpen = true;
  }

  #clear() {
    if (!this.lineOpen) return;
    this.stream.write('\r\x1b[2K');
    this.lineOpen = false;
  }
}

/** Trim a note to a column budget without cutting a wide character in half. */
function truncateNote(text, max) {
  if (text.length <= max) return text;
  return `${text.slice(0, Math.max(1, max - 1))}\u2026`;
}

function formatDuration(ms) {
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

function formatCount(value) {
  if (value < 1000) return String(value);
  if (value < 1_000_000) return `${(value / 1000).toFixed(1)}k`;
  return `${(value / 1_000_000).toFixed(1)}M`;
}

export { formatDuration, formatCount };
