// Agent loop for the onboarding demo. The LLM (or the scripted planner) proposes the next
// tool call; this module validates it, enforces policy, calls the simulated system over HTTP
// and streams every event to the caller.

import { HIRES, SCENARIOS, DECISION_OPTIONS, MAX_TOOL_CALLS, MANUAL_MINUTES, LAPTOPS, DELAY_DAYS, addDays } from "./catalogue.js";
import { TOOLS, validateToolCall } from "./tools.js";
import { initialFacts, checkPolicy, applyResult, awaitingDecision, remainingSteps, isComplete } from "./policy.js";
import { nextScriptedCall } from "./planner.js";
import { callLlm, parseToolCall, systemPrompt, progressMessage, resolveModel } from "./llm.js";
import { handleSystemRequest, SYSTEMS_PREFIX, SIM_HEADER, stableId } from "./systems.js";

export const STATE_VERSION = 1;
const MAX_ATTEMPTS = 3;
const RETRYABLE = new Set([429, 502, 503, 504]);
const MAX_INVALID_LLM_CALLS = 2;

const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function newCounters() {
  return { toolCalls: 0, apiCalls: 0, retries: 0, blocked: 0, approvals: 0, invalid: 0 };
}

// --- Transport -------------------------------------------------------------------

async function callSystem(spec, run, attempt) {
  const url = `${run.origin}${SYSTEMS_PREFIX}${spec.path}`;
  const init = {
    method: spec.method,
    headers: {
      "content-type": "application/json",
      "x-demo-scenario": run.facts.scenarioId,
      "x-demo-attempt": String(attempt)
    },
    body: spec.body ? JSON.stringify(spec.body) : undefined
  };

  if (run.transport !== "in-process") {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5000);
    try {
      const { fetchImpl } = run.deps;
      const res = await fetchImpl(url, { ...init, signal: controller.signal });
      if (!res.headers.get(SIM_HEADER)) throw new Error(`HTTP ${res.status} did not come from the simulator`);
      run.transport = "http";
      return res;
    } catch (err) {
      run.transport = "in-process";
      await run.emit("transport", {
        transport: "in-process",
        reason: `Self-call over HTTP failed (${String(err?.message || err).slice(0, 120)}); invoking the same handler in-process.`
      });
    } finally {
      clearTimeout(timer);
    }
  }
  return handleSystemRequest(new Request(url, init));
}

async function executeTool(name, args, run) {
  const spec = TOOLS[name].request(args, { hireId: run.facts.hireId });
  const started = Date.now();
  let attempt = 0;
  let res;
  let body;
  while (attempt < MAX_ATTEMPTS) {
    attempt += 1;
    run.counters.apiCalls += 1;
    res = await callSystem(spec, run, attempt);
    body = await res.json().catch(() => ({ error: "invalid_json" }));
    if (!RETRYABLE.has(res.status) || attempt === MAX_ATTEMPTS) break;
    const backoffMs = run.deps.backoffBaseMs * 2 ** (attempt - 1);
    run.counters.retries += 1;
    await run.emit("retry", {
      tool: name, system: TOOLS[name].system, attempt, status: res.status,
      backoffMs, message: body?.detail || "Retryable error"
    });
    await run.emit("system", { system: TOOLS[name].system, status: "retrying", detail: `HTTP ${res.status}, retrying in ${backoffMs} ms` });
    await run.deps.sleep(backoffMs);
  }
  const path = spec.path.split("?")[0];
  return {
    ok: res.status >= 200 && res.status < 300,
    status: res.status,
    body,
    attempts: attempt,
    durationMs: Date.now() - started,
    method: spec.method,
    path: `${SYSTEMS_PREFIX}${spec.path}`,
    displayPath: `${SYSTEMS_PREFIX}${path}`,
    request: spec.body || Object.fromEntries(new URL(`http://x${spec.path}`).searchParams),
    transport: run.transport
  };
}

