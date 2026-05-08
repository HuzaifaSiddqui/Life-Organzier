import cors from "cors";
import express from "express";
import { authRouter } from "./modules/auth/authRoutes.js";
import { parserRouter } from "./modules/parser/parserRoutes.js";
import { taskRouter } from "./modules/tasks/taskRoutes.js";
import { userRouter } from "./modules/users/userRoutes.js";

export function createApp() {
  const app = express();
  app.use(cors());
  app.use(express.json());

  app.get("/health", (_req, res) => {
    res.json({ ok: true });
  });

  app.get("/", (_req, res) => {
    res.json({
      ok: true,
      message: "Life Organizer API is running",
      health: "/health",
      apiBase: "/api",
    });
  });

  app.use("/api/auth", authRouter);
  app.use("/api/users", userRouter);
  app.use("/api/tasks", taskRouter);
  app.use("/api/parser", parserRouter);

  return app;
}
