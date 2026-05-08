import "dotenv/config";
import { createApp } from "./app.js";
import { initFirebase } from "./config/firebase.js";

const port = Number(process.env.PORT ?? 5000);

initFirebase();

const app = createApp();
app.listen(port, () => {
  console.log(`API listening on http://localhost:${port}`);
});
