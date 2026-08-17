/**
 * Runs recurring background jobs in a worker process.
 *
 * Each job gets its own self-rescheduling `setTimeout` chain rather than a
 * shared `setInterval`, so a slow run can never overlap its own next run, and a
 * job that throws cannot stop the others. Jobs are staggered at boot so they do
 * not all fire in the same tick.
 */
export interface JobDefinition {
  name: string;
  intervalMs: number;
  /** Delay before the first run. Stagger jobs so boot is not a thundering herd. */
  initialDelayMs?: number;
  run(): Promise<Record<string, number> | void>;
}

export type JobLogger = (
  level: 'info' | 'warn' | 'error',
  message: string,
  values: Record<string, unknown>,
) => void;

export interface JobHeartbeatSink {
  record(input: {
    job: string;
    workerId: string;
    startedAt: Date;
    finishedAt: Date;
    durationMs: number;
    ok: boolean;
    error?: string;
    consecutiveFailures: number;
    result?: Record<string, number>;
  }): Promise<void>;
}

export interface JobRunnerOptions {
  jobs: readonly JobDefinition[];
  log: JobLogger;
  workerId: string;
  heartbeat?: JobHeartbeatSink;
  now?: () => Date;
}

export interface JobRunner {
  start(): void;
  /** Stops scheduling and waits for any in-flight run to finish. */
  stop(): Promise<void>;
  /** Runs one job once, ignoring its schedule. Test seam. */
  runOnce(name: string): Promise<void>;
}

export function createJobRunner(options: JobRunnerOptions): JobRunner {
  const now = options.now ?? (() => new Date());
  const timers = new Map<string, NodeJS.Timeout>();
  const inFlight = new Set<Promise<void>>();
  const failures = new Map<string, number>();
  let stopping = false;

  async function execute(job: JobDefinition): Promise<void> {
    const startedAt = now();
    let ok = true;
    let result: Record<string, number> | undefined;
    let message: string | undefined;
    try {
      const value = await job.run();
      if (value) result = value;
    } catch (error) {
      ok = false;
      message = error instanceof Error ? error.message : String(error);
      options.log('error', 'Background job failed', {
        job: job.name,
        error: message,
      });
    }

    const consecutiveFailures = ok ? 0 : (failures.get(job.name) ?? 0) + 1;
    failures.set(job.name, consecutiveFailures);
    const finishedAt = now();

    if (ok && result && Object.values(result).some((value) => value > 0)) {
      options.log('info', 'Background job completed', {
        job: job.name,
        ...result,
      });
    }

    if (options.heartbeat) {
      try {
        await options.heartbeat.record({
          job: job.name,
          workerId: options.workerId,
          startedAt,
          finishedAt,
          durationMs: finishedAt.getTime() - startedAt.getTime(),
          ok,
          ...(message !== undefined ? { error: message } : {}),
          consecutiveFailures,
          ...(result !== undefined ? { result } : {}),
        });
      } catch (error) {
        // A heartbeat failure must never take the job down with it.
        options.log('warn', 'Background job heartbeat failed', {
          job: job.name,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  function schedule(job: JobDefinition, delayMs: number): void {
    if (stopping) return;
    const timer = setTimeout(() => {
      timers.delete(job.name);
      const run = execute(job).finally(() => {
        inFlight.delete(run);
        schedule(job, job.intervalMs);
      });
      inFlight.add(run);
    }, delayMs);
    timer.unref();
    timers.set(job.name, timer);
  }

  return {
    start() {
      for (const [index, job] of options.jobs.entries()) {
        // Default stagger: 250ms apart, so a cold start does not fire every
        // job into the same event-loop turn.
        schedule(job, job.initialDelayMs ?? index * 250);
      }
      options.log('info', 'Background jobs started', {
        workerId: options.workerId,
        jobs: options.jobs.map(({ name }) => name).join(','),
      });
    },

    async stop() {
      stopping = true;
      for (const timer of timers.values()) clearTimeout(timer);
      timers.clear();
      // Wait for in-flight runs so the process does not close its database
      // connection out from under a transaction.
      await Promise.allSettled([...inFlight]);
    },

    async runOnce(name) {
      const job = options.jobs.find((value) => value.name === name);
      if (!job) throw new Error(`Unknown job ${name}`);
      await execute(job);
    },
  };
}
