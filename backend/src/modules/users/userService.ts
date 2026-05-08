import type { User } from "@prisma/client";
import { prisma } from "../../config/db.js";

export async function syncUserFromFirebase(input: {
  firebaseUid: string;
  email: string;
  displayName?: string | null;
  photoUrl?: string | null;
}): Promise<User> {
  return prisma.user.upsert({
    where: { firebaseUid: input.firebaseUid },
    create: {
      firebaseUid: input.firebaseUid,
      email: input.email,
      displayName: input.displayName ?? null,
      photoUrl: input.photoUrl ?? null,
    },
    update: {
      email: input.email,
      displayName: input.displayName ?? undefined,
      photoUrl: input.photoUrl ?? undefined,
    },
  });
}

export async function getUserByFirebaseUid(firebaseUid: string): Promise<User | null> {
  return prisma.user.findUnique({ where: { firebaseUid } });
}
