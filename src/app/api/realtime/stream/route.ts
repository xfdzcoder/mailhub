import { NextRequest, NextResponse } from 'next/server';
import { authenticate } from '@/lib/auth/middleware';
import Redis from 'ioredis';
import {
  formatAccessibleSseMessage,
  loadAccessibleRealtimeAccountIds,
} from '@/lib/realtime/access';

// We must create a new Redis connection specifically for subscribing,
// since a Redis connection in subscriber mode cannot run regular commands.
const REDIS_URL = process.env.REDIS_URL || 'redis://localhost:6379';

// Overflow closes the stream so EventSource can reconnect and refetch state.
const MAX_PENDING_EVENTS = 100;
const MAX_MESSAGE_LENGTH = 16 * 1024;
const connections = new Map<string, number>();

export async function GET(req: NextRequest) {
  try {
    // Authenticate the user to ensure they belong to an organization
    const auth = await authenticate(req);
    if (auth instanceof NextResponse) return auth;
    const key = auth.userId;
    if ((connections.get(key) || 0) >= 5) {
      return new Response('Too many streams', { status: 429, headers: { 'Retry-After': '30' } });
    }
    connections.set(key, (connections.get(key) || 0) + 1);
    let cleanup = () => {};
    const stream = new ReadableStream({
      start(controller) {
        let closed = false;
        let busy = false;
        const pending: string[] = [];
        let heartbeatPending = false;
        let subscriber: Redis | undefined;
        let heartbeat: ReturnType<typeof setInterval> | undefined;
        let lifetime: ReturnType<typeof setTimeout> | undefined;
        cleanup = () => {
          if (closed) return;
          closed = true;
          pending.length = 0;
          heartbeatPending = false;
          clearInterval(heartbeat);
          clearTimeout(lifetime);
          req.signal.removeEventListener('abort', cleanup);
          subscriber?.disconnect();
          const remaining = (connections.get(key) || 1) - 1;
          if (remaining) connections.set(key, remaining);
          else connections.delete(key);
          try { controller.close(); } catch { /* Already cancelled. */ }
        };
        const drain = async () => {
          if (closed || busy) return;
          busy = true;
          try {
            while (!closed && (pending.length || heartbeatPending)) {
              const message = pending.shift();
              if (message === undefined) heartbeatPending = false;
              const current = await authenticate(req);
              if (closed) return;
              if (current instanceof NextResponse ||
                  current.userId !== auth.userId ||
                  current.organizationId !== auth.organizationId) {
                cleanup();
                return;
              }
              const allowed = await loadAccessibleRealtimeAccountIds(current);
              if (closed) return;
              const formatted = message === undefined
                ? ': heartbeat\n\n'
                : formatAccessibleSseMessage(message, allowed);
              if (formatted) {
                // Bound the controller queue as well as the authorization queue.
                if ((controller.desiredSize ?? 0) <= 0) { cleanup(); return; }
                controller.enqueue(formatted);
              }
            }
          } catch { cleanup(); }
          finally { busy = false; }
        };
        const refresh = (message?: string) => {
          if (closed) return;
          if (message === undefined) heartbeatPending = true;
          else {
            if (message.length > MAX_MESSAGE_LENGTH || pending.length >= MAX_PENDING_EVENTS) {
              cleanup();
              return;
            }
            pending.push(message);
          }
          void drain();
        };
        req.signal.addEventListener('abort', cleanup);
        if (req.signal.aborted) { cleanup(); return; }
        try {
          subscriber = new Redis(REDIS_URL, { retryStrategy: () => null });
          subscriber.on('error', cleanup);
          subscriber.on('end', cleanup);
          const channel = `new_email:${auth.organizationId}`;
          subscriber.on('message', (chan, message) => {
            if (chan === channel) void refresh(message);
          });
          void subscriber.subscribe(channel).catch(cleanup);
          controller.enqueue('retry: 5000\n\n');
          heartbeat = setInterval(() => { void refresh(); }, 15000);
          lifetime = setTimeout(cleanup, 5 * 60 * 1000);
        } catch { cleanup(); }
      },
      cancel() { cleanup(); },
    }, { highWaterMark: MAX_PENDING_EVENTS });

    return new Response(stream, {
      headers: {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache, no-transform',
        'Connection': 'keep-alive',
      },
    });
  } catch (error: unknown) {
    if (error instanceof Error && error.message === 'Unauthorized') {
      return new Response('Unauthorized', { status: 401 });
    }
    console.error('SSE setup error:', error);
    return new Response('Internal Server Error', { status: 500 });
  }
}
