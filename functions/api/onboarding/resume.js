// /functions/api/onboarding/resume.js
// POST: continue a run paused for a human decision. The run state travels with the request
// (no server-side storage) and is re-validated by replaying it before anything executes.

import { restoreState, runOnboarding } from "../../../config/onboarding/orchestrator.js";
import { jsonResponse, parseResumeRequest, sseResponse } from "../../../config/onboarding/http.js";

export async function onRequestPost(context) {
  const input = await parseResumeRequest(context.request);
  if (input.error) return jsonResponse({ error: input.error }, 400);

  const restored = await restoreState(input.state);
  if (!restored.ok) return jsonResponse({ error: restored.error }, 400);

  const origin = new URL(context.request.url).origin;
  return sseResponse(
    (emit) => runOnboarding({ env: context.env, origin, emit, resume: restored, decision: input.decision }),
    context.waitUntil?.bind(context)
  );
}
