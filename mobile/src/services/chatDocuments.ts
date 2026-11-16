import * as DocumentPicker from "expo-document-picker";
import * as Network from "expo-network";

/**
 * Picking a document to send in the assistant chat ("+" in the message box). The upload itself is
 * documentsApi.uploadDocument with the chat option.
 */

export const CHAT_DOC_MAX_BYTES = 10 * 1024 * 1024;

/** `file`: the browser File on web / desktop (uploaded as is; see utils/uploadPart). */
export type PickedDoc = { uri: string; name: string; mimeType: string; size: number; file?: Blob | null };

export async function pickChatDocument(): Promise<PickedDoc | "too_large" | null> {
  const res = await DocumentPicker.getDocumentAsync({
    type: ["application/pdf", "image/jpeg", "image/png", "application/vnd.openxmlformats-officedocument.wordprocessingml.document"],
    copyToCacheDirectory: true,
  });
  if (res.canceled || !res.assets[0]) return null;
  const a = res.assets[0];
  if ((a.size ?? 0) > CHAT_DOC_MAX_BYTES) return "too_large";
  return { uri: a.uri, name: a.name, mimeType: a.mimeType ?? "application/octet-stream", size: a.size ?? 0, file: a.file ?? null };
}

export async function isOnline(): Promise<boolean> {
  const net = await Network.getNetworkStateAsync();
  return Boolean(net.isConnected) && net.isInternetReachable !== false;
}
