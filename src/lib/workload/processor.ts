import { type Job, DelayedError, UnrecoverableError } from 'bullmq';
import { randomUUID } from 'node:crypto';
import { AdmissionError, admissionLimits, reserve, withWork } from './admission';
import { jobWorkOwner } from './ownership';

/** Re-admit old jobs through authoritative ownership; no legacy quota bypass. */
export async function processAdmitted<T>(job: Job, run: () => Promise<T>): Promise<T> {
  if (Date.now() - job.timestamp > admissionLimits.queuedMs) throw new UnrecoverableError('Admission deadline exceeded');
  const maxAttempts = ['email-summary', 'email-send'].includes(job.queueName) ? 1 : 3;
  if (job.attemptsMade >= maxAttempts) throw new UnrecoverableError('Work retry budget exhausted');
  const owner = await jobWorkOwner(job.queueName, job.data);
  const id = `bull:${job.queueName}:${job.id || randomUUID()}`;
  let queued: Awaited<ReturnType<typeof reserve>> | undefined;
  let completed = false;
  try {
    queued = await reserve(owner, 'queued', id);
    const result = await withWork(owner, run, 0, true, job.queueName);
    completed = true;
    return result;
  } catch (error) {
    if (error instanceof AdmissionError) {
      // Capacity contention does not consume a business retry or occupy a worker
      // slot while waiting. Jitter prevents synchronized multi-process retries.
      await job.moveToDelayed(Date.now() + 5000 + Math.floor(Math.random() * 5000), job.token);
      throw new DelayedError();
    }
    if (job.attemptsMade + 1 >= maxAttempts) throw new UnrecoverableError(error instanceof Error ? error.message : 'Work failed');
    throw error;
  } finally {
    // Retry jobs retain admission. Terminal jobs release idempotently.
    const state = await job.getState().catch(() => 'unknown');
    if (completed || (state !== 'delayed' && job.attemptsMade + 1 >= Math.min(maxAttempts, job.opts.attempts || 1))) {
      await queued?.release().catch(() => {});
    }
  }
}
