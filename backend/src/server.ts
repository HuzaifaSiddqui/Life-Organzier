import "dotenv/config";
import { checkAndWarmModels } from "./ai/llm.js";
import { createApp } from "./app.js";
import { initFirebase } from "./config/firebase.js";
import { startJobs } from "./jobs/maintenance.js";
import { startWhatsappAgent, stopWhatsappAgent } from "./modules/whatsappAgent/index.js";

const port = Number(process.env.PORT ?? 5000);

initFirebase();

const app = createApp();
const server = app.listen(port, "0.0.0.0", () => {
  console.log(`API listening on http://localhost:${port}`);
  if (process.env.DISABLE_JOBS !== "true") startJobs();
  void checkAndWarmModels();
  // On unless WHATSAPP_AGENT=off (docs/whatsapp-agent.md). Outbound polling only: no tunnel needed.
  startWhatsappAgent().catch((error) => console.warn("WhatsApp Agent could not start:", error instanceof Error ? error.message : error));
});
// Graceful shutdown: stop the WhatsApp Agent pollers (releases their locks) before exiting.
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    void stopWhatsappAgent()
      .catch(() => undefined)
      .finally(() => server.close(() => process.exit(0)));
    setTimeout(() => process.exit(0), 10000).unref();
  });
}
// Android's OkHttp keeps idle connections pooled for 5 min, Node closes them after 5 s. A request sent on a
// connection Node already closed gets retried, and file uploads can't be retried ("Stream Closed").
server.keepAliveTimeout = 6 * 60_000;
server.headersTimeout = server.keepAliveTimeout + 1000;
