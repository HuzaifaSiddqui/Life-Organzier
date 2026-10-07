import axios, { type AxiosError, type AxiosRequestConfig } from "axios";
import { API_BASE_URL } from "../constants/config";
import { auth } from "../lib/firebase";
import type { ApiError, ApiSuccess } from "../types/models";
import { getDeviceId } from "./device";

export const api = axios.create({
  baseURL: API_BASE_URL,
  timeout: 20000,
});

function deviceTimezone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}

api.interceptors.request.use(async (config) => {
  const user = auth.currentUser;
  if (user) {
    const token = await user.getIdToken();
    config.headers.Authorization = `Bearer ${token}`;
  }
  // The server interprets "today", deadlines and quiet hours in the device's timezone.
  config.headers["X-Timezone"] = deviceTimezone();
  config.headers["X-Device-Id"] = await getDeviceId();
  return config;
});

export function isApiError(payload: unknown): payload is ApiError {
  return typeof payload === "object" && payload !== null && (payload as ApiError).success === false;
}

export function getApiErrorMessage(error: unknown, fallback = "Request failed"): string {
  if (axios.isAxiosError<ApiError>(error)) {
    if (!error.response) return "You're offline or the server can't be reached.";
    return error.response.data?.message ?? error.message ?? fallback;
  }
  return error instanceof Error ? error.message : fallback;
}

export function isNetworkError(error: unknown): boolean {
  return axios.isAxiosError(error) && !error.response;
}

export function apiErrorCode(error: unknown): string | null {
  return axios.isAxiosError<ApiError>(error) ? (error.response?.data?.error ?? null) : null;
}

export async function unwrap<T>(fn: () => Promise<{ data: ApiSuccess<T> | ApiError }>): Promise<T> {
  try {
    const { data } = await fn();
    if (!data.success) throw new Error(data.message);
    return data.data;
  } catch (e) {
    const err = e as AxiosError<ApiError>;
    const msg = err.response?.data?.message ?? err.message ?? "Request failed";
    throw new Error(msg);
  }
}

/** Typed helpers that keep the original error (so callers can detect offline / error codes). */
export async function apiGet<T>(url: string, config?: AxiosRequestConfig): Promise<T> {
  const res = await api.get<ApiSuccess<T> | ApiError>(url, config);
  if (!res.data.success) throw new Error(res.data.message);
  return res.data.data;
}

export async function apiPost<T>(url: string, body?: unknown, config?: AxiosRequestConfig): Promise<T> {
  const res = await api.post<ApiSuccess<T> | ApiError>(url, body ?? {}, config);
  if (!res.data.success) throw new Error(res.data.message);
  return res.data.data;
}

export async function apiPut<T>(url: string, body?: unknown): Promise<T> {
  const res = await api.put<ApiSuccess<T> | ApiError>(url, body ?? {});
  if (!res.data.success) throw new Error(res.data.message);
  return res.data.data;
}

export async function apiPatch<T>(url: string, body?: unknown): Promise<T> {
  const res = await api.patch<ApiSuccess<T> | ApiError>(url, body ?? {});
  if (!res.data.success) throw new Error(res.data.message);
  return res.data.data;
}

export async function apiDelete<T>(url: string): Promise<T> {
  const res = await api.delete<ApiSuccess<T> | ApiError>(url);
  if (!res.data.success) throw new Error(res.data.message);
  return res.data.data;
}
