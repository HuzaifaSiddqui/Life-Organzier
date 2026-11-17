import { Share } from "react-native";

/** Hands a text export to the phone's share sheet (kept for plain text). The web / desktop build downloads a file. */
export async function shareText(filename: string, text: string): Promise<void> {
  await Share.share({ title: filename, message: text });
}

/**
 * Saves a file (base64) in the app's cache and opens the share sheet with it, so it can go to Drive, WhatsApp, email
 * or "Save to device" as a real .csv / .xlsx / .pdf file. The web / desktop build (share.web.ts) downloads it instead.
 */
export async function shareFile(filename: string, mime: string, base64: string): Promise<void> {
  const [{ File, Paths }, Sharing] = await Promise.all([import("expo-file-system"), import("expo-sharing")]);
  const file = new File(Paths.cache, filename.replace(/[\/:*?"<>|]/g, "_"));
  if (file.exists) file.delete();
  file.create();
  file.write(base64, { encoding: "base64" });
  if (!(await Sharing.isAvailableAsync())) throw new Error("Sharing isn't available on this phone.");
  await Sharing.shareAsync(file.uri, { mimeType: mime, dialogTitle: filename, UTI: mime === "text/csv" ? "public.comma-separated-values-text" : undefined });
}
