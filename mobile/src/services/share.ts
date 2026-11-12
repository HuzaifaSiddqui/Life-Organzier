import { Share } from "react-native";

/** Hands a text export (CSV) to the phone's share sheet. The web / desktop build (share.web.ts) downloads a file instead. */
export async function shareText(filename: string, text: string): Promise<void> {
  await Share.share({ title: filename, message: text });
}
