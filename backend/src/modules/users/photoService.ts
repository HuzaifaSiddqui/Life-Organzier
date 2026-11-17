import type { User } from "@prisma/client";
import sharp from "sharp";
import { prisma } from "../../config/db.js";
import { HttpError } from "../../lib/http.js";
import { removeAvatars, saveAvatar } from "../../lib/storage.js";

/**
 * Profile photo. At sign-up a Google account's photo is used (at 400 px instead of Google's default 96). The user can
 * upload their own (the app crops it to a square in a circle frame) or remove it; after that, sign-in no longer
 * copies the Google photo over their choice (User.photoChosen).
 */

/** Largest upload accepted (the app sends a 512 px crop, well under this). */
export const MAX_PHOTO_BYTES = 1_500_000;
export const PHOTO_SIZE = 512;

/** Google profile photo URLs end in "=s96-c" (size); ask for 400 px so it's sharp on the profile. */
export function googlePhoto(url: string | null | undefined): string | null {
  const u = url?.trim();
  if (!u || !/^https:\/\//.test(u)) return null;
  return /googleusercontent\.com\//.test(u) ? u.replace(/=s\d+(-c)?$/, "=s400-c") : u;
}

/** The photo to keep at sign-in: the user's own choice wins; otherwise the Google photo (if any). */
export function photoAtSignIn(current: Pick<User, "photoUrl" | "photoChosen"> | null, fromToken: string | null | undefined): string | null | undefined {
  if (current?.photoChosen) return undefined; // unchanged
  const google = googlePhoto(fromToken);
  return google ?? undefined;
}

/** Decodes, squares and shrinks an uploaded photo (JPEG / PNG / WebP / HEIC as base64) to a 512 px JPEG. */
export async function normalisePhoto(base64: string): Promise<Buffer> {
  const raw = Buffer.from(base64.replace(/^data:[^;]+;base64,/, ""), "base64");
  if (!raw.length) throw new HttpError(400, "BAD_PHOTO", "That photo couldn't be read.");
  if (raw.length > MAX_PHOTO_BYTES) throw new HttpError(413, "PHOTO_TOO_LARGE", "That photo is too large.");
  try {
    return await sharp(raw, { failOn: "error" })
      .rotate()
      .resize(PHOTO_SIZE, PHOTO_SIZE, { fit: "cover", position: "centre" })
      .flatten({ background: "#ffffff" })
      .jpeg({ quality: 85, mozjpeg: true })
      .toBuffer();
  } catch {
    throw new HttpError(400, "BAD_PHOTO", "That photo couldn't be read.");
  }
}

export async function setPhoto(userId: string, base64: string): Promise<User> {
  const jpeg = await normalisePhoto(base64);
  const photoUrl = await saveAvatar(userId, jpeg);
  const user = await prisma.user.update({ where: { id: userId }, data: { photoUrl, photoChosen: true } });
  await removeAvatars(userId, photoUrl);
  return user;
}

export async function removePhoto(userId: string): Promise<User> {
  const user = await prisma.user.update({ where: { id: userId }, data: { photoUrl: null, photoChosen: true } });
  await removeAvatars(userId);
  return user;
}
