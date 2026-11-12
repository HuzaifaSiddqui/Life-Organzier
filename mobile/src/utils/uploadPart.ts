/** A picked file as the document picker gives it; on web it also carries the browser `File` (`file`). */
export type PickedFile = { uri: string; name: string; mimeType: string; file?: Blob | null };

/**
 * The multipart value for a picked file. The phone's XMLHttpRequest sends React Native's `{ uri, name, type }` part;
 * a browser (web / desktop) would send that object as the text "[object Object]", so there the real `File` goes.
 */
export function uploadPart(f: PickedFile): Blob | { uri: string; name: string; type: string } {
  return f.file ?? { uri: f.uri, name: f.name, type: f.mimeType };
}
