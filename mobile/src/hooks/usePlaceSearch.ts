import * as Location from "expo-location";
import { useEffect, useRef, useState } from "react";
import { searchPlaces, type GeoResult } from "../services/locationsApi";
import type { SavedLocation } from "../types/models";

/**
 * FR-LB-001 place search through the backend: waits 500 ms after typing, needs 3+ letters, and biases
 * results towards the user (last known position, else their saved "Home").
 */
export function usePlaceSearch(query: string, saved: SavedLocation[]) {
  const [results, setResults] = useState<GeoResult[] | null>(null);
  const [searching, setSearching] = useState(false);
  const [failed, setFailed] = useState(false);
  const near = useRef<{ latitude: number; longitude: number } | null>(null);

  useEffect(() => {
    void (async () => {
      const granted = (await Location.getForegroundPermissionsAsync().catch(() => ({ granted: false }))).granted;
      const pos = granted ? await Location.getLastKnownPositionAsync({ maxAge: 3600000 }).catch(() => null) : null;
      const home = saved.find((p) => ["home", "ghar"].includes(p.name.trim().toLowerCase()));
      near.current = pos ? pos.coords : home ? { latitude: home.latitude, longitude: home.longitude } : null;
    })();
  }, [saved]);

  useEffect(() => {
    const q = query.trim();
    if (q.length < 3) {
      setResults(null);
      return;
    }
    let live = true;
    const timer = setTimeout(async () => {
      setSearching(true);
      try {
        const r = await searchPlaces(q, near.current);
        if (live) {
          setResults(r);
          setFailed(false);
        }
      } catch {
        if (live) setFailed(true);
      } finally {
        if (live) setSearching(false);
      }
    }, 500);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [query]);

  return { results, searching, failed };
}
