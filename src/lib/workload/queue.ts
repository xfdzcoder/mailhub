import { Queue, type JobsOptions } from 'bullmq';
import { createHash } from 'node:crypto';
import { AdmissionError, admissionLimits, reserve } from './admission';
import { jobWorkOwner } from './ownership';

const digest = (value: string) => createHash('sha256').update(value).digest('hex');
export const reservationId = (queue: string, id: string) => `bull:${queue}:${id}`;

/** All producers, including periodic producers, share the same admission path. */
export class AdmittedQueue extends Queue {
  override async addBulk(jobs: { name: string; data: Record<string, unknown>; opts?: JobsOptions }[]) {
    if (jobs.length > 32) throw new AdmissionError();
    const added = [];
    for (const job of jobs) added.push(await this.add(job.name, job.data, job.opts));
    return added;
  }

  override async add(name: string, data: Record<string, unknown>, opts: JobsOptions = {}) {
    const owner = await jobWorkOwner(this.name, data);
    const jobId = opts.jobId || digest(`${name}:${JSON.stringify(data)}`);
    const bytes = Buffer.byteLength(JSON.stringify(data));
    // Queue payloads are references, not MIME content. Large payloads must be staged separately.
    if (bytes > admissionLimits.unitBytes) throw new AdmissionError();
    await reserve(owner, 'queued', reservationId(this.name, jobId), bytes);
    try {
      return await super.add(name, data, {
        ...opts, jobId,
        attempts: this.name === 'email-summary' || this.name === 'email-send' ? 1 : 3,
        backoff: { type: 'exponential', delay: 5000 },
        removeOnComplete: opts.removeOnComplete ?? (this.name === 'search-index' ? true : { age: 3600, count: 100 }),
        removeOnFail: { age: 86400, count: 500 },
      });
    } catch (error) {
      // An enqueue timeout is ambiguous: Redis may have accepted the job. Keep
      // its reservation until expiry; releasing here would undercount real work.
      throw error;
    }
  }
}

