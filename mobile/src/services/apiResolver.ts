import AsyncStorage from "@react-native-async-storage/async-storage";
import axios from "axios";
import Constants from "expo-constants";
import {
  getEnvExtraHostIps,
  getEnvFallbackApiBaseUrls,
  getPrimaryApiBaseUrl,
  healthCheckUrlFromApiBase,
  inferPortFromApiUrl,
  normalizeApiBase,
} from "../constants/config";
import { api } from "./api";

const STORAGE_LAST_GOOD = "life-organizer:last-working-api-base";
const STORAGE_SAVED_IPS = "life-organizer:saved-api-host-ips";

const IPV4_RE = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;

export function isValidLanIpv4(host: string): boolean {
  const m = host.trim().match(IPV4_RE);
  if (!m) return false;
  return m.slice(1, 5).every((oct) => {
    const n = parseInt(oct, 10);
    return n >= 0 && n <= 255;
  });
}

export async function loadSavedHostIps(): Promise<string[]> {
  try {
    const raw = await AsyncStorage.getItem(STORAGE_SAVED_IPS);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((x): x is string => typeof x === "string" && isValidLanIpv4(x));
  } catch {
    return [];
  }
}

export async function saveHostIp(ip: string): Promise<void> {
  const trimmed = ip.trim();
  if (!isValidLanIpv4(trimmed)) return;
  const existing = await loadSavedHostIps();
  const next = [trimmed, ...existing.filter((h) => h !== trimmed)].slice(0, 12);
  await AsyncStorage.setItem(STORAGE_SAVED_IPS, JSON.stringify(next));
}

function getExpoBundlerLanIp(): string | null {
  const dbg = Constants.expoGoConfig?.debuggerHost;
  if (typeof dbg === "string" && dbg.length > 0) {
    const ip = dbg.split(":")[0];
    if (ip && isValidLanIpv4(ip)) return ip;
  }
  const hostUri = Constants.expoConfig?.hostUri;
  if (typeof hostUri === "string" && hostUri.length > 0) {
    const stripped = hostUri.replace(/^[^:]+:\/\//, "").replace(/^\/*/, "");
    const ip = stripped.split(":")[0];
    if (ip && isValidLanIpv4(ip)) return ip;
  }
  return null;
}

function dedupe(urls: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const u of urls) {
    const n = normalizeApiBase(u);
    if (seen.has(n)) continue;
    seen.add(n);
    out.push(n);
  }
  return out;
}

async function loadLastGoodBase(): Promise<string | null> {
  try {
    const v = await AsyncStorage.getItem(STORAGE_LAST_GOOD);
    return v && v.length > 0 ? normalizeApiBase(v) : null;
  } catch {
    return null;
  }
}

async function persistLastGoodBase(base: string): Promise<void> {
  try {
    await AsyncStorage.setItem(STORAGE_LAST_GOOD, normalizeApiBase(base));
  } catch {
    /* ignore */
  }
}

async function probe(apiBase: string): Promise<boolean> {
  const url = healthCheckUrlFromApiBase(apiBase);
  try {
    const res = await axios.get<{ ok?: boolean }>(url, {
      timeout: 4000,
      validateStatus: (s) => s === 200,
    });
    return res.data?.ok === true;
  } catch {
    return false;
  }
}

function hostPortCandidates(primary: string): { port: number } {
  return { port: inferPortFromApiUrl(primary) };
}

async function buildCandidateBases(): Promise<string[]> {
  const primary = normalizeApiBase(getPrimaryApiBaseUrl());
  const { port } = hostPortCandidates(primary);

  const lastGood = await loadLastGoodBase();
  const savedIps = await loadSavedHostIps();
  const envIps = getEnvExtraHostIps();
  const expoIp = getExpoBundlerLanIp();

  const fromIps = (ips: string[]) =>
    ips.filter(isValidLanIpv4).map((ip) => normalizeApiBase(`http://${ip}:${port}`));

  const list: string[] = [];

  if (lastGood) list.push(lastGood);
  list.push(primary);

  if (expoIp) {
    list.push(normalizeApiBase(`http://${expoIp}:${port}`));
  }

  for (const u of getEnvFallbackApiBaseUrls()) {
    list.push(normalizeApiBase(u));
  }

  list.push(...fromIps(envIps));
  list.push(...fromIps(savedIps));

  return dedupe(list);
}

/**
 * Probes `/health` for each candidate (last-good → env primary → Expo QR host → fallbacks → saved IPs)
 * and sets `api.defaults.baseURL` to the first match. Persists the winner for the next launch.
 */
export async function resolveAndApplyApiBase(): Promise<boolean> {
  const candidates = await buildCandidateBases();

  for (const base of candidates) {
    if (await probe(base)) {
      api.defaults.baseURL = base;
      await persistLastGoodBase(base);
      return true;
    }
  }

  api.defaults.baseURL = normalizeApiBase(getPrimaryApiBaseUrl());
  return false;
}
