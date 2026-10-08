import { Router } from "express";
import { z } from "zod";
import { handle, parseBody, requireUser } from "../../lib/http.js";
import { localParts } from "../../lib/time.js";
import { requireFirebaseUser } from "../../middleware/authMiddleware.js";
import { sendSuccess } from "../../utils/apiResponse.js";
import { buildAssistantContext } from "../memory/contextBuilder.js";
import { getOrCreateConversation } from "../conversations/conversationService.js";
import { listActiveTasks } from "../tasks/taskService.js";
import { crisisForText, detectMood, logMood, moodHistory, MOODS, recommendForMood, type Mood } from "./moodService.js";

export const moodRouter = Router();
moodRouter.use(requireFirebaseUser, requireUser);

moodRouter.get(
  "/",
  handle(async (req, res) => {
    const days = Math.min(365, Math.max(1, Number(req.query.days ?? 30)));
    const logs = await moodHistory(req.user.id, days);
    const tz = req.settings.timezone;
    const byWeekday = Array.from({ length: 7 }, () => ({ total: 0, scoreSum: 0 }));
    for (const l of logs) {
      const d = byWeekday[localParts(l.createdAt, tz).weekday];
      d.total += 1;
      d.scoreSum += l.score ?? 5;
    }
    sendSuccess(res, {
      logs,
      byWeekday: byWeekday.map((d, weekday) => ({ weekday, count: d.total, avgScore: d.total ? Math.round((d.scoreSum / d.total) * 10) / 10 : null })),
    });
  }),
);

/** Manual / check-in mood log (emoji scale 1–10) with immediate recommendations. */
moodRouter.post(
  "/",
  handle(async (req, res) => {
    const body = parseBody(
      z.object({
        mood: z.enum(MOODS),
        score: z.number().int().min(1).max(10).optional(),
        note: z.string().max(500).optional(),
        source: z.enum(["MANUAL", "CHECKIN"]).default("MANUAL"),
      }),
      req.body,
    );
    const log = await logMood(req.user.id, req.settings.timezone, { mood: body.mood, score: body.score ?? null, note: body.note ?? null, source: body.source, confidence: 100 });
    const conversation = await getOrCreateConversation(req.user.id, "APP");
    const [tasks, context] = await Promise.all([
      listActiveTasks(req.user.id),
      buildAssistantContext({ user: req.user, settings: req.settings, conversation, query: `feeling ${body.mood} ${body.note ?? ""}` }),
    ]);
    // A note can carry a crisis disclosure even on a "calm" check-in — same deterministic check as chat.
    const crisis = crisisForText(body.note, req.settings.language);
    sendSuccess(res, { log, recommendation: recommendForMood(body.mood as Mood, tasks, context.copingMemories), crisis }, "Mood logged", 201);
  }),
);

/** Sentiment check for free text (used by voice/chat previews). */
moodRouter.post(
  "/detect",
  handle(async (req, res) => {
    const { text } = parseBody(z.object({ text: z.string().max(2000) }), req.body);
    sendSuccess(res, { detection: detectMood(text) });
  }),
);
