/**
 * FR-RN-004 check-in message templates — the deterministic fallback when the LLM is unavailable or
 * its output fails validation. One file so a team member can review every line.
 *
 * Slots: {task} (title, shortened if long), {duration}, {firstStep}, {deadline}.
 * Rules (FR-RN-004 §5): body ≤ 120 characters after filling slots; humour is about the task, never
 * the user; no guilt, shaming or comparisons; Gentle never jokes and offers to split the task.
 * Templates without {firstStep} are used when no first step is known (or research mode omits it).
 */

export type CopyKind = "START" | "START_FOLLOWUP" | "COMPLETION" | "COMPLETION_UNCONFIRMED";
export type Tone = "FUNNY" | "SERIOUS" | "GENTLE";
export type Lang = "en" | "ur";

type Library = Record<Lang, Record<Tone, Record<CopyKind, string[]>>>;

export const TEMPLATES: Library = {
  en: {
    FUNNY: {
      START: [
        "{task} is warming up on the bench. First move: {firstStep}. Started?",
        "Plot twist: {task} starts now. Opening scene: {firstStep}. Rolling?",
        "{task} has been waiting politely. Ready to say hi to it?",
        "Your {duration} date with {task} just began. Showing up?",
      ],
      START_FOLLOWUP: [
        "{task} is still tapping its watch. Tiny start: {firstStep}?",
        "{task} rehearsed its lines twice. First bit: {firstStep}. Shall we?",
        "Knock knock, it's {task}. Even 5 minutes counts. Started?",
        "{task} is still on the runway. Ready for take-off?",
      ],
      COMPLETION: [
        "{duration} later, how's {task} doing? Done and dusted?",
        "The timer says {task} should be wrapping up. Victory lap?",
        "{task}: finished, or does it want an encore?",
        "Checking in on {task}. Is it officially done?",
      ],
      COMPLETION_UNCONFIRMED: [
        "How did it go with {task}? No pressure, just curious.",
        "{task} wonders how its day went. Done, partly, or not yet?",
        "Quick status on {task}? Any answer is a good answer.",
        "So… {task}. Done, halfway, or saved for later?",
      ],
    },
    SERIOUS: {
      START: [
        "Time to start {task}. First step: {firstStep}.",
        "Starting {task}? Begin with: {firstStep}.",
        "{task} is scheduled now ({duration}). Have you started?",
        "Your time block for {task} has begun. Ready?",
      ],
      START_FOLLOWUP: [
        "Still time for {task}. First step: {firstStep}.",
        "Have you started {task}? Begin with {firstStep}.",
        "{task} was planned to start 30 minutes ago. Started?",
        "{task} is waiting. Start now or plan another time?",
      ],
      COMPLETION: [
        "The expected time for {task} is up. Is it done?",
        "Is {task} complete?",
        "The {duration} planned for {task} has passed. Done?",
        "Status check: is {task} finished?",
      ],
      COMPLETION_UNCONFIRMED: [
        "How did {task} go? Done, partly done, or not started?",
        "Any update on {task}?",
        "The planned time for {task} has ended. What's the status?",
        "Did you get to {task}?",
      ],
    },
    GENTLE: {
      START: [
        "When you're ready, start {task} small: {firstStep}. Want to split it up?",
        "No rush. A gentle start on {task}: {firstStep}. Smaller steps help.",
        "{task} is up next. We can break it into smaller pieces if that helps.",
        "Whenever you feel ready, try a few minutes of {task}. Want to split it?",
      ],
      START_FOLLOWUP: [
        "Just checking in about {task}. One small step is enough: {firstStep}.",
        "{task} can wait a little. A tiny first step: {firstStep}?",
        "Still okay to start {task}? We can split it into smaller parts.",
        "Go easy. Would splitting {task} into smaller steps help?",
      ],
      COMPLETION: [
        "How are you doing with {task}? Any progress counts.",
        "Checking in gently: how far did {task} get?",
        "However {task} went, that's okay. Done, partly, or later?",
        "Time's up for {task}. Want to tell me how it went?",
      ],
      COMPLETION_UNCONFIRMED: [
        "How did today go with {task}? Whatever happened is okay.",
        "No pressure. Did you get a chance to work on {task}?",
        "Just checking in on {task}. We can plan it again if needed.",
        "How's {task} looking? Partly done is still progress.",
      ],
    },
  },
  ur: {
    FUNNY: {
      START: [
        "{task} انتظار میں بیٹھا ہے۔ پہلا قدم: {firstStep}۔ شروع کیا؟",
        "{task} کا وقت آ گیا! آغاز یوں کریں: {firstStep}۔ چلیں؟",
        "{task} کب سے آپ کی راہ دیکھ رہا ہے۔ سلام کر لیں؟",
        "{task} کے ساتھ آپ کی {duration} کی ملاقات شروع ہو گئی۔ آ رہے ہیں؟",
      ],
      START_FOLLOWUP: [
        "{task} اب بھی گھڑی دیکھ رہا ہے۔ چھوٹا سا آغاز: {firstStep}؟",
        "{task} نے اپنی تیاری دو بار کر لی۔ پہلا حصہ: {firstStep}۔ شروع کریں؟",
        "دستک دستک، {task} حاضر ہے۔ پانچ منٹ بھی کافی ہیں۔ شروع کیا؟",
        "{task} ابھی رن وے پر ہے۔ اڑان بھریں؟",
      ],
      COMPLETION: [
        "{duration} بعد، {task} کیسا رہا؟ مکمل؟",
        "ٹائمر کہہ رہا ہے {task} ختم ہونے والا ہے۔ جیت کا جشن؟",
        "{task}: مکمل ہو گیا یا ابھی تھوڑا اور؟",
        "{task} کا حال پوچھنے آیا ہوں۔ کام ختم؟",
      ],
      COMPLETION_UNCONFIRMED: [
        "{task} کیسا رہا؟ کوئی دباؤ نہیں، بس پوچھ رہا ہوں۔",
        "{task} سوچ رہا ہے اس کا دن کیسا گزرا۔ مکمل، آدھا یا ابھی نہیں؟",
        "{task} کی تازہ صورتحال؟ ہر جواب ٹھیک ہے۔",
        "تو… {task}؟ مکمل، آدھا یا بعد کے لیے؟",
      ],
    },
    SERIOUS: {
      START: [
        "{task} شروع کرنے کا وقت ہے۔ پہلا قدم: {firstStep}۔",
        "{task} شروع کر رہے ہیں؟ آغاز کریں: {firstStep}۔",
        "{task} کا وقت ابھی ہے ({duration})۔ کیا آپ نے شروع کیا؟",
        "{task} کا وقت شروع ہو چکا ہے۔ تیار ہیں؟",
      ],
      START_FOLLOWUP: [
        "{task} کے لیے ابھی وقت ہے۔ پہلا قدم: {firstStep}۔",
        "کیا {task} شروع ہوا؟ آغاز کریں: {firstStep}۔",
        "{task} آدھا گھنٹہ پہلے شروع ہونا تھا۔ شروع کیا؟",
        "{task} انتظار میں ہے۔ ابھی شروع کریں یا کوئی اور وقت رکھیں؟",
      ],
      COMPLETION: [
        "{task} کا متوقع وقت ختم ہو گیا۔ کیا یہ مکمل ہے؟",
        "کیا {task} مکمل ہو گیا؟",
        "{task} کے لیے رکھا گیا {duration} گزر گیا۔ مکمل؟",
        "صورتحال: کیا {task} ختم ہو گیا؟",
      ],
      COMPLETION_UNCONFIRMED: [
        "{task} کیسا رہا؟ مکمل، کچھ حصہ، یا شروع نہیں ہوا؟",
        "{task} کی کیا صورتحال ہے؟",
        "{task} کا طے شدہ وقت ختم ہو گیا۔ کیا صورتحال ہے؟",
        "کیا آپ {task} پر کام کر سکے؟",
      ],
    },
    GENTLE: {
      START: [
        "جب آپ تیار ہوں، {task} چھوٹے قدم سے شروع کریں: {firstStep}۔ حصوں میں بانٹ دیں؟",
        "کوئی جلدی نہیں۔ {task} کا نرم آغاز: {firstStep}۔ چھوٹے قدم مدد کرتے ہیں۔",
        "{task} اگلا ہے۔ اگر مدد ملے تو ہم اسے چھوٹے حصوں میں بانٹ سکتے ہیں۔",
        "جب دل چاہے، {task} پر چند منٹ لگائیں۔ اسے حصوں میں بانٹ دیں؟",
      ],
      START_FOLLOWUP: [
        "بس {task} کا حال پوچھ رہا ہوں۔ ایک چھوٹا قدم بھی کافی ہے: {firstStep}۔",
        "{task} تھوڑا انتظار کر سکتا ہے۔ ایک ننھا سا پہلا قدم: {firstStep}؟",
        "{task} ابھی شروع کرنا ٹھیک ہے؟ ہم اسے چھوٹے حصوں میں بانٹ سکتے ہیں۔",
        "آرام سے۔ کیا {task} کو چھوٹے حصوں میں بانٹنا بہتر رہے گا؟",
      ],
      COMPLETION: [
        "{task} کیسا جا رہا ہے؟ ہر پیش رفت اہم ہے۔",
        "نرمی سے پوچھ رہا ہوں: {task} کہاں تک پہنچا؟",
        "{task} جیسا بھی رہا، ٹھیک ہے۔ مکمل، آدھا یا بعد میں؟",
        "{task} کا وقت ختم ہوا۔ بتانا چاہیں گے کیسا رہا؟",
      ],
      COMPLETION_UNCONFIRMED: [
        "آج {task} کیسا رہا؟ جو بھی ہوا، ٹھیک ہے۔",
        "کوئی دباؤ نہیں۔ کیا {task} پر کام کا موقع ملا؟",
        "بس {task} کا حال پوچھ رہا ہوں۔ ضرورت ہو تو دوبارہ پلان کر لیں گے۔",
        "{task} کی کیا صورتحال ہے؟ آدھا کام بھی پیش رفت ہے۔",
      ],
    },
  },
};

