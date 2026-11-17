/**
 * Web / desktop build of services/share.ts: the browser share sheet is missing or refuses files in Electron, so the
 * export is saved as a file (the desktop shell asks where; a browser puts it in Downloads).
 */
function download(filename: string, blob: Blob): void {
  const url = URL.createObjectURL(blob);
  try {
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
  } finally {
    setTimeout(() => URL.revokeObjectURL(url), 10000);
  }
}

export async function shareText(filename: string, text: string): Promise<void> {
  download(filename, new Blob([text], { type: "text/csv;charset=utf-8" }));
}

export async function shareFile(filename: string, mime: string, base64: string): Promise<void> {
  const bin = atob(base64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) bytes[i] = bin.charCodeAt(i);
  download(filename, new Blob([bytes], { type: mime }));
}
