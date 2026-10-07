// /functions/api/onboarding/run.js
// GET: demo configuration (allow-listed hires and scenarios, agent mode).
// POST: start an onboarding run and stream its events as Server-Sent Events.

import { publicCatalogue } from "../../../config/onboarding/catalogue.js";
import { resolveModel } from "../../../config/onboarding/llm.js";
import { runOnboarding } from "../../../config/onboarding/orchestrator.js";
import { jsonResponse, parseRunRequest, sseResponse } from "../../../config/onboarding/http.js";

export function onRequestGet(context) {
  const llm = Boolean(context.env.GROQ_API_KEY);
  return jsonResponse({
    ...publicCatalogue(),
    mode: llm ? "llm" : "scripted",
    model: llm ? resolveModel(context.env) : null
  });
}

export async function onRequestPost(context) {
  const input = await parseRunRequest(context.request);
  if (input.error) return jsonResponse({ error: input.error }, 400);

  const origin = new URL(context.request.url).origin;
  return sseResponse(
    (emit) => runOnboarding({ ...input, env: context.env, origin, emit }),
    context.waitUntil?.bind(context)
  );
}
