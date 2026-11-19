import { Queue, QueueOptions } from 'bullmq';
import { AdmittedQueue } from '@/lib/workload/queue';
import Redis from 'ioredis';
import { getInitialSyncJobId, getSyncQueueName } from '@/lib/queue/identifiers';

export { getInitialSyncJobId, getSyncQueueName } from '@/lib/queue/identifiers';

const redisUrl = process.env.REDIS_URL || 'redis://localhost:6379';
const startedQueues = new Set<Queue>();

// BullMQ connects in its constructor even when ioredis uses lazyConnect.
// Keep producer imports inert during Next.js build-time module evaluation.
function lazyQueue<T extends Queue>(create: () => T): T {
  let instance: T | undefined;
  return new Proxy(Object.create(Queue.prototype) as T, {
    get(_target, property) {
      if (!instance) {
        instance = create();
        startedQueues.add(instance);
      }
      const value = Reflect.get(instance, property, instance);
      return typeof value === 'function' ? value.bind(instance) : value;
    },
  });
}

const defaultOptions: QueueOptions = {
  connection: new Redis(redisUrl, {
    maxRetriesPerRequest: 0,
    enableOfflineQueue: false,
    commandTimeout: 1500,
    connectTimeout: 1000,
    enableReadyCheck: false,
    lazyConnect: true,
    retryStrategy(times) {
      console.warn(`Redis connection lost. Retrying in queue client (attempt ${times})...`);
      return Math.min(times * 100, 3000);
    }
  }) as unknown as QueueOptions['connection'],
  defaultJobOptions: {
    attempts: 3,
    backoff: {
      type: 'exponential',
      delay: 2000, // 2s, 4s, 8s
    },
    removeOnComplete: 100, // Keep last 100 completed
    removeOnFail: 500,     // Keep last 500 failed
  },
};

// Queues
export const syncQueue = lazyQueue(() => new AdmittedQueue('imap-sync', defaultOptions));
export const searchQueue = lazyQueue(() => new AdmittedQueue('search-index', defaultOptions));
export const emailSendQueue = lazyQueue(() => new AdmittedQueue('email-send', defaultOptions));
export const workerHealthQueue = lazyQueue(() => new Queue('worker-health', defaultOptions));
export const summaryQueue = lazyQueue(() => new AdmittedQueue('email-summary', defaultOptions));

const partitionSyncQueues = new Map<string, Queue>();

export interface SyncAccountTarget {
  id: string;
  workerPartition: string | null;
}

export function getSyncQueue(workerPartition: string | null | undefined): Queue {
  const partition = workerPartition || 'default';
  const existingQueue = partitionSyncQueues.get(partition);
  if (existingQueue) return existingQueue;

  const queue = lazyQueue(() => new AdmittedQueue(getSyncQueueName(partition), defaultOptions));
  partitionSyncQueues.set(partition, queue);
  return queue;
}

export async function enqueueInitialSync(account: SyncAccountTarget): Promise<void> {
  await getSyncQueue(account.workerPartition).add(
    'initial-sync',
    {
      accountId: account.id,
      folder: 'ALL',
      workerPartition: account.workerPartition || 'default',
    },
    {
      jobId: getInitialSyncJobId(account.id),
      removeOnComplete: true,
      removeOnFail: true,
    }
  );
}

export async function closeQueues() {
  await Promise.all(Array.from(startedQueues, queue => queue.close()));
  // BullMQ treats this connection as shared, so closing queues does not own it.
  const connection = defaultOptions.connection as Redis;
  if (connection.status === 'wait' || connection.status === 'end') connection.disconnect();
  else await connection.quit();
}
