import type { NextFunction, Request, Response } from "express";
import { getFirebaseAuth } from "../config/firebase.js";
import { sendError } from "../utils/apiResponse.js";

export type AuthRequest = Request & {
  firebase?: { uid: string; email?: string; name?: string; picture?: string };
};

export async function requireFirebaseUser(
  req: AuthRequest,
  res: Response,
  next: NextFunction
): Promise<void> {
  const header = req.headers.authorization;
  if (!header?.startsWith("Bearer ")) {
    sendError(res, "Missing or invalid Authorization header", "UNAUTHORIZED", 401);
    return;
  }

  const token = header.slice("Bearer ".length).trim();
  if (!token) {
    sendError(res, "Missing token", "UNAUTHORIZED", 401);
    return;
  }

  try {
    const decoded = await getFirebaseAuth().verifyIdToken(token);
    req.firebase = {
      uid: decoded.uid,
      email: decoded.email,
      name: decoded.name,
      picture: decoded.picture,
    };
    next();
  } catch {
    sendError(res, "Invalid or expired token", "UNAUTHORIZED", 401);
  }
}
