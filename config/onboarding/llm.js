// LLM client for the onboarding agent. Same provider and key as the other site Functions (Groq).
// Only server-side, allow-listed data is placed in the prompt: no visitor text ever reaches it.

import { HIRES, COMPANY, MAX_TOOL_CALLS, DELAY_DAYS, addDays } from "./catalogue.js";
import { toolDefinitionsForLlm } from "./tools.js";

export const GROQ_URL = "https://api.groq.com/openai/v1/chat/completions";
export const DEFAULT_MODEL = "openai/gpt-oss-120b";
const MODEL_PATTERN = /^[A-Za-z0-9._/:-]{1,80}$/;

export function resolveModel(env = {}) {
  const override = typeof env.ONBOARDING_LLM_MODEL === "string" ? env.ONBOARDING_LLM_MODEL.trim() : "";
  return MODEL_PATTERN.test(override) ? override : DEFAULT_MODEL;
}

export function systemPrompt(facts) {
  const hire = HIRES[facts.hireId];
  return [
    `You are an HR onboarding agent for ${COMPANY}. You onboard one new hire by calling tools, one tool per turn.`,
    "Goal: HRIS record, laptop stock check, IT provisioning ticket, payroll registration, first-week meetings, then a welcome message.",
    "Rules enforced by the platform (violations are rejected):",
    "- The HRIS record comes first; use the employee ID it returns in every later call.",
    "- Check stock for the requested laptop before raising the IT ticket.",
    "- If a human approved a delay, update the HRIS start date first and use the new date everywhere.",
    "- Only request the access groups listed for the role.",
    "- The welcome message is last: warm, specific, British English, under 120 words, signed by the People team.",
    `- At most ${MAX_TOOL_CALLS} tool calls per run. Always include a one-sentence reason.`,
    "New hire profile (synthetic):",
    JSON.stringify({
      hire_id: hire.id,
      name: hire.fullName,
      first_name: hire.firstName,
      role: hire.role,
      department: hire.department,
      manager: hire.manager,
      country: hire.country,
      start_date: hire.startDate,
      requested_laptop: hire.laptopModel,
      approved_access_groups: hire.accessGroups
    })
  ].join("\n");
}

// Structured progress summary, rebuilt server-side from validated facts (also used on resume).
export function progressMessage(facts) {
  const hire = HIRES[facts.hireId];
  const progress = {
    employee_id: facts.employeeId,
    current_start_date: facts.startDate,
    stock_checks: facts.stock,
    human_decision: facts.decision,
    completed_steps: facts.done
  };
  const lines = [`Progress so far: ${JSON.stringify(progress)}`];
  if (facts.decision === "delay") {
    lines.push(`A human approved waiting for stock. New start date: ${addDays(hire.startDate, DELAY_DAYS)}. Keep ${hire.laptopModel}.`);
  } else if (facts.decision === "alternative") {
    lines.push("A human approved the in-stock alternative laptop. The start date is unchanged.");
  }
  lines.push("Call the next tool.");
  return lines.join("\n");
}

// One short retry on rate limiting or provider errors, then the caller falls back to the scripted planner.
export async function callLlm({ sleep = (ms) => new Promise((r) => setTimeout(r, ms)), ...options }) {
  const first = await callLlmOnce(options);
  if (first.ok || !first.retryable) return first;
  await sleep(1200);
  return callLlmOnce(options);
}

async function callLlmOnce({ apiKey, model, messages, fetchImpl = fetch, timeoutMs = 15000 }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchImpl(GROQ_URL, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model,
        messages,
        tools: toolDefinitionsForLlm(),
        tool_choice: "required",
        parallel_tool_calls: false,
        temperature: 0.2,
        max_tokens: 600,
        ...(model.startsWith("openai/gpt-oss") ? { reasoning_effort: "low" } : {})
      }),
      signal: controller.signal
    });
    if (!res.ok) {
      return { ok: false, retryable: res.status === 429 || res.status >= 500, error: `provider returned HTTP ${res.status}` };
    }
    const data = await res.json();
    const message = data?.choices?.[0]?.message;
    if (!message) return { ok: false, error: "provider returned no message" };
    return { ok: true, message };
  } catch (err) {
    return { ok: false, retryable: false, error: err?.name === "AbortError" ? "provider timed out" : "provider unreachable" };
  } finally {
    clearTimeout(timer);
  }
}

export function parseToolCall(message) {
  const call = Array.isArray(message.tool_calls) ? message.tool_calls[0] : null;
  if (!call || call.type !== "function" || !call.function?.name) {
    return { ok: false, error: "The model did not return a tool call." };
  }
  let args;
  try {
    args = typeof call.function.arguments === "string"
      ? JSON.parse(call.function.arguments || "{}")
      : call.function.arguments;
  } catch {
    return { ok: false, error: "Tool arguments were not valid JSON.", id: call.id, name: call.function.name };
  }
  return { ok: true, id: call.id || "call_0", name: call.function.name, args };
}
