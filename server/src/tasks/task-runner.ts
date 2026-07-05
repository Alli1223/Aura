import type { FastifyBaseLogger } from 'fastify';

// Generic periodic task runner for server maintenance work (library rescans,
// transcode/artwork cleanup, DB backup — see built-in-tasks.ts).
//
// The runner is deliberately dumb about WHAT a task does: a Task is just an id,
// a display name, an interval and an async `run` that returns a JSON-serialisable
// summary. This keeps the runner fully unit-testable with injected fake tasks
// and fake timers, and lets the built-in tasks be thin wrappers over the
// existing scan / eviction / backup functions.
//
// Guarantees:
//   - A task never overlaps itself: an interval tick (or manual runNow) while
//     the task is already running is skipped.
//   - A throwing task is captured into its status (lastError) and never crashes
//     the runner or stops sibling tasks.
//   - Timers are unref'd so they never keep the process (or a test runner)
//     alive, and the runner never auto-starts on import — start() is called
//     explicitly by index.ts only when TASKS_ENABLED.

/** Context handed to every task run. */
export interface TaskContext {
  /** Wall-clock timestamp (ms) at trigger time; Date.now() in the runtime. */
  now: number;
  log?: FastifyBaseLogger;
}

/** A unit of periodic maintenance work. */
export interface Task {
  /** Stable identifier used by the trigger API and status map. */
  id: string;
  /** Human-readable name for the admin UI. */
  name: string;
  /** Cadence between automatic runs, in ms. <= 0 means "never auto-run". */
  intervalMs: number;
  /** Whether the task is scheduled by start(). Disabled tasks can still runNow. */
  enabled: boolean;
  /** Performs the work; resolves with a summary, rejects/throws on failure. */
  run: (ctx: TaskContext) => Promise<unknown>;
}

export type TaskState = 'idle' | 'running';

/** Point-in-time, JSON-serialisable status of a single task. */
export interface TaskStatus {
  id: string;
  name: string;
  enabled: boolean;
  intervalMs: number;
  state: TaskState;
  /** When the current/last run started; null if never run. */
  lastRunAt: Date | null;
  /** Duration of the last completed run in ms; null if never completed. */
  lastDurationMs: number | null;
  /** Summary returned by the last successful run; null if none/failed. */
  lastResult: unknown;
  /** Message of the last failed run; null if the last run succeeded. */
  lastError: string | null;
  /** When the task is next scheduled to run; null when not scheduled. */
  nextRunAt: Date | null;
  /** Total completed runs (success or failure). */
  runCount: number;
}

/** Thrown by runNow when the id is not registered. */
export class UnknownTaskError extends Error {
  readonly taskId: string;
  constructor(taskId: string) {
    super(`Unknown task: ${taskId}`);
    this.name = 'UnknownTaskError';
    this.taskId = taskId;
  }
}

/** Thrown by runNow when the task is already running. */
export class TaskAlreadyRunningError extends Error {
  readonly taskId: string;
  constructor(taskId: string) {
    super(`Task is already running: ${taskId}`);
    this.name = 'TaskAlreadyRunningError';
    this.taskId = taskId;
  }
}

interface TaskEntry {
  task: Task;
  status: TaskStatus;
  /** Repeating interval timer once armed by start(). */
  intervalTimer?: ReturnType<typeof setInterval>;
  /** Initial stagger timer that arms intervalTimer, when a stagger offset > 0. */
  startTimer?: ReturnType<typeof setTimeout>;
}

export interface TaskRunnerOptions {
  log?: FastifyBaseLogger;
  /** Clock injection for deterministic tests. Defaults to Date.now. */
  now?: () => number;
  /**
   * Phase offset (ms) added per enabled task at start() so tasks sharing an
   * interval do not all fire at the same instant. Default 5s; 0 disables
   * staggering (all tasks share the same phase).
   */
  staggerMs?: number;
}

/** Default per-task stagger step applied on start(). */
export const DEFAULT_STAGGER_MS = 5_000;

export class TaskRunner {
  private readonly entries = new Map<string, TaskEntry>();
  private readonly log: FastifyBaseLogger | undefined;
  private readonly now: () => number;
  private readonly staggerMs: number;
  private started = false;

  constructor(options: TaskRunnerOptions = {}) {
    this.log = options.log;
    this.now = options.now ?? Date.now;
    this.staggerMs = options.staggerMs ?? DEFAULT_STAGGER_MS;
  }

  /** True while the interval timers are armed. */
  get running(): boolean {
    return this.started;
  }

  /** Registers a task. Throws on a duplicate id. */
  register(task: Task): void {
    if (this.entries.has(task.id)) {
      throw new Error(`Task already registered: ${task.id}`);
    }
    this.entries.set(task.id, {
      task,
      status: {
        id: task.id,
        name: task.name,
        enabled: task.enabled,
        intervalMs: task.intervalMs,
        state: 'idle',
        lastRunAt: null,
        lastDurationMs: null,
        lastResult: null,
        lastError: null,
        nextRunAt: null,
        runCount: 0,
      },
    });
  }

