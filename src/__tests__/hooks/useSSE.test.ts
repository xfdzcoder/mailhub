const mockEffects: Array<() => void | (() => void)> = [];
const mockInvalidate = jest.fn();
const mockToast = jest.fn();
jest.mock('react', () => ({
  useEffect: (effect: () => void | (() => void)) => mockEffects.push(effect),
  useRef: () => ({ current: null }),
}));
jest.mock('@tanstack/react-query', () => ({ useQueryClient: () => ({ invalidateQueries: mockInvalidate }) }));
jest.mock('react-hot-toast', () => ({ __esModule: true, default: { success: mockToast } }));

import { useSSE } from '@/hooks/useSSE';

const previous = Object.fromEntries(['window', 'Notification', 'EventSource'].map(name => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
let handlers: Map<string, (event: { data: string }) => void>;
let cleanups: Array<() => void>;
let close: jest.Mock;
let focus: jest.Mock;
let notificationClose: jest.Mock;
let notify: jest.Mock;
beforeEach(() => {
  jest.clearAllMocks(); mockEffects.length = 0; cleanups = []; handlers = new Map();
  close = jest.fn(); focus = jest.fn(); notificationClose = jest.fn();
  notify = jest.fn().mockImplementation(() => ({ close: notificationClose }));
  Object.defineProperty(notify, 'permission', { value: 'granted', writable: true });
  Object.defineProperty(globalThis, 'window', { configurable: true, value: { focus, Notification: notify } });
  Object.defineProperty(globalThis, 'Notification', { configurable: true, value: notify });
  Object.defineProperty(globalThis, 'EventSource', { configurable: true, value: jest.fn().mockImplementation(() => ({
    addEventListener: (name: string, handler: (event: { data: string }) => void) => handlers.set(name, handler), close,
  })) });
  useSSE();
  for (const effect of mockEffects) { const cleanup = effect(); if (cleanup) cleanups.push(cleanup); }
});
afterEach(() => {
  for (const cleanup of cleanups) cleanup();
  for (const [name, descriptor] of Object.entries(previous)) {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor);
    else Reflect.deleteProperty(globalThis, name);
  }
});
it('alerts and refreshes queries for a minimal event without relying on mail content', () => {
  handlers.get('new_email')!({ data: JSON.stringify({ accountId: 'synthetic-account' }) });
  expect(mockToast).toHaveBeenCalledWith('New email received', { duration: 4000 });
  expect(notify).toHaveBeenCalledWith('New email received', {
    body: 'Open MailHub to view your inbox.', icon: '/favicon.ico',
  });
  const notification = notify.mock.results[0].value;
  notification.onclick();
  expect(focus).toHaveBeenCalledTimes(1);
  expect(notificationClose).toHaveBeenCalledTimes(1);
  expect(mockInvalidate.mock.calls.map(([options]) => options.queryKey)).toEqual([
    ['emails'], ['accounts'], ['labels'], ['new-emails-count'], ['accountStats'],
  ]);
});
it('keeps in-app alerts and refreshes when native permission is denied', () => {
  Object.defineProperty(notify, 'permission', { value: 'denied' });
  handlers.get('new_email')!({ data: JSON.stringify({ accountId: 'synthetic-account' }) });
  expect(mockToast).toHaveBeenCalledTimes(1);
  expect(notify).not.toHaveBeenCalled();
  expect(mockInvalidate).toHaveBeenCalledTimes(5);
});
