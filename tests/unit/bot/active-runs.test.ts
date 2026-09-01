import { describe, expect, it } from 'vitest';
import type { AgentRun, AgentSteerRequest } from '../../../src/agent/types.js';
import { ActiveRuns } from '../../../src/bot/active-runs.js';

describe('ActiveRuns steering', () => {
  it('serializes guidance sent to the same active run', async () => {
    const active = new ActiveRuns();
    const first = deferred<void>();
    const second = deferred<void>();
    const started: string[] = [];
    const run = fakeRun(async (input) => {
      const text = typeof input === 'string' ? input : input.text;
      started.push(text);
      await (started.length === 1 ? first.promise : second.promise);
    });
    active.register('chat-1', run);

    const firstSteer = active.steer('chat-1', 'first');
    const secondSteer = active.steer('chat-1', 'second');
    await waitFor(() => started.length === 1);
    expect(started).toEqual(['first']);

    first.resolve();
    await firstSteer;
    await waitFor(() => started.length === 2);
    expect(started).toEqual(['first', 'second']);

    second.resolve();
    await expect(secondSteer).resolves.toBe('ok');
  });

  it('continues the steer chain after an earlier guidance call fails', async () => {
    const active = new ActiveRuns();
    const received: string[] = [];
    const run = fakeRun(async (input) => {
      const text = typeof input === 'string' ? input : input.text;
      received.push(text);
      if (text === 'first') throw new Error('turn race');
    });
    active.register('chat-1', run);

    await expect(active.steer('chat-1', 'first')).rejects.toThrow('turn race');
    await expect(active.steer('chat-1', 'second')).resolves.toBe('ok');
    expect(received).toEqual(['first', 'second']);
  });
});

function fakeRun(steer: (input: AgentSteerRequest) => Promise<void>): AgentRun {
  return {
    runId: 'run-1',
    events: {
      async *[Symbol.asyncIterator]() {},
    },
    steer,
    async stop() {},
    async waitForExit() {
      return true;
    },
  };
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 1000;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error('timed out waiting for async work');
}
