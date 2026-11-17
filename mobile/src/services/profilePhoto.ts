import type { User } from "../types/models";
import { api, apiDelete, apiPut } from "./api";

/**
 * Profile photo: picked from the gallery or camera (expo-image-picker), cropped in the app to the square under the
 * circle frame (screens/profile/PhotoCropScreen.tsx), shrunk to 512 px and uploaded. The server keeps one photo per
 * user; Google's photo is used until the user picks or removes their own.
 */

export type PickedPhoto = { uri: string; width: number; height: number };
export const PHOTO_SIZE = 512;

/** "/media/avatars/…" (uploaded) → full URL on the API's host; Google's https URLs as they are. */
export function avatarUri(photoUrl: string | null | undefined): string | null {
  if (!photoUrl) return null;
  if (/^https?:\/\//.test(photoUrl)) return photoUrl;
  const base = String(api.defaults.baseURL ?? "").replace(/\/api\/?$/, "").replace(/\/$/, "");
  return base ? `${base}${photoUrl}` : null;
}

/** Opens the gallery or the camera. Null: cancelled, or no permission (`denied`). */
export async function pickPhoto(from: "library" | "camera"): Promise<PickedPhoto | "denied" | null> {
  const Picker = await import("expo-image-picker");
  if (from === "camera") {
    const perm = await Picker.requestCameraPermissionsAsync();
    if (!perm.granted) return "denied";
  }
  const options = { mediaTypes: ["images" as const], allowsEditing: false, quality: 1, exif: false };
  const r = from === "camera" ? await Picker.launchCameraAsync({ ...options, cameraType: Picker.CameraType.front }) : await Picker.launchImageLibraryAsync(options);
  const a = r.canceled ? null : r.assets?.[0];
  return a ? { uri: a.uri, width: a.width, height: a.height } : null;
}

/** Crops the square, shrinks it to 512 px and uploads it. Returns the updated user. */
export async function uploadCroppedPhoto(uri: string, crop: { originX: number; originY: number; width: number; height: number }): Promise<User> {
  const { ImageManipulator, SaveFormat } = await import("expo-image-manipulator");
  const ctx = ImageManipulator.manipulate(uri);
  ctx.crop(crop);
  if (crop.width > PHOTO_SIZE) ctx.resize({ width: PHOTO_SIZE, height: PHOTO_SIZE });
  const image = await ctx.renderAsync();
  const saved = await image.saveAsync({ format: SaveFormat.JPEG, compress: 0.88, base64: true });
  if (!saved.base64) throw new Error("The photo couldn't be prepared.");
  return (await apiPut<{ user: User }>("/users/me/photo", { image: saved.base64 })).user;
}

export async function removeProfilePhoto(): Promise<User> {
  return (await apiDelete<{ user: User }>("/users/me/photo")).user;
}
