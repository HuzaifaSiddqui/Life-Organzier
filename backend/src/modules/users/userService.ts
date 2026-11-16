import type { User } from "@prisma/client";
import { prisma } from "../../config/db.js";

/**
 * Creates or refreshes the user for a Firebase account. A guest (FR-OB-003) has no email; once the same Firebase
 * account has an email (the guest converted), the user becomes a normal account and keeps all its data.
 */
export async function syncUserFromFirebase(input: {
  firebaseUid: string;
  email: string | null;
  isGuest?: boolean;
  displayName?: string | null;
  photoUrl?: string | null;
}): Promise<User> {
  const isGuest = Boolean(input.isGuest) && !input.email;
  return prisma.user.upsert({
    where: { firebaseUid: input.firebaseUid },
    create: {
      firebaseUid: input.firebaseUid,
      email: input.email,
      isGuest,
      displayName: input.displayName ?? null,
      photoUrl: input.photoUrl ?? null,
    },
    update: {
      // Never clear a known email: a guest token can't turn an account back into a guest.
      ...(input.email ? { email: input.email, isGuest: false } : {}),
      displayName: input.displayName ?? undefined,
      photoUrl: input.photoUrl ?? undefined,
    },
  });
}

export async function getUserByFirebaseUid(firebaseUid: string): Promise<User | null> {
  return prisma.user.findUnique({ where: { firebaseUid } });
}
