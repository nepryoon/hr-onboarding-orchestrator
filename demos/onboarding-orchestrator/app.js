// Client for the HR Onboarding Orchestrator demo. Plain ES module, no dependencies.
// All values from the server are rendered with textContent, never as HTML.

const API = "/api/onboarding";
const $ = (id) => document.getElementById(id);

const SYSTEM_LABELS = { hris: "HRIS", it: "IT service desk", payroll: "Payroll", calendar: "Calendar", messaging: "Messaging" };
const STATE_LABELS = { idle: "idle", working: "working", pending: "in progress", retrying: "retrying", attention: "needs decision", error: "error", done: "done" };

let config = null;
let running = false;

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function setMode(mode, model) {
  const badge = $("modeBadge");
  badge.className = `mode-badge ${mode}`;
  badge.textContent = mode === "llm"
    ? `Mode: LLM agent${model ? ` (${model})` : ""}`
    : "Mode: Scripted fallback";
}

function choice(name, value, title, lines, checked) {
  const label = el("label", "choice");
  const input = el("input");
  input.type = "radio";
  input.name = name;
  input.value = value;
  input.checked = checked;
  const face = el("span", "face");
  face.append(el("b", "", title));
  lines.forEach((line) => face.append(el("span", "", line)));
  label.append(input, face);
  return label;
}

