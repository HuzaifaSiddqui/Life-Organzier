import { useCallback, useEffect, useRef, useState } from "react";
import { isNetworkError } from "../services/api";
import { readCache, writeCache } from "../services/localCache";

export type CachedQuery<T> = {
  /** The last copy (from the device at first, then from the server). `null` only before anything was ever loaded. */
  data: T | null;
  /** True only while there is nothing to show yet (no saved copy and the first fetch hasn't answered). */
  loading: boolean;
  /** True while a background refresh runs over a copy that is already showing. */
  refreshing: boolean;
  /** The last refresh failed because the device is offline (the copy on screen may be old). */
  offline: boolean;
  error: unknown;
  reload: () => Promise<void>;
  /** Changes what's on screen at once (and the saved copy), before / without asking the server. */
  mutate: (update: (prev: T | null) => T | null) => void;
};

/**
 * Shows the screen's last saved copy immediately (also offline), then refreshes it from the server in the
 * background and saves the new copy. `name` is the cache key; `null` waits (e.g. no id yet).
 */
export function useCachedQuery<T>(name: string | null, fetcher: () => Promise<T>): CachedQuery<T> {
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const fetcherRef = useRef(fetcher);
  fetcherRef.current = fetcher;
  const nameRef = useRef(name);
  nameRef.current = name;
  const dataRef = useRef<T | null>(null);

  const reload = useCallback(async () => {
    const key = nameRef.current;
    if (!key) return;
    setRefreshing(true);
    try {
      const next = await fetcherRef.current();
      if (nameRef.current !== key) return;
      dataRef.current = next;
      setData(next);
      setError(null);
      void writeCache(key, next);
    } catch (e) {
      if (nameRef.current === key) setError(e);
    } finally {
      if (nameRef.current === key) {
        setRefreshing(false);
        setLoading(false);
      }
    }
  }, []);

  useEffect(() => {
    if (!name) return;
    let live = true;
    dataRef.current = null;
    setData(null);
    setLoading(true);
    setError(null);
    void readCache<T>(name).then((saved) => {
      if (!live) return;
      if (saved !== null && dataRef.current === null) {
        dataRef.current = saved;
        setData(saved);
        setLoading(false);
      }
    });
    void reload();
    return () => {
      live = false;
    };
  }, [name, reload]);

  const mutate = useCallback((update: (prev: T | null) => T | null) => {
    const next = update(dataRef.current);
    dataRef.current = next;
    setData(next);
    const key = nameRef.current;
    if (key && next !== null) void writeCache(key, next);
  }, []);

  return { data, loading, refreshing, offline: isNetworkError(error), error, reload, mutate };
}

/**
 * For screens with their own load function: `load(name, fetcher, apply)` shows the saved copy the first time this
 * screen loads `name` (also offline), then the server's answer, and saves that. A failed fetch throws as before.
 */
export function useCacheLoader() {
  const applied = useRef(new Set<string>());
  return useCallback(async <T,>(name: string, fetcher: () => Promise<T>, apply: (value: T) => void): Promise<void> => {
    if (!applied.current.has(name)) {
      applied.current.add(name);
      const saved = await readCache<T>(name);
      if (saved !== null) apply(saved);
    }
    const fresh = await fetcher();
    apply(fresh);
    void writeCache(name, fresh);
  }, []);
}
