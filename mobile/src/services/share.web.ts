/**
 * Web / desktop build of services/share.ts: the browser share sheet is missing or refuses text in Electron, so the
 * export is saved as a file (the desktop shell asks where; a browser puts it in Downloads).
 */
export async function shareText(filename: string, text: string): Promise<void> {
  const url = URL.createObjectURL(new Blob([text], { type: "text/csv;charset=utf-8" }));
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
