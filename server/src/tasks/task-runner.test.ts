import { afterEach, describe, expect, it, vi } from 'vitest';

import { TaskAlreadyRunningError, TaskRunner, UnknownTaskError, type Task } from './task-runner.js';

// The runner is exercised with injected fake task `run` functions and fake
// timers, so no real scan/eviction/backup work happens here.

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (err: unknown) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (err: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function task(overrides: Partial<Task> & Pick<Task, 'id' | 'run'>): Task {
  return {
    name: overrides.id,
    intervalMs: 1000,
    enabled: true,
    ...overrides,
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('TaskRunner scheduling', () => {
  it('schedules only enabled tasks and fires them on their interval', async () => {
    vi.useFakeTimers();
    const enabled = vi.fn(() => Promise.resolve('ok'));
    const disabled = vi.fn(() => Promise.resolve('ok'));
    const runner = new TaskRunner({ staggerMs: 0 });
    runner.register(task({ id: 'enabled', run: enabled, intervalMs: 1000 }));
    runner.register(task({ id: 'disabled', run: disabled, enabled: false, intervalMs: 1000 }));

    runner.start();
    expect(runner.running).toBe(true);
    expect(enabled).toHaveBeenCalledTimes(0);

    await vi.advanceTimersByTimeAsync(1000);
    expect(enabled).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(2000);
    expect(enabled).toHaveBeenCalledTimes(3);
    expect(disabled).not.toHaveBeenCalled();

    runner.stop();
  });

  it('stop() halts further scheduled fires', async () => {
    vi.useFakeTimers();
    const run = vi.fn(() => Promise.resolve('ok'));
    const runner = new TaskRunner({ staggerMs: 0 });
    runner.register(task({ id: 'a', run, intervalMs: 1000 }));

    runner.start();
    await vi.advanceTimersByTimeAsync(1000);
    expect(run).toHaveBeenCalledTimes(1);

    runner.stop();
    expect(runner.running).toBe(false);
    await vi.advanceTimersByTimeAsync(5000);
    expect(run).toHaveBeenCalledTimes(1);
    expect(runner.getStatus('a')?.nextRunAt).toBeNull();
  });

  it('never overlaps a task with itself', async () => {
    vi.useFakeTimers();
    const gate = deferred<string>();
    const run = vi.fn(() => gate.promise);
    const runner = new TaskRunner({ staggerMs: 0 });
    runner.register(task({ id: 'slow', run, intervalMs: 1000 }));

    runner.start();
    // First fire starts the run and it stays in flight past the next tick.
    await vi.advanceTimersByTimeAsync(1000);
    expect(run).toHaveBeenCalledTimes(1);
    expect(runner.getStatus('slow')?.state).toBe('running');

    await vi.advanceTimersByTimeAsync(1000); // tick while still running -> skipped
    expect(run).toHaveBeenCalledTimes(1);

    gate.resolve('done');
    await vi.advanceTimersByTimeAsync(1); // let the in-flight run settle
    expect(runner.getStatus('slow')?.state).toBe('idle');
    expect(runner.getStatus('slow')?.lastResult).toBe('done');

    runner.stop();
  });

  it('staggers equal-interval tasks so they do not all fire at once', async () => {
    vi.useFakeTimers();
    const first = vi.fn(() => Promise.resolve('ok'));
    const second = vi.fn(() => Promise.resolve('ok'));
    const runner = new TaskRunner({ staggerMs: 200 });
    runner.register(task({ id: 'first', run: first, intervalMs: 1000 }));
    runner.register(task({ id: 'second', run: second, intervalMs: 1000 }));

    runner.start();
    // first is armed at offset 0 -> fires at t=1000; second at offset 200 -> t=1200.
    await vi.advanceTimersByTimeAsync(1000);
    expect(first).toHaveBeenCalledTimes(1);
    expect(second).toHaveBeenCalledTimes(0);

    await vi.advanceTimersByTimeAsync(200);
    expect(second).toHaveBeenCalledTimes(1);

    runner.stop();
  });
});

describe('TaskRunner status', () => {
  it('records lastResult/lastRunAt/duration on success', async () => {
    const run = vi.fn(() => Promise.resolve({ freed: 3 }));
    const runner = new TaskRunner();
    runner.register(task({ id: 'ok', run }));

    await runner.runNow('ok');

    const status = runner.getStatus('ok');
    expect(status?.state).toBe('idle');
    expect(status?.lastResult).toEqual({ freed: 3 });
    expect(status?.lastError).toBeNull();
    expect(status?.lastRunAt).toBeInstanceOf(Date);
    expect(typeof status?.lastDurationMs).toBe('number');
    expect(status?.runCount).toBe(1);
  });

  it('captures a throwing task into lastError without stopping siblings', async () => {
    vi.useFakeTimers();
    const bad = vi.fn(() => Promise.reject(new Error('boom')));
    const good = vi.fn(() => Promise.resolve('good'));
    const runner = new TaskRunner({ staggerMs: 0 });
    runner.register(task({ id: 'bad', run: bad, intervalMs: 1000 }));
    runner.register(task({ id: 'good', run: good, intervalMs: 1000 }));

    runner.start();
    await vi.advanceTimersByTimeAsync(1000);
    await vi.advanceTimersByTimeAsync(1); // flush settled promises

    expect(bad).toHaveBeenCalledTimes(1);
    expect(good).toHaveBeenCalledTimes(1);
    expect(runner.getStatus('bad')?.lastError).toBe('boom');
    expect(runner.getStatus('bad')?.lastResult).toBeNull();
    expect(runner.getStatus('good')?.lastResult).toBe('good');
    expect(runner.getStatus('good')?.lastError).toBeNull();
    expect(runner.running).toBe(true); // runner survived the throwing task

    runner.stop();
  });
});

describe('TaskRunner.runNow', () => {
  it('runs a disabled (unscheduled) task on demand', async () => {
    const run = vi.fn(() => Promise.resolve('ran'));
    const runner = new TaskRunner();
    runner.register(task({ id: 'manual', run, enabled: false, intervalMs: 0 }));

    await runner.runNow('manual');
    expect(run).toHaveBeenCalledTimes(1);
    expect(runner.getStatus('manual')?.lastResult).toBe('ran');
  });

  it('throws UnknownTaskError for an unregistered id', () => {
    const runner = new TaskRunner();
    expect(() => runner.runNow('nope')).toThrow(UnknownTaskError);
  });

  it('throws TaskAlreadyRunningError while a run is in flight', async () => {
    const gate = deferred<string>();
    const run = vi.fn(() => gate.promise);
    const runner = new TaskRunner();
    runner.register(task({ id: 'busy', run, enabled: false, intervalMs: 0 }));

    const inFlight = runner.runNow('busy');
    expect(runner.getStatus('busy')?.state).toBe('running');
    expect(() => runner.runNow('busy')).toThrow(TaskAlreadyRunningError);
    expect(run).toHaveBeenCalledTimes(1);

    gate.resolve('finished');
    await inFlight;
    expect(runner.getStatus('busy')?.state).toBe('idle');
    // Runnable again once settled.
    await runner.runNow('busy');
    expect(run).toHaveBeenCalledTimes(2);
  });
});

describe('TaskRunner.register', () => {
  it('rejects duplicate ids', () => {
    const runner = new TaskRunner();
    runner.register(task({ id: 'dup', run: () => Promise.resolve() }));
    expect(() => runner.register(task({ id: 'dup', run: () => Promise.resolve() }))).toThrow();
  });
});