/** Replies after a check-in response (FR-RN-004 §5): brief praise on done, neutral otherwise. */
export const ACK_TEMPLATES: Record<Lang, { DONE: string[]; DIDNT: string[]; DEADLINE_WARNING: string[] }> = {
  en: {
    DONE: ["Nice work — {task} is done.", "{task}: done. Well played.", "Done and dusted: {task}."],
    DIDNT: ["No problem. Let's find a better time for {task}.", "Okay. {task} can move to another time.", "Noted. Want to plan {task} for later?"],
    DEADLINE_WARNING: ["That would take you past {deadline}. Plan the rest?"],
  },
  ur: {
    DONE: ["شاباش — {task} مکمل ہو گیا۔", "{task} مکمل۔ بہت خوب۔", "{task} ہو گیا۔ زبردست۔"],
    DIDNT: ["کوئی بات نہیں۔ {task} کے لیے بہتر وقت ڈھونڈتے ہیں۔", "ٹھیک ہے۔ {task} کسی اور وقت رکھ لیتے ہیں۔", "نوٹ کر لیا۔ {task} بعد میں پلان کریں؟"],
    DEADLINE_WARNING: ["اس سے آپ {deadline} سے آگے نکل جائیں گے۔ باقی کام پلان کر لیں؟"],
  },
};
