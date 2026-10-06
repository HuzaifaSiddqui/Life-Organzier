import { Router } from "express";
import { z } from "zod";
import { prisma } from "../../config/db.js";
import { handle, HttpError, parseBody, requireUser } from "../../lib/http.js";
import { requireFirebaseUser } from "../../middleware/authMiddleware.js";
import { sendSuccess } from "../../utils/apiResponse.js";
import { getPatterns, RECOMMEND_THRESHOLD } from "../patterns/patternService.js";
import { acceptRecommendation, dismissRecommendation, getRecommendations } from "../patterns/recommendationService.js";
import { deleteMemory, listMemories, rememberFact, updateMemoryContent } from "./memoryService.js";

/** Transparency: the user can see, correct and delete everything the assistant has learned. */
export const memoryRouter = Router();
memoryRouter.use(requireFirebaseUser, requireUser);

memoryRouter.get(
  "/",
  handle(async (req, res) => {
    const [memories, patterns] = await Promise.all([listMemories(req.user.id), getPatterns(req.user.id, req.settings.timezone)]);
    sendSuccess(res, {
      memories: memories
        .filter((m) => m.kind !== "CORRECTION")
        .map(({ embedding: _e, ...m }) => m),
      patterns: patterns.map((p) => ({ ...p, active: p.confidence >= RECOMMEND_THRESHOLD })),
    });
  }),
);

memoryRouter.post(
  "/",
  handle(async (req, res) => {
    const body = parseBody(
      z.object({ content: z.string().trim().min(3).max(500), kind: z.enum(["FACT", "PREFERENCE", "COPING", "GOAL"]).default("PREFERENCE") }),
      req.body,
    );
    const content = /^user\b/i.test(body.content) ? body.content : `User: ${body.content}`;
    const { memory, reinforced } = await rememberFact(req.user.id, { kind: body.kind, content, importance: 0.85, source: "manual" });
    const { embedding: _e, ...rest } = memory;
    sendSuccess(res, { memory: rest, reinforced }, reinforced ? "Updated an existing memory" : "Saved", 201);
  }),
);

memoryRouter.put(
  "/:id",
  handle(async (req, res) => {
    const { content } = parseBody(z.object({ content: z.string().trim().min(3).max(500) }), req.body);
    const memory = await updateMemoryContent(req.user.id, req.params.id, content);
    if (!memory) throw new HttpError(404, "MEMORY_NOT_FOUND", "Memory not found");
    const { embedding: _e, ...rest } = memory;
    sendSuccess(res, { memory: rest }, "Memory updated");
  }),
);

memoryRouter.delete(
  "/:id",
  handle(async (req, res) => {
    if (!(await deleteMemory(req.user.id, req.params.id))) throw new HttpError(404, "MEMORY_NOT_FOUND", "Memory not found");
    sendSuccess(res, {}, "Forgotten");
  }),
);

memoryRouter.delete(
  "/",
  handle(async (req, res) => {
    const result = await prisma.memoryItem.deleteMany({ where: { userId: req.user.id } });
    await prisma.userPattern.deleteMany({ where: { userId: req.user.id } });
    sendSuccess(res, { deleted: result.count }, "All memories cleared");
  }),
);

export const insightRouter = Router();
insightRouter.use(requireFirebaseUser, requireUser);

insightRouter.get(
  "/",
  handle(async (req, res) => {
    const force = req.query.refresh === "true";
    const patterns = await getPatterns(req.user.id, req.settings.timezone, { force });
    sendSuccess(res, { recommendations: await getRecommendations(req.user, req.settings), patterns });
  }),
);

insightRouter.post(
  "/:id/accept",
  handle(async (req, res) => {
    const message = await acceptRecommendation(req.user, req.settings, req.params.id);
    sendSuccess(res, { message }, message);
  }),
);

insightRouter.post(
  "/:id/dismiss",
  handle(async (req, res) => {
    await dismissRecommendation(req.user, req.settings, req.params.id);
    sendSuccess(res, {}, "Dismissed");
  }),
);
