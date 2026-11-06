let refreshOperation: Promise<boolean> | undefined;
let refreshRequiresLogin = false;
let isIntercepted = false;

export function refreshTokenClient(): Promise<boolean> {
  if (refreshOperation) return refreshOperation;
  const refresh = async () => {
    refreshRequiresLogin = false;
    try {
      const fetchFn = typeof window !== 'undefined' ? window.fetch : fetch;
      for (let attempt = 0; attempt < 2; attempt++) {
        const res = await fetchFn('/api/auth/refresh', { method: 'POST', credentials: 'same-origin' });
        if (res.ok) return true;
        refreshRequiresLogin = res.status === 401;
        if (res.status !== 409 || attempt !== 0) return false;
        // A tab without Web Locks may have lost rotation. Give the winning
        // response time to set its shared cookie, then retry exactly once.
        await new Promise(resolve => setTimeout(resolve, 250));
      }
    } catch { /* Network/server failures leave the current page recoverable. */ }
    return false;
  };
  // Web Locks serialize refresh across tabs on supported secure contexts.
  const locks = typeof navigator !== 'undefined' ? navigator.locks : undefined;
  const operation = (async () => locks ? await locks.request('mailhub-session-refresh', refresh) : await refresh())();
  const pending = operation.finally(() => { refreshOperation = undefined; });
  refreshOperation = pending;
  return pending;
}

type InterceptedFetch = typeof fetch & { __originalFetch?: typeof fetch };

export function setupGlobalFetchInterceptor() {
  if (typeof window === 'undefined' || isIntercepted) return;
  const originalFetch = window.fetch;
  isIntercepted = true;
  const interceptedFetch: InterceptedFetch = async (input, init) => {
    const urlStr = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    const apiPath = urlStr.startsWith('/') && !urlStr.startsWith('//') ? urlStr.split('?')[0]
      : typeof window.location.origin === 'string' && new URL(urlStr, window.location.origin).origin === window.location.origin
      ? new URL(urlStr, window.location.origin).pathname : '';
    // Keep a replayable copy before fetch consumes a Request's body.
    const retryInput = input instanceof Request ? input.clone() : input;
    const response = await originalFetch.call(window, input, init);
    if (response.status === 401 && apiPath.startsWith('/api/') && !['/api/auth/login', '/api/auth/register', '/api/auth/refresh', '/api/auth/logout'].includes(apiPath)) {
      const body = await response.clone().json().catch(() => ({}));
      if (body.code === 'AUTH_REQUIRED') {
        redirectToLogin();
      } else if (body.code === 'AUTH_EXPIRED') {
        if (await refreshTokenClient()) {
          // One retry only, even if the replay also returns 401.
          return originalFetch.call(window, retryInput, init);
        }
        if (refreshRequiresLogin) redirectToLogin();
      }
    }
    return response;
  };
  interceptedFetch.__originalFetch = originalFetch;
  window.fetch = interceptedFetch;
  if (typeof global !== 'undefined') global.fetch = interceptedFetch;
}

function redirectToLogin() {
  if (!window.location.pathname.startsWith('/login')) {
    const callbackUrl = encodeURIComponent(window.location.pathname + window.location.search);
    window.location.href = `/login?callbackUrl=${callbackUrl}`;
  }
}

export function resetFetchInterceptor() {
  if (typeof window === 'undefined') return;
  const original = (window.fetch as InterceptedFetch).__originalFetch;
  if (original) {
    window.fetch = original;
    if (typeof global !== 'undefined') global.fetch = original;
  }
  isIntercepted = false;
}
