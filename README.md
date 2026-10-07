# HR Onboarding Orchestrator

**Live demo:** https://www.neuromorphicinference.com/demos/onboarding-orchestrator/

An agentic workflow that onboards a new hire across five systems through their APIs (HRIS, IT
service desk, Payroll, Calendar and Messaging). An LLM chooses each next step through tool
calling; the platform validates every call, enforces the workflow's dependency graph in code,
retries transient failures with backoff, and stops for a human whenever an exception needs a decision.

> Synthetic data only. Simulated systems. A human approves every exception.

## What the demo shows

| Scenario | What happens |
| --- | --- |
| Happy path | HRIS record → stock check → IT ticket → payroll → first-week meetings → welcome message. |
| Transient API failure | The IT provisioning API returns HTTP 503 on the first call; the orchestrator retries with exponential backoff and succeeds. |
| Needs human decision | The requested laptop is out of stock. The run stops with an `awaiting_approval` event; the visitor chooses the in-stock alternative or a one-week delay, and the run resumes. |

The page streams a live timeline (agent's reason, tool, method and path, payload, status, duration,
retries, transport), a panel showing each simulated system's state, and a final summary with an
illustrative estimate of manual minutes avoided, with its assumptions shown.

## Architecture

```
Browser ──POST /api/onboarding/run──▶ Orchestrator (Pages Function, SSE stream)
   ▲                                     │  1. LLM (OpenAI-compatible API, tool calling) proposes the next tool
   │  SSE events                         │     └─ or the scripted planner, on fallback
   │                                     │  2. Schema validation + policy (dependency graph, budget)
   └─────────────────────────────────────│  3. HTTP call ──▶ /api/onboarding/systems/{hris,it,payroll,calendar,messaging}
                                         │     └─ in-process handler if the self-call over HTTP fails
                                         └  4. Stream the event; pause on exceptions
Browser ──POST /api/onboarding/resume (state + decision)──▶ replay & re-validate state, then continue
```

- **Guardrails in code, not in the prompt** (`config/onboarding/policy.js`): no IT ticket, payroll or
  calendar booking before the HRIS record exists; no ticket before the stock check; nothing proceeds
  while a shortage awaits a human; a delay must update the HRIS start date first; access groups are
  limited to the role's approved set; the welcome message goes last; at most 12 tool calls per run.
  Every proposed call is checked against its JSON schema (`config/onboarding/tools.js`). Rejected
  calls are streamed as "blocked by policy" and returned to the model as errors.
- **Scripted fallback** (`config/onboarding/planner.js`): used when the LLM key is missing, the
  provider errors (after one short retry), the model makes two invalid tool calls, or the model has
  used its spare budget. It runs the same tools through the same guardrails, so the demo never fails
  because of the LLM.
- **Bounded, injection-free prompts:** visitors only send allow-listed IDs (hire, scenario, decision).
  Each LLM turn receives a fresh, server-built summary of validated facts rather than a growing
  transcript, so cost per turn stays flat.
- **Human in the loop without server state:** the pause event carries the run state (tool calls
  and counters, no free text). On resume the server replays those calls against the deterministic
  systems and the policy; a tampered or inconsistent state is rejected.
- **Simulated systems** (`config/onboarding/systems.js`): stateless, deterministic HTTP endpoints;
  IDs are hashes of the input; failures depend only on the scenario and attempt number headers.
- **Transport:** the orchestrator calls its own origin over HTTP. If that fails (or the response did
  not come from the simulator), it invokes the same handler in-process and says so in the timeline.

## Layout

The layout mirrors the portfolio site (static HTML + Cloudflare Pages Functions), so the demo is
synchronised with a plain copy (`scripts/sync-to-site.sh`).

```
config/onboarding/        shared modules (outside functions/, so they never become public routes)
  catalogue.js            synthetic hires, scenarios, laptops, decision options, effort assumptions
  systems.js              simulated HRIS / IT / Payroll / Calendar / Messaging APIs
  tools.js                tool contracts and JSON-schema validation
  policy.js               dependency graph and other guardrails
  planner.js              deterministic fallback planner
  llm.js                  OpenAI-compatible LLM client, prompts, tool-call parsing
  orchestrator.js         agent loop, retries, transport fallback, resume-state replay
  http.js                 input allow-lists and SSE response helper
functions/api/onboarding/
  run.js                  GET config · POST start run (SSE)
  resume.js               POST resume after a human decision (SSE)
  systems/[[path]].js     simulated systems as HTTP endpoints
demos/onboarding-orchestrator/
  index.html, app.js      the demo page (plain HTML, CSS and ES modules)
test/                     node:test suites
```

## Configuration

| Variable | Purpose |
| --- | --- |
| `DEEPSEEK_API_KEY` | API key for the LLM provider. Without it the scripted planner runs. |
| `ONBOARDING_LLM_MODEL` | Optional model override. Default: `deepseek-flash`. |
| `ONBOARDING_LLM_BASE_URL` | Optional base URL of any OpenAI-compatible API (`https` only; `/chat/completions` is appended). Default: `https://api.deepseek.com`. |

The model sits behind an OpenAI-compatible chat completions API and is chosen by configuration. With
the default provider, thinking mode is disabled on every request: in thinking mode the API rejects
`tool_choice: "required"` and expects earlier reasoning to be sent back with tools, which would break
the compact per-turn prompt; non-thinking mode is also faster. Reasoning text is never sent to the page.

Secrets live in Cloudflare Pages environment variables or a local `.dev.vars`, which is git-ignored.

## Run locally

```bash
npm test                       # node --test, no dependencies
npx wrangler pages dev .       # serves the page and Functions; open /demos/onboarding-orchestrator/
```

Running inside the site repository gives the full site styling; here the page still works but
`/style.css` and `/build-info.js` are not present.

## Connecting real systems

Each simulated endpoint becomes a thin adapter for the real HRIS, ITSM, payroll, calendar and
messaging REST APIs, with OAuth service credentials kept in the secret store. An ATS webhook on a
signed offer starts the run, idempotency keys replace the deterministic IDs, every call is written to
an audit log, and approvals are routed to the HR coordinator's queue. The tool schemas, dependency
graph and call budget stay unchanged.
