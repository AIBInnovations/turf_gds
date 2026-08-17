import { ObjectId, type Db } from 'mongodb';

import type { JobHeartbeatSink } from './job-runner.js';

export interface BackgroundJobRunDocument {
  _id: ObjectId;
  job: string;
  worker_id: string;
  started_at: Date;
  finished_at: Date;
  duration_ms: number;
  ok: boolean;
  error: string | null;
  consecutive_failures: number;
  result: Record<string, number> | null;
  updated_at: Date;
}

const validator = {
  $jsonSchema: {
    bsonType: 'object',
    additionalProperties: false,
    required: [
      '_id',
      'job',
      'worker_id',
      'started_at',
      'finished_at',
      'duration_ms',
      'ok',
      'error',
      'consecutive_failures',
      'result',
      'updated_at',
    ],
    properties: {
      _id: { bsonType: 'objectId' },
      job: { bsonType: 'string' },
      worker_id: { bsonType: 'string' },
      started_at: { bsonType: 'date' },
      finished_at: { bsonType: 'date' },
      duration_ms: { bsonType: ['int', 'long', 'double'] },
      ok: { bsonType: 'bool' },
      error: { bsonType: ['string', 'null'] },
      consecutive_failures: { bsonType: ['int', 'long'] },
      result: { bsonType: ['object', 'null'] },
      updated_at: { bsonType: 'date' },
    },
  },
};

export async function initializeSchedulerPersistence(db: Db): Promise<void> {
  const exists = await db
    .listCollections({ name: 'background_job_runs' }, { nameOnly: true })
    .hasNext();
  if (!exists) {
    await db.createCollection('background_job_runs', {
      validator,
      validationLevel: 'strict',
      validationAction: 'error',
    });
  } else {
    await db.command({
      collMod: 'background_job_runs',
      validator,
      validationLevel: 'strict',
      validationAction: 'error',
    });
  }
  await db
    .collection('background_job_runs')
    .createIndex({ job: 1 }, { unique: true, name: 'uq_background_job_run' });
}

export function createJobHeartbeatSink(db: Db): JobHeartbeatSink {
  return {
    async record(input) {
      await db
        .collection<BackgroundJobRunDocument>('background_job_runs')
        .updateOne(
          { job: input.job },
          {
            $set: {
              job: input.job,
              worker_id: input.workerId,
              started_at: input.startedAt,
              finished_at: input.finishedAt,
              duration_ms: input.durationMs,
              ok: input.ok,
              error: input.error ?? null,
              consecutive_failures: input.consecutiveFailures,
              result: input.result ?? null,
              updated_at: input.finishedAt,
            },
            $setOnInsert: { _id: new ObjectId() },
          },
          { upsert: true },
        );
    },
  };
}

export type JobHealth = 'up' | 'stale' | 'down';

/**
 * Whether background jobs are running at all.
 *
 * Once the API stops running these jobs in-process, a dead worker is otherwise
 * completely silent: holds never expire, inventory leaks, and /ready stays
 * green. This is what turns that into a signal.
 */
export async function readJobHealth(
  db: Db,
  expectations: ReadonlyArray<{ job: string; intervalMs: number }>,
  now: Date,
): Promise<JobHealth> {
  if (expectations.length === 0) return 'up';
  const runs = await db
    .collection<BackgroundJobRunDocument>('background_job_runs')
    .find({ job: { $in: expectations.map(({ job }) => job) } })
    .toArray();
  const byJob = new Map(runs.map((value) => [value.job, value]));

  let health: JobHealth = 'up';
  for (const expectation of expectations) {
    const run = byJob.get(expectation.job);
    if (!run) return 'down';
    // Three missed intervals is late enough to be a real fault rather than a
    // slow run or a deploy.
    if (
      now.getTime() - run.finished_at.getTime() >
      expectation.intervalMs * 3
    ) {
      health = 'stale';
    }
  }
  return health;
}