function systemSnapshot(name, body) {
  switch (name) {
    case "hris_create_employee":
      return { system: "hris", status: "done", detail: `Employee ${body.employeeId} created, starts ${body.startDate}` };
    case "hris_update_start_date":
      return { system: "hris", status: "done", detail: `Start date moved ${body.previousStartDate} → ${body.startDate}` };
    case "it_check_stock":
      return body.available
        ? { system: "it", status: "pending", detail: `${body.model}: ${body.quantity} in stock` }
        : { system: "it", status: "attention", detail: `${body.model}: out of stock until ${body.restockDate}` };
    case "it_create_ticket":
      return { system: "it", status: "done", detail: `Ticket ${body.ticketId} queued (${body.laptopModel})` };
    case "payroll_register":
      return { system: "payroll", status: "done", detail: `${body.payrollId} registered in ${body.currency} from ${body.effectiveFrom}` };
    case "calendar_book_meetings":
      return { system: "calendar", status: "done", detail: `${body.events.length} meetings booked from ${body.events[0].date}` };
    case "messaging_send_welcome":
      return { system: "messaging", status: "done", detail: `Welcome email ${body.messageId} sent` };
    default:
      return null;
  }
}

// --- Resume state (no server-side storage) ----------------------------------------------------

function exportState(run) {
  return {
    v: STATE_VERSION,
    hireId: run.facts.hireId,
    scenarioId: run.facts.scenarioId,
    calls: run.history.map(({ name, args }) => ({ name, args: withoutReason(args) })),
    counters: { ...run.counters }
  };
}

function withoutReason(args) {
  const { reason, ...rest } = args;
  return rest;
}

const isCount = (n) => Number.isInteger(n) && n >= 0 && n <= 100;

// Rebuilds facts by replaying the recorded calls against the deterministic systems and policy.
// A tampered or inconsistent state is rejected, and no free text from it reaches the model.
export async function restoreState(state) {
  const invalid = (reason) => ({ ok: false, error: reason });
  if (!state || typeof state !== "object" || state.v !== STATE_VERSION) return invalid("Unsupported state version.");
  if (!HIRES[state.hireId] || !SCENARIOS[state.scenarioId]) return invalid("Unknown hire or scenario.");
  if (!Array.isArray(state.calls) || state.calls.length > MAX_TOOL_CALLS) return invalid("Invalid call history.");
  const c = state.counters || {};
  const counters = newCounters();
  for (const key of Object.keys(counters)) {
    if (!isCount(c[key])) return invalid(`Invalid counter ${key}.`);
    counters[key] = c[key];
  }
  if (counters.toolCalls < state.calls.length || counters.toolCalls > MAX_TOOL_CALLS) return invalid("Inconsistent tool-call count.");

  const facts = initialFacts(state.hireId, state.scenarioId);
  const history = [];
  for (const call of state.calls) {
    const args = { reason: "Replayed from run state.", ...(call && typeof call.args === "object" ? call.args : {}) };
    if (!call || !validateToolCall(call.name, args).ok) return invalid("Invalid call in history.");
    if (!checkPolicy(call.name, args, facts).ok) return invalid("History violates policy.");
    const spec = TOOLS[call.name].request(args, { hireId: facts.hireId });
    const res = await handleSystemRequest(new Request(`http://replay${SYSTEMS_PREFIX}${spec.path}`, {
      method: spec.method,
      headers: { "content-type": "application/json", "x-demo-scenario": facts.scenarioId, "x-demo-attempt": "99" },
      body: spec.body ? JSON.stringify(spec.body) : undefined
    }));
    if (!res.ok) return invalid("History does not replay.");
    applyResult(call.name, args, await res.json(), facts);
    history.push({ name: call.name, args });
  }
  if (!awaitingDecision(facts)) return invalid("This run is not waiting for a decision.");
  return { ok: true, facts, counters, history };
}

// --- Main loop ---------------------------------------------------------------------------

