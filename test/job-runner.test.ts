import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';

import {
  createJobRunner,
  type JobDefinition,
  type JobHeartbeatSink,
} from '../src/shared/scheduler/job-runner.js';

function silentLog(): {
  log: (level: 'info' | 'warn' | 'error', message: string, values: Record<string, unknown>) => void;
  entries: Array<{ level: string; message: string; values: Record<string, unknown> }>;
} {
  const entries: Array<{
    level: string;
    message: string;
    values: Record<string, unknown>;
  }> = [];
  return {
    log: (level, message, values) => {
      entries.push({ level, message, values });
    },
    entries,
  };
}

test('a job that throws does not stop the other jobs', async () => {
  const logger = silentLog();
  let healthyRuns = 0;
  const jobs: JobDefinition[] = [
    {
      name: 'broken',
      intervalMs: 5,
      initialDelayMs: 0,
      async run() {
        throw new Error('boom');
      },
    },
    {
      name: 'healthy',
      intervalMs: 5,
      initialDelayMs: 0,
      async run() {
        healthyRuns += 1;
      },
    },
  ];
  const runner = createJobRunner({ jobs, log: logger.log, workerId: 'w1' });

  runner.start();
  await delay(60);
  await runner.stop();

  assert.ok(healthyRuns > 1, 'the healthy job must keep running');
  assert.ok(
    logger.entries.some(
      (entry) => entry.level === 'error' && entry.values.job === 'broken',
    ),
    'the failing job must be logged',
  );
});

test('a job never overlaps its own previous run', async () => {
  const logger = silentLog();
  let active = 0;
  let maxActive = 0;
  const runner = createJobRunner({
    jobs: [{
      name: 'slow',
      intervalMs: 1,
      initialDelayMs: 0,
      async run() {
        active += 1;
        maxActive = Math.max(maxActive, active);
        await delay(20);
        active -= 1;
      },
    }],
    log: logger.log,
    workerId: 'w1',
  });

  runner.start();
  await delay(80);
  await runner.stop();

  assert.equal(maxActive, 1);
});

test('stop waits for an in-flight run before returning', async () => {
  const logger = silentLog();
  let finished = false;
  const runner = createJobRunner({
    jobs: [{
      name: 'slow',
      intervalMs: 1_000,
      initialDelayMs: 0,
      async run() {
        await delay(30);
        finished = true;
      },
    }],
    log: logger.log,
    workerId: 'w1',
  });

  runner.start();
  await delay(5);
  await runner.stop();

  // Otherwise the process would close its database connection mid-transaction.
  assert.equal(finished, true);
});

test('heartbeats record success, failure, and consecutive failures', async () => {
  const logger = silentLog();
  const records: Array<{ job: string; ok: boolean; consecutiveFailures: number }> = [];
  const heartbeat: JobHeartbeatSink = {
    async record(input) {
      records.push({
        job: input.job,
        ok: input.ok,
        consecutiveFailures: input.consecutiveFailures,
      });
    },
  };
  let attempt = 0;
  const runner = createJobRunner({
    jobs: [{
      name: 'flaky',
      intervalMs: 5,
      initialDelayMs: 0,
      async run() {
        attempt += 1;
        if (attempt > 1) throw new Error('later failure');
      },
    }],
    log: logger.log,
    workerId: 'w1',
    heartbeat,
  });

  runner.start();
  await delay(60);
  await runner.stop();

  assert.equal(records[0]?.ok, true);
  assert.equal(records[0]?.consecutiveFailures, 0);
  const failures = records.filter((value) => !value.ok);
  assert.ok(failures.length >= 2);
  assert.equal(failures[0]?.consecutiveFailures, 1);
  assert.equal(failures[1]?.consecutiveFailures, 2);
});

test('a failing heartbeat does not take the job down', async () => {
  const logger = silentLog();
  let runs = 0;
  const runner = createJobRunner({
    jobs: [{
      name: 'job',
      intervalMs: 5,
      initialDelayMs: 0,
      async run() {
        runs += 1;
      },
    }],
    log: logger.log,
    workerId: 'w1',
    heartbeat: {
      async record() {
        throw new Error('heartbeat store unavailable');
      },
    },
  });

  runner.start();
  await delay(50);
  await runner.stop();

  assert.ok(runs > 1);
  assert.ok(
    logger.entries.some((entry) => entry.level === 'warn'),
    'heartbeat failure must warn rather than throw',
  );
});

test('runOnce executes a single named job', async () => {
  const logger = silentLog();
  let runs = 0;
  const runner = createJobRunner({
    jobs: [{
      name: 'target',
      intervalMs: 100_000,
      async run() {
        runs += 1;
      },
    }],
    log: logger.log,
    workerId: 'w1',
  });

  await runner.runOnce('target');
  assert.equal(runs, 1);
  await assert.rejects(runner.runOnce('missing'));
});
