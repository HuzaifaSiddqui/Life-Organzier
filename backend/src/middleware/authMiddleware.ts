import type { NextFunction, Request, Response } from "express";
import { getFirebaseAuth } from "../config/firebase.js";
import { sendError } from "../utils/apiResponse.js";

export type AuthRequest = Request & {
  /** `provider`: how they signed in ("password", "anonymous" for guests, FR-OB-003). */
  firebase?: { uid: string; email?: string; name?: string; picture?: string; provider?: string };
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
      provider: decoded.firebase?.sign_in_provider,
    };
    next();
  } catch {
    sendError(res, "Invalid or expired token", "UNAUTHORIZED", 401);
  }
}
