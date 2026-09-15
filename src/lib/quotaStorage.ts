// Utility to handle Firestore quota exhaustion gracefully with local storage fallbacks

type QuotaListener = (exceeded: boolean) => void;

const listeners: Set<QuotaListener> = new Set();
let quotaExceededState = false;

// Check if quota was already marked as exceeded in this session
try {
  if (typeof sessionStorage !== 'undefined' && sessionStorage.getItem('firestore_quota_exceeded') === 'true') {
    quotaExceededState = true;
  }
} catch (e) {
  // Ignore
}

export function isQuotaExceeded(): boolean {
  return quotaExceededState;
}

export function subscribeQuotaState(listener: QuotaListener): () => void {
  listeners.add(listener);
  // Immediately notify of current state
  listener(quotaExceededState);
  return () => {
    listeners.delete(listener);
  };
}

export function markQuotaExceeded(err?: any) {
  if (!quotaExceededState) {
    quotaExceededState = true;
    try {
      if (typeof sessionStorage !== 'undefined') {
        sessionStorage.setItem('firestore_quota_exceeded', 'true');
      }
    } catch (e) {
      // Ignore
    }
    console.warn("⚠️ Firestore Quota Exceeded! Switching to resilient LocalStorage fallback mode.", err);
    listeners.forEach(l => l(true));
  }
}

export function isQuotaError(err: any): boolean {
  if (!err) return false;
  const msg = (err.message || String(err)).toLowerCase();
  const code = (err.code || '').toLowerCase();
  return (
    code === 'resource-exhausted' ||
    msg.includes('quota') ||
    msg.includes('resource-exhausted') ||
    msg.includes('quota limit exceeded') ||
    msg.includes('free daily write units') ||
    msg.includes('free daily read units')
  );
}

// Local Cache Helper
export function setLocalCache(key: string, data: any) {
  try {
    if (typeof localStorage !== 'undefined') {
      localStorage.setItem(`fs_fallback_${key}`, JSON.stringify(data));
    }
  } catch (e) {
    console.warn("Failed to set local cache:", e);
  }
}

export function getLocalCache<T = any>(key: string): T | null {
  try {
    if (typeof localStorage !== 'undefined') {
      const val = localStorage.getItem(`fs_fallback_${key}`);
      if (val) return JSON.parse(val);
    }
  } catch (e) {
    console.warn("Failed to get local cache:", e);
  }
  return null;
}

export function removeLocalCache(key: string) {
  try {
    if (typeof localStorage !== 'undefined') {
      localStorage.removeItem(`fs_fallback_${key}`);
    }
  } catch (e) {
    // Ignore
  }
}