export async function runOnboarding({ hireId, scenarioId, env = {}, origin, emit, deps = {}, resume = null, decision = null }) {
  const run = {
    origin,
    emit,
    transport: deps.forceInProcess ? "in-process" : "pending",
    deps: {
      // Wrapped so fetch is never invoked as a method: Workers reject that as "Illegal invocation".
      fetchImpl: deps.fetchImpl || ((url, init) => fetch(url, init)),
      llmFetch: deps.llmFetch || ((url, init) => fetch(url, init)),
      sleep: deps.sleep || defaultSleep,
      paceMs: deps.paceMs ?? 450,
      backoffBaseMs: deps.backoffBaseMs ?? 400
    },
    facts: resume ? resume.facts : initialFacts(hireId, scenarioId),
    counters: resume ? resume.counters : newCounters(),
    history: resume ? resume.history : []
  };
  const hire = HIRES[run.facts.hireId];
  const apiKey = typeof env.GROQ_API_KEY === "string" ? env.GROQ_API_KEY.trim() : "";
  const model = resolveModel(env);
  let mode = apiKey ? "llm" : "scripted";

  await emit("run_started", {
    runId: stableId("RUN", run.facts.hireId, run.facts.scenarioId),
    resumed: Boolean(resume),
    hire: { id: hire.id, fullName: hire.fullName, role: hire.role, countryName: hire.countryName, startDate: hire.startDate },
    scenario: SCENARIOS[run.facts.scenarioId],
    mode,
    model: mode === "llm" ? model : null,
    maxToolCalls: MAX_TOOL_CALLS
  });
  if (!apiKey) await emit("fallback", { mode: "scripted", reason: "No LLM key is configured, so the deterministic planner runs the workflow." });

  if (resume && decision) {
    run.facts.decision = decision;
    run.counters.approvals += 1;
    const option = DECISION_OPTIONS[decision];
    await emit("approval", { decision, label: option.label, detail: option.detail });
    if (decision === "delay") {
      await emit("system", { system: "hris", status: "pending", detail: `Approved delay to ${addDays(hire.startDate, DELAY_DAYS)}` });
    }
  }

  const switchToScripted = async (reason) => {
    mode = "scripted";
    await emit("fallback", { mode: "scripted", reason });
  };

  // Each LLM turn sees a fresh, server-built summary of validated facts plus feedback on its
  // previous call, so the prompt does not grow with the run and cost stays bounded.
  let feedback = "";

  while (!isComplete(run.facts)) {
    if (awaitingDecision(run.facts)) {
      const requested = run.facts.stock[hire.laptopModel];
      await emit("awaiting_approval", {
        question: `${hire.laptopModel} is out of stock until ${requested.restockDate}. How should onboarding continue?`,
        options: Object.values(DECISION_OPTIONS).map((option) => ({
          ...option,
          detail: option.id === "alternative"
            ? `Provision ${LAPTOPS[hire.laptopModel].alternative} now; start date stays ${hire.startDate}.`
            : `Keep ${hire.laptopModel}; move the start date to ${addDays(hire.startDate, DELAY_DAYS)}.`
        })),
        state: exportState(run),
        counters: { ...run.counters }
      });
      return { status: "awaiting_approval" };
    }

    if (run.counters.toolCalls >= MAX_TOOL_CALLS) {
      await emit("halted", { reason: `The ${MAX_TOOL_CALLS}-call budget is exhausted; a human takes over from here.`, counters: { ...run.counters } });
      return { status: "halted" };
    }

    // Keep enough budget for the deterministic planner to finish whatever the model left undone.
    if (mode === "llm" && MAX_TOOL_CALLS - run.counters.toolCalls <= remainingSteps(run.facts).length) {
      await switchToScripted("The model used its spare tool-call budget; the scripted planner finishes within the limit.");
    }

    let proposal;
    if (mode === "llm") {
      const messages = [
        { role: "system", content: systemPrompt(run.facts) },
        { role: "user", content: `${progressMessage(run.facts)}${feedback}` }
      ];
      const reply = await callLlm({ apiKey, model, messages, fetchImpl: run.deps.llmFetch, sleep: run.deps.sleep });
      if (!reply.ok) {
        await switchToScripted(`LLM provider error (${reply.error}); switching to the scripted planner.`);
        continue;
      }
      const parsed = parseToolCall(reply.message);
      const validation = parsed.ok ? validateToolCall(parsed.name, parsed.args) : { ok: false, errors: [parsed.error] };
      if (!validation.ok) {
        run.counters.invalid += 1;
        run.counters.toolCalls += parsed.name ? 1 : 0;
        await emit("invalid_call", {
          tool: parsed.name ? String(parsed.name).slice(0, 60) : null,
          errors: validation.errors.slice(0, 4),
          count: run.counters.invalid
        });
        if (run.counters.invalid >= MAX_INVALID_LLM_CALLS) {
          await switchToScripted("The model produced two invalid tool calls; switching to the scripted planner.");
          continue;
        }
        feedback = `\nYour previous reply was rejected by schema validation: ${validation.errors.slice(0, 4).join("; ")}. Respond with exactly one valid tool call.`;
        continue;
      }
      proposal = { name: parsed.name, args: parsed.args };
    } else {
      proposal = nextScriptedCall(run.facts);
    }

    const { name, args } = proposal;
    const step = run.counters.toolCalls + 1;
    run.counters.toolCalls = step;
    const toolResult = (outcome) => {
      feedback = `\nResult of your previous call ${name}: ${JSON.stringify(outcome).slice(0, 600)}`;
    };

    const policy = checkPolicy(name, args, run.facts);
    if (!policy.ok) {
      run.counters.blocked += 1;
      await emit("step", {
        step, tool: name, system: TOOLS[name].system, reason: args.reason, planner: mode,
        outcome: "blocked", violation: policy.violation, request: withoutReason(args), counters: { ...run.counters }
      });
      toolResult({ error: "blocked_by_policy", detail: policy.violation });
      continue;
    }

    await emit("system", { system: TOOLS[name].system, status: "working", detail: `${name.replace(/_/g, " ")}…` });
    const result = await executeTool(name, args, run);
    await emit("step", {
      step, tool: name, system: TOOLS[name].system, reason: args.reason, planner: mode,
      outcome: result.ok ? "ok" : "error",
      method: result.method, path: result.displayPath, request: result.request,
      status: result.status, durationMs: result.durationMs, attempts: result.attempts,
      retries: result.attempts - 1, transport: result.transport, response: result.body,
      counters: { ...run.counters }
    });

    if (!result.ok) {
      toolResult({ error: `HTTP ${result.status}`, detail: result.body });
      await emit("system", { system: TOOLS[name].system, status: "error", detail: `HTTP ${result.status}` });
      if (RETRYABLE.has(result.status) || mode === "scripted") {
        await emit("halted", { reason: `${TOOLS[name].system.toUpperCase()} is still failing after ${result.attempts} attempts; escalated to a human.`, counters: { ...run.counters } });
        return { status: "halted" };
      }
      continue;
    }

    applyResult(name, args, result.body, run.facts);
    run.history.push({ name, args });
    if (name === "messaging_send_welcome") run.welcomeMessage = args.message;
    toolResult(result.body);
    const snapshot = systemSnapshot(name, result.body);
    if (snapshot) await emit("system", snapshot);
    if (mode === "scripted" && run.deps.paceMs) await run.deps.sleep(run.deps.paceMs);
  }

  const touched = [...new Set(run.history.map(({ name }) => TOOLS[name].system))];
  const minutes = run.history.map(({ name }) => ({ step: name, ...MANUAL_MINUTES[name] }));
  await emit("completed", {
    mode,
    transport: run.transport,
    systemsTouched: touched,
    counters: { ...run.counters },
    welcomeMessage: run.welcomeMessage,
    estimate: {
      label: "Illustrative estimate",
      minutesAvoided: minutes.reduce((sum, item) => sum + item.minutes, 0),
      assumptions: minutes
    }
  });
  return { status: "completed" };
}
