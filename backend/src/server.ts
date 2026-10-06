import "dotenv/config";
import { createApp } from "./app.js";
import { initFirebase } from "./config/firebase.js";
import { startJobs } from "./jobs/maintenance.js";

const port = Number(process.env.PORT ?? 5000);

initFirebase();

const app = createApp();
app.listen(port, "0.0.0.0", () => {
  console.log(`API listening on http://localhost:${port}`);
  if (process.env.DISABLE_JOBS !== "true") startJobs();
});
