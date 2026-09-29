import AsyncStorage from "@react-native-async-storage/async-storage";
import axios from "axios";
import Constants from "expo-constants";
import * as Network from "expo-network";
import {
  getEnvExtraHostIps,
  getEnvFallbackApiBaseUrls,
  getPrimaryApiBaseUrl,
  healthCheckUrlFromApiBase,
  inferPortFromApiUrl,
  normalizeApiBase,
} from "../constants/config";
import { api } from "./api";

const STORAGE_LAST_GOOD = "life-organizer:last-working-api-base:v2";
const STORAGE_SAVED_IPS = "life-organizer:saved-api-host-ips";

const IPV4_RE = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;
const HOST_WITH_OPTIONAL_PORT_RE = /^(\d{1,3}(?:\.\d{1,3}){3})(?::(\d{1,5}))?$/;

export function isValidLanIpv4(host: string): boolean {
  const m = host.trim().match(IPV4_RE);
  if (!m) return false;
  return m.slice(1, 5).every((oct) => {
    const n = parseInt(oct, 10);
    return n >= 0 && n <= 255;
  });
}

function isValidPort(port: number): boolean {
  return Number.isInteger(port) && port > 0 && port <= 65535;
}

export function isValidLanHostEntry(value: string): boolean {
  return parseHostEntry(value) !== null;
}

function parseHostEntry(raw: string): { host: string; port?: number } | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;

  try {
    const url = trimmed.includes("://") ? new URL(trimmed) : null;
    if (url) {
      const host = url.hostname;
      const port = url.port ? Number(url.port) : undefined;
      if (!isValidLanIpv4(host)) return null;
      if (port !== undefined && !isValidPort(port)) return null;
      return { host, port };
    }
  } catch {
    // ignore invalid URL shapes and fall back to host parsing
  }

  const hostMatch = trimmed.match(HOST_WITH_OPTIONAL_PORT_RE);
  if (!hostMatch) return null;

  const host = hostMatch[1];
  const port = hostMatch[2] ? Number(hostMatch[2]) : undefined;
  if (!isValidLanIpv4(host)) return null;
  if (port !== undefined && !isValidPort(port)) return null;
  return { host, port };
}

function normalizeSavedHostEntry(raw: string): string | null {
  const parsed = parseHostEntry(raw);
  if (!parsed) return null;
  return parsed.port ? `${parsed.host}:${parsed.port}` : parsed.host;
}

function apiBaseFromSavedHost(hostEntry: string, defaultPort: number): string | null {
  const parsed = parseHostEntry(hostEntry);
  if (!parsed) return null;
  return `http://${parsed.host}:${parsed.port ?? defaultPort}`;
}

export async function loadSavedHostIps(): Promise<string[]> {
  try {
    const raw = await AsyncStorage.getItem(STORAGE_SAVED_IPS);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((x): x is string => typeof x === "string" && parseHostEntry(x) !== null);
  } catch {
    return [];
  }
}

export async function saveHostIp(ip: string): Promise<void> {
  const normalized = normalizeSavedHostEntry(ip);
  if (!normalized) return;
  const existing = await loadSavedHostIps();
  const next = [normalized, ...existing.filter((h) => h !== normalized)].slice(0, 12);
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
  const deviceIp = await getDeviceLanIp();
  const localLanHosts = deviceIp ? buildLocalLanCandidates(deviceIp, port) : [];

  const savedHostCandidates = (hosts: string[]) =>
    hosts
      .map((entry) => apiBaseFromSavedHost(entry, port))
      .filter((entry): entry is string => Boolean(entry))
      .map((entry) => normalizeApiBase(entry));

  const list: string[] = [];

  if (lastGood) list.push(lastGood);
  list.push(primary);

  if (expoIp) {
    list.push(normalizeApiBase(`http://${expoIp}:${port}`));
  }

  list.push(...localLanHosts);

  for (const u of getEnvFallbackApiBaseUrls()) {
    list.push(normalizeApiBase(u));
  }

  list.push(...savedHostCandidates(envIps));
  list.push(...savedHostCandidates(savedIps));

  return dedupe(list);
}

async function getDeviceLanIp(): Promise<string | null> {
  try {
    const ipAddress = await Network.getIpAddressAsync();
    if (typeof ipAddress === "string" && isValidLanIpv4(ipAddress)) {
      return ipAddress;
    }
  } catch {
    // ignore
  }
  return null;
}

function buildLocalLanCandidates(deviceIp: string, port: number): string[] {
  const prefix = getLanSubnetPrefix(deviceIp);
  if (!prefix) return [];

  return ["1", "2", "5", "10", "20", "50", "100", "150", "200", "254"]
    .map((last) => normalizeApiBase(`http://${prefix}.${last}:${port}`));
}

function getLanSubnetPrefix(ip: string): string | null {
  if (!isValidLanIpv4(ip)) return null;
  const [a, b, c] = ip.split(".").map((part) => parseInt(part, 10));
  if (a === 10) return `${a}.${b}.${c}`;
  if (a === 172 && b >= 16 && b <= 31) return `${a}.${b}.${c}`;
  if (a === 192 && b === 168) return `${a}.${b}.${c}`;
  return null;
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
