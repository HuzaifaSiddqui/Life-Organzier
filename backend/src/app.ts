import cors from "cors";
import express, { type NextFunction, type Request, type Response } from "express";
import { getAi, getModelStatus } from "./ai/llm.js";
import { setTimezoneChangeHandler } from "./lib/http.js";
import { accountRouter } from "./modules/account/accountRoutes.js";
import { analyticsRouter } from "./modules/analytics/analyticsRoutes.js";
import { assistantRouter } from "./modules/assistant/assistantRoutes.js";
import { authRouter } from "./modules/auth/authRoutes.js";
import { documentRouter } from "./modules/documents/documentRoutes.js";
import { eventRouter } from "./modules/events/eventRoutes.js";
import { insightRouter, memoryRouter } from "./modules/memory/memoryRoutes.js";
import { moodRouter } from "./modules/mood/moodRoutes.js";
import { preferenceRouter } from "./modules/preferences/preferenceRoutes.js";
import { reminderRouter } from "./modules/reminders/reminderRoutes.js";
import { routineRouter } from "./modules/routines/routineRoutes.js";
import { schedulingRouter } from "./modules/scheduling/schedulingRoutes.js";
import { categoryRouter, settingsRouter, tagRouter } from "./modules/settings/settingsRoutes.js";
import { syncRouter } from "./modules/sync/syncRoutes.js";
import { recomputeDueAts } from "./modules/tasks/taskService.js";
import { taskRouter } from "./modules/tasks/taskRoutes.js";
import { userRouter } from "./modules/users/userRoutes.js";
import { whatsappRouter } from "./modules/whatsapp/whatsappRoutes.js";
import { sendError } from "./utils/apiResponse.js";

export function createApp() {
  const app = express();
  app.use(cors());
  app.use(express.json({ limit: "2mb" }));

  setTimezoneChangeHandler((userId, tz) => {
    recomputeDueAts(userId, tz).catch((error) => console.warn("Could not recompute deadlines", error));
  });

  app.get("/health", (_req, res) => {
    const models = getModelStatus();
    const available = getAi().available && models.chat !== false;
    res.json({ ok: true, ai: { enabled: getAi().enabled, available, models } });
  });

  app.get("/", (_req, res) => {
    res.json({ ok: true, message: "Life Organizer API is running", health: "/health", apiBase: "/api" });
  });

  app.use("/api/auth", authRouter);
  app.use("/api/users", userRouter);
  app.use("/api/assistant", assistantRouter);
  app.use("/api/tasks", taskRouter);
  app.use("/api/sync", syncRouter);
  app.use("/api/routines", routineRouter);
  app.use("/api/mood", moodRouter);
  app.use("/api/memory", memoryRouter);
  app.use("/api/insights", insightRouter);
  app.use("/api/reminders", reminderRouter);
  app.use("/api/scheduling", schedulingRouter);
  app.use("/api/analytics", analyticsRouter);
  app.use("/api/settings", settingsRouter);
  app.use("/api/categories", categoryRouter);
  app.use("/api/tags", tagRouter);
  app.use("/api/documents", documentRouter);
  app.use("/api/events", eventRouter);
  app.use("/api/account", accountRouter);
  app.use("/api/preferences", preferenceRouter);
  app.use("/api/whatsapp", whatsappRouter);

  app.use((_req, res) => sendError(res, "Not found", "NOT_FOUND", 404));
  app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (error instanceof SyntaxError && "body" in (error as object)) {
      sendError(res, "Malformed JSON body", "BAD_JSON", 400);
      return;
    }
    console.error("Unhandled error", error);
    sendError(res, "Something went wrong", "INTERNAL_ERROR", 500);
  });

  return app;
}