async function loadConfig() {
  try {
    const res = await fetch(`${API}/run`, { cache: "no-store" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    config = await res.json();
  } catch {
    $("hireChoices").replaceChildren(el("p", "small", "The demo API is unavailable right now. Please try again shortly."));
    $("modeBadge").textContent = "Mode: unavailable";
    return;
  }
  setMode(config.mode, config.model);
  $("cMax").textContent = String(config.maxToolCalls);
  $("hireChoices").replaceChildren(...config.hires.map((hire, i) =>
    choice("hire", hire.id, hire.fullName, [`${hire.role} · ${hire.countryName}`, `Starts ${hire.startDate} · ${hire.laptopModel}`], i === 0)));
  $("scenarioChoices").replaceChildren(...config.scenarios.map((scenario, i) =>
    choice("scenario", scenario.id, scenario.label, [scenario.description], i === 0)));
  $("runButton").disabled = false;
}

// --- Rendering ---------------------------------------------------------------------

function resetView() {
  $("timeline").replaceChildren();
  $("summary").hidden = true;
  document.querySelectorAll(".sys").forEach((node) => {
    node.dataset.status = "idle";
    node.querySelector(".sys-state").textContent = STATE_LABELS.idle;
  });
  updateCounters({ toolCalls: 0, apiCalls: 0, retries: 0, blocked: 0 });
}

function addEntry(kind, head, body) {
  const item = el("li", `tl ${kind}`);
  const header = el("div", "tl-head");
  head.forEach((part) => header.append(part));
  item.append(header);
  body.forEach((part) => part && item.append(part));
  $("timeline").append(item);
  item.scrollIntoView({ block: "nearest", behavior: "smooth" });
  return item;
}

function jsonDetails(label, value) {
  if (value === undefined || value === null) return null;
  const details = el("details");
  details.append(el("summary", "", label), el("pre", "", JSON.stringify(value, null, 2)));
  return details;
}

function updateCounters(c) {
  if (!c) return;
  $("cTool").textContent = String(c.toolCalls ?? 0);
  $("cApi").textContent = String(c.apiCalls ?? 0);
  $("cRetry").textContent = String(c.retries ?? 0);
  $("cBlocked").textContent = String(c.blocked ?? 0);
}

function updateSystem({ system, status, detail }) {
  const node = document.querySelector(`.sys[data-system="${system}"]`);
  if (!node) return;
  node.dataset.status = status;
  node.querySelector(".sys-state").textContent = STATE_LABELS[status] || status;
  if (detail) node.querySelector(".sys-detail").textContent = detail;
}

function renderStep(d) {
  const statusPill = d.outcome === "blocked"
    ? el("span", "pill bad", "blocked by policy")
    : el("span", `pill ${d.outcome === "ok" ? "ok" : "bad"}`, `HTTP ${d.status}`);
  const head = [
    el("span", "tl-n", `#${d.step}`),
    el("span", "tl-tool", d.tool),
    el("span", "pill", SYSTEM_LABELS[d.system] || d.system),
    statusPill
  ];
  if (d.retries) head.push(el("span", "pill warn", `${d.retries} ${d.retries === 1 ? "retry" : "retries"}`));
  const reason = el("p", "tl-reason");
  reason.append(el("em", "", d.planner === "llm" ? "Agent: " : "Planner: "), document.createTextNode(d.reason || ""));
  const meta = d.outcome === "blocked"
    ? el("div", "tl-meta", `Not executed: ${d.violation}`)
    : el("div", "tl-meta", `${d.method} ${d.path} · ${d.status} · ${d.durationMs} ms · attempts ${d.attempts} · transport ${d.transport}`);
  addEntry(d.outcome === "ok" ? "" : "blocked", head, [reason, meta, jsonDetails("Request payload", d.request), jsonDetails("Response", d.response)]);
  updateCounters(d.counters);
}

function renderApproval(d) {
  const item = addEntry("approval", [el("span", "pill warn", "Awaiting human approval")], [el("p", "tl-reason", d.question)]);
  const actions = el("div", "approval-actions");
  d.options.forEach((option) => {
    const button = el("button", "btn");
    button.type = "button";
    button.append(el("span", "", option.label), el("small", "", option.detail));
    button.addEventListener("click", () => {
      actions.querySelectorAll("button").forEach((b) => { b.disabled = true; });
      button.classList.add("primary");
      stream(`${API}/resume`, { state: d.state, decision: option.id });
    });
    actions.append(button);
  });
  item.append(actions);
  updateCounters(d.counters);
  actions.querySelector("button").focus({ preventScroll: true });
}

function renderSummary(d) {
  $("summary").hidden = false;
  $("sSystems").textContent = String(d.systemsTouched.length);
  $("sApi").textContent = String(d.counters.apiCalls);
  $("sRetries").textContent = String(d.counters.retries);
  $("sApprovals").textContent = String(d.counters.approvals);
  $("sBlocked").textContent = String(d.counters.blocked);
  $("sMode").textContent = `Finished by: ${d.mode === "llm" ? "LLM agent" : "scripted fallback planner"} · transport: ${d.transport} · tool calls: ${d.counters.toolCalls}`;
  $("welcomeMessage").textContent = d.welcomeMessage || "";
  $("sMinutes").textContent = String(d.estimate.minutesAvoided);
  $("sAssumptions").replaceChildren(...d.estimate.assumptions.map((row) => {
    const tr = el("tr");
    tr.append(el("td", "", row.assumption), el("td", "", `${row.minutes} min`));
    return tr;
  }));
  updateCounters(d.counters);
}

const handlers = {
  run_started(d) {
    setMode(d.mode, d.model);
    addEntry("", [el("span", "pill", d.resumed ? "Run resumed" : "Run started")], [
      el("p", "tl-reason", `${d.hire.fullName}, ${d.hire.role} (${d.hire.countryName}), starting ${d.hire.startDate}. Scenario: ${d.scenario.label}.`),
      el("div", "tl-meta", `${d.runId} · budget ${d.maxToolCalls} tool calls`)
    ]);
  },
  fallback(d) {
    setMode("scripted");
    addEntry("fallback", [el("span", "pill warn", "Switched to scripted fallback")], [el("p", "tl-reason", d.reason)]);
  },
  transport(d) {
    addEntry("transport", [el("span", "pill warn", `Transport: ${d.transport}`)], [el("p", "tl-reason", d.reason)]);
  },
  retry(d) {
    addEntry("retry", [el("span", "pill warn", `HTTP ${d.status}`), el("span", "tl-tool", d.tool)], [
      el("p", "tl-reason", `${SYSTEM_LABELS[d.system]} answered “${d.message}”. Retrying in ${d.backoffMs} ms (attempt ${d.attempt + 1} of 3).`)
    ]);
  },
  invalid_call(d) {
    addEntry("invalid", [el("span", "pill bad", "Invalid tool call rejected"), el("span", "tl-tool", d.tool || "no tool")], [
      el("div", "tl-meta", d.errors.join("; "))
    ]);
  },
  approval(d) {
    addEntry("approval", [el("span", "pill ok", "Human decision recorded")], [el("p", "tl-reason", `${d.label}. ${d.detail}`)]);
  },
  step: renderStep,
  system: updateSystem,
  awaiting_approval: renderApproval,
  halted(d) {
    addEntry("halted", [el("span", "pill bad", "Run halted")], [el("p", "tl-reason", d.reason)]);
    updateCounters(d.counters);
  },
  completed(d) {
    addEntry("done", [el("span", "pill ok", "Onboarding complete")], [el("p", "tl-reason", `${d.systemsTouched.length} systems updated with ${d.counters.apiCalls} API calls.`)]);
    renderSummary(d);
  },
  error(d) {
    addEntry("halted", [el("span", "pill bad", "Error")], [el("p", "tl-reason", d.message)]);
  }
};

// --- Streaming (fetch + manual SSE parsing, because EventSource cannot POST) -----------

async function stream(url, payload) {
  running = true;
  $("runButton").disabled = true;
  $("runStatus").textContent = "Running…";
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "text/event-stream" },
      body: JSON.stringify(payload)
    });
    if (!res.ok || !res.body) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.error || `HTTP ${res.status}`);
    }
    const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
    let buffer = "";
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += value;
      let cut;
      while ((cut = buffer.indexOf("\n\n")) !== -1) {
        const block = buffer.slice(0, cut);
        buffer = buffer.slice(cut + 2);
        let event = "message";
        let data = "";
        for (const line of block.split("\n")) {
          if (line.startsWith("event: ")) event = line.slice(7);
          else if (line.startsWith("data: ")) data += line.slice(6);
        }
        if (handlers[event] && data) handlers[event](JSON.parse(data));
      }
    }
    $("runStatus").textContent = "";
  } catch (err) {
    handlers.error({ message: `The run could not be streamed (${err.message}).` });
    $("runStatus").textContent = "";
  } finally {
    running = false;
    $("runButton").disabled = false;
  }
}

$("runForm").addEventListener("submit", (event) => {
  event.preventDefault();
  if (running || !config) return;
  const form = new FormData(event.target);
  resetView();
  setMode(config.mode, config.model);
  stream(`${API}/run`, { hireId: form.get("hire"), scenarioId: form.get("scenario") });
});

loadConfig();
