import "dotenv/config";
import { checkAndWarmModels } from "./ai/llm.js";
import { createApp } from "./app.js";
import { initFirebase } from "./config/firebase.js";
import { startJobs } from "./jobs/maintenance.js";

const port = Number(process.env.PORT ?? 5000);

initFirebase();

const app = createApp();
const server = app.listen(port, "0.0.0.0", () => {
  console.log(`API listening on http://localhost:${port}`);
  if (process.env.DISABLE_JOBS !== "true") startJobs();
  void checkAndWarmModels();
});
// Android's OkHttp keeps idle connections pooled for 5 min, Node closes them after 5 s. A request sent on a
// connection Node already closed gets retried, and file uploads can't be retried ("Stream Closed").
server.keepAliveTimeout = 6 * 60_000;
server.headersTimeout = server.keepAliveTimeout + 1000;
