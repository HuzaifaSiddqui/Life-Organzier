# Known limitations

Gaps and platform restrictions in the current release. Feature status: [AI_ASSISTANT_ARCHITECTURE.md](AI_ASSISTANT_ARCHITECTURE.md).

## Safety

- Crisis detection is a deterministic phrase list (English, Roman Urdu, Urdu script) in
  `backend/src/modules/mood/crisis.ts`. It must be reviewed by a native Urdu speaker before release, and the
  helpline numbers in `CRISIS_RESOURCES` must be verified (`// VERIFY BEFORE RELEASE`). A mental-health helpline
  is intentionally left as a placeholder (not shown) until someone verifies one.
