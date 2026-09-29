import axios, { type AxiosError } from "axios";
import { API_BASE_URL } from "../constants/config";
import { auth } from "../lib/firebase";
import type { ApiError, ApiSuccess } from "../types/models";

export const api = axios.create({
  baseURL: API_BASE_URL,
  timeout: 20000,
});

api.interceptors.request.use(async (config) => {
  const user = auth.currentUser;
  if (user) {
    const token = await user.getIdToken();
    config.headers.Authorization = `Bearer ${token}`;
  }
  return config;
});

export function isApiError(payload: unknown): payload is ApiError {
  return (
    typeof payload === "object" &&
    payload !== null &&
    (payload as ApiError).success === false
  );
}

export function getApiErrorMessage(error: unknown, fallback = "Request failed"): string {
  if (axios.isAxiosError<ApiError>(error)) {
    return error.response?.data?.message ?? error.message ?? fallback;
  }
  return error instanceof Error ? error.message : fallback;
}

export async function unwrap<T>(fn: () => Promise<{ data: ApiSuccess<T> | ApiError }>): Promise<T> {
  try {
    const { data } = await fn();
    if (!data.success) {
      throw new Error(data.message);
    }
    return data.data;
  } catch (e) {
    const err = e as AxiosError<ApiError>;
    const msg = err.response?.data?.message ?? err.message ?? "Request failed";
    throw new Error(msg);
  }
}