  /** True when a task with this id is registered. */
  has(taskId: string): boolean {
    return this.entries.has(taskId);
  }

  /** Snapshot of every task's status, in registration order. */
  getStatuses(): TaskStatus[] {
    return [...this.entries.values()].map((entry) => ({ ...entry.status }));
  }

  /** Snapshot of a single task's status, or undefined if not registered. */
  getStatus(taskId: string): TaskStatus | undefined {
    const entry = this.entries.get(taskId);
    return entry === undefined ? undefined : { ...entry.status };
  }

  /**
   * Arms the interval timer for every enabled task (interval > 0), staggering
   * their phase so equal-interval tasks do not all fire together. Idempotent:
   * a second start() while running is a no-op. Never fires a task immediately —
   * the first automatic run of each task lands one interval after start.
   */
  start(): void {
    if (this.started) return;
    this.started = true;

    let index = 0;
    for (const entry of this.entries.values()) {
      if (!entry.task.enabled || entry.task.intervalMs <= 0) continue;
      const offset = index * this.staggerMs;
      index += 1;
      if (offset <= 0) {
        this.arm(entry);
      } else {
        entry.status.nextRunAt = new Date(this.now() + offset + entry.task.intervalMs);
        const startTimer = setTimeout(() => this.arm(entry), offset);
        startTimer.unref?.();
        entry.startTimer = startTimer;
      }
    }
  }

  /** Arms one task's repeating interval timer. */
  private arm(entry: TaskEntry): void {
    entry.startTimer = undefined;
    const timer = setInterval(() => {
      void this.execute(entry, 'schedule');
    }, entry.task.intervalMs);
    timer.unref?.();
    entry.intervalTimer = timer;
    entry.status.nextRunAt = new Date(this.now() + entry.task.intervalMs);
  }

  /** Disarms every timer. Safe to call when not running. In-flight runs finish. */
  stop(): void {
    for (const entry of this.entries.values()) {
      if (entry.startTimer !== undefined) {
        clearTimeout(entry.startTimer);
        entry.startTimer = undefined;
      }
      if (entry.intervalTimer !== undefined) {
        clearInterval(entry.intervalTimer);
        entry.intervalTimer = undefined;
      }
      entry.status.nextRunAt = null;
    }
    this.started = false;
  }

  /**
   * Triggers a task immediately, out of band from its schedule. Returns a
   * promise that resolves once the run settles (it never rejects — task
   * failures are captured into status). Throws synchronously with
   * UnknownTaskError for an unregistered id, or TaskAlreadyRunningError when a
   * run of that task is already in flight.
   */
  runNow(taskId: string): Promise<void> {
    const entry = this.entries.get(taskId);
    if (entry === undefined) throw new UnknownTaskError(taskId);
    if (entry.status.state === 'running') throw new TaskAlreadyRunningError(taskId);
    return this.execute(entry, 'manual');
  }

  /**
   * Runs one task, capturing timing/result/error into its status. A run that
   * finds the task already running (a raced interval tick) no-ops. Never
   * rejects: a throwing task is recorded, not propagated.
   */
  private async execute(entry: TaskEntry, trigger: 'schedule' | 'manual'): Promise<void> {
    if (entry.status.state === 'running') return;
    entry.status.state = 'running';
    const startMs = this.now();
    entry.status.lastRunAt = new Date(startMs);

    try {
      const result = await entry.task.run({ now: startMs, log: this.log });
      entry.status.lastResult = result ?? null;
      entry.status.lastError = null;
    } catch (err) {
      entry.status.lastResult = null;
      entry.status.lastError = err instanceof Error ? err.message : String(err);
      this.log?.error({ err, taskId: entry.task.id, trigger }, 'scheduled task failed');
    } finally {
      entry.status.state = 'idle';
      entry.status.lastDurationMs = this.now() - startMs;
      entry.status.runCount += 1;
      // Reflect the next scheduled fire (best-effort; the interval keeps its
      // own cadence regardless of run duration).
      if (entry.intervalTimer !== undefined && entry.task.intervalMs > 0) {
        entry.status.nextRunAt = new Date(this.now() + entry.task.intervalMs);
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Active-runner registry: index.ts installs the process-wide runner here so the
// admin task routes (routes/tasks.ts) can read status and trigger runs without
// threading the instance through buildApp. Mirrors the scan-manager's
// module-local state pattern.
// ---------------------------------------------------------------------------

let activeRunner: TaskRunner | null = null;

/** Installs (or clears with null) the process-wide task runner. */
export function setActiveTaskRunner(runner: TaskRunner | null): void {
  activeRunner = runner;
}

/** The process-wide task runner, or null when none is installed. */
export function getActiveTaskRunner(): TaskRunner | null {
  return activeRunner;
}
