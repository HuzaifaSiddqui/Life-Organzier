import { randomBytes } from "node:crypto";
import { mkdir, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";

/**
 * Files kept on the server's disk (STORAGE_DIR, default backend/storage, git-ignored):
 *   avatars/<userId>-<random>.jpg          profile photos, served at /media/avatars (the random part is the access key)
 *   documents/<userId>/<documentId>/…      a document's original file and its preview images (served only to its owner)
 * Everything a user has here goes when the account is deleted (removeUserFiles).
 */
export function storageRoot(): string {
  return path.resolve(process.env.STORAGE_DIR?.trim() || path.join(process.cwd(), "storage"));
}

export const avatarDir = () => path.join(storageRoot(), "avatars");
export const documentDir = (userId: string, documentId: string) => path.join(storageRoot(), "documents", safe(userId), safe(documentId));

/** Ids are UUIDs; anything else is reduced to a safe file name so a path can't leave its folder. */
function safe(id: string): string {
  return id.replace(/[^a-zA-Z0-9_-]/g, "_") || "_";
}

/** Writes a profile photo (JPEG bytes) and returns its public path ("/media/avatars/<file>"). */
export async function saveAvatar(userId: string, jpeg: Buffer): Promise<string> {
  await mkdir(avatarDir(), { recursive: true });
  const name = `${safe(userId)}-${randomBytes(12).toString("hex")}.jpg`;
  await writeFile(path.join(avatarDir(), name), jpeg);
  return `/media/avatars/${name}`;
}

/** Deletes the user's profile photo files, except `keep` (a "/media/avatars/…" path). */
export async function removeAvatars(userId: string, keep?: string | null): Promise<void> {
  const keepName = keep?.startsWith("/media/avatars/") ? keep.slice("/media/avatars/".length) : null;
  const names = await readdir(avatarDir()).catch(() => [] as string[]);
  await Promise.all(names.filter((n) => n.startsWith(`${safe(userId)}-`) && n !== keepName).map((n) => rm(path.join(avatarDir(), n), { force: true })));
}

export async function removeDocumentFiles(userId: string, documentId: string): Promise<void> {
  await rm(documentDir(userId, documentId), { recursive: true, force: true });
}

/** Account deleted: every file the user had on the server. */
export async function removeUserFiles(userId: string): Promise<void> {
  await removeAvatars(userId);
  await rm(path.join(storageRoot(), "documents", safe(userId)), { recursive: true, force: true });
}
