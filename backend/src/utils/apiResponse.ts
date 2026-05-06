import type { Response } from "express";

export function sendSuccess<T>(
  res: Response,
  data: T,
  message = "OK",
  status = 200
): void {
  res.status(status).json({ success: true, message, data });
}

export function sendError(
  res: Response,
  message: string,
  errorCode: string,
  status = 400
): void {
  res.status(status).json({ success: false, message, error: errorCode });
}
