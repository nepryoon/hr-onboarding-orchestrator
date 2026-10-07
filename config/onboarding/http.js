// Request validation and Server-Sent Events helpers for the onboarding Functions.

import { HIRES, SCENARIOS, DECISION_OPTIONS } from "./catalogue.js";

const MAX_BODY_BYTES = 16 * 1024;

export function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" }
  });
}

async function readJsonObject(request) {
  const text = await request.text();
  if (text.length > MAX_BODY_BYTES) return { error: "Request body is too large." };
  try {
    const body = JSON.parse(text);
    if (!body || typeof body !== "object" || Array.isArray(body)) return { error: "Body must be a JSON object." };
    return { body };
  } catch {
    return { error: "Body must be valid JSON." };
  }
}

function onlyKeys(body, keys) {
  return Object.keys(body).every((key) => keys.includes(key));
}

// Visitors can only pick IDs from allow-lists; nothing they type is forwarded anywhere.
export async function parseRunRequest(request) {
  const { body, error } = await readJsonObject(request);
  if (error) return { error };
  if (!onlyKeys(body, ["hireId", "scenarioId"])) return { error: "Only hireId and scenarioId are accepted." };
  if (typeof body.hireId !== "string" || !Object.hasOwn(HIRES, body.hireId)) return { error: "Unknown hireId." };
  if (typeof body.scenarioId !== "string" || !Object.hasOwn(SCENARIOS, body.scenarioId)) return { error: "Unknown scenarioId." };
  return { hireId: body.hireId, scenarioId: body.scenarioId };
}

export async function parseResumeRequest(request) {
  const { body, error } = await readJsonObject(request);
  if (error) return { error };
  if (!onlyKeys(body, ["state", "decision"])) return { error: "Only state and decision are accepted." };
  if (typeof body.decision !== "string" || !Object.hasOwn(DECISION_OPTIONS, body.decision)) return { error: "Unknown decision." };
  return { state: body.state, decision: body.decision };
}

export function sseResponse(run, waitUntil) {
  const { readable, writable } = new TransformStream();
  const writer = writable.getWriter();
  const encoder = new TextEncoder();
  const emit = (event, data) => writer.write(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));

  const task = (async () => {
    try {
      await run(emit);
    } catch {
      await emit("error", { message: "The orchestrator hit an unexpected error." }).catch(() => {});
    } finally {
      await writer.close().catch(() => {});
    }
  })();
  if (typeof waitUntil === "function") waitUntil(task);

  return new Response(readable, {
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-store, no-transform",
      "x-accel-buffering": "no"
    }
  });
}
