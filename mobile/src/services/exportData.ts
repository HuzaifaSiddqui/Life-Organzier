import { showAlert } from "./dialog";
import { shareFile } from "./share";

/** An export from the server: the file's name, type and bytes (base64). */
export type ExportFile = { filename: string; mime: string; data: string };
export type ExportFormat = "xlsx" | "csv";

type T = (key: "export.title" | "export.body" | "export.excel" | "export.csv" | "common.cancel") => string;

/**
 * Asks Excel or CSV, fetches the export in that format and hands the file to the share sheet (phone) or saves it
 * (desktop). Errors go to `onError` (shown as a toast by the caller).
 */
export function chooseAndExport(fetchFile: (format: ExportFormat) => Promise<ExportFile>, t: T, onError: (e: unknown) => void): void {
  const run = (format: ExportFormat) => {
    void (async () => {
      try {
        const f = await fetchFile(format);
        await shareFile(f.filename, f.mime, f.data);
      } catch (e) {
        onError(e);
      }
    })();
  };
  showAlert(t("export.title"), t("export.body"), [
    { text: t("common.cancel"), style: "cancel" },
    { text: t("export.csv"), onPress: () => run("csv") },
    { text: t("export.excel"), onPress: () => run("xlsx") },
  ]);
}
