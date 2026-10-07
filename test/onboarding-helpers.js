// Shared test helpers. node --test also loads this file, but it defines no tests.

import { createServer } from "node:http";
import { runOnboarding, restoreState } from "../config/onboarding/orchestrator.js";

export const UNREACHABLE = "http://127.0.0.1:9";
export const fastDeps = { paceMs: 0, backoffBaseMs: 1, sleep: async () => {} };

export async function collect(options) {
  const events = [];
  const emit = async (event, data) => { events.push({ event, data }); };
  const result = await runOnboarding({ origin: UNREACHABLE, env: {}, ...options, emit, deps: { ...fastDeps, ...options.deps } });
  return { result, events, of: (name) => events.filter((e) => e.event === name).map((e) => e.data) };
}

export async function resumeWith(state, decision, options = {}) {
  const restored = await restoreState(JSON.parse(JSON.stringify(state)));
  if (!restored.ok) throw new Error(restored.error);
  return collect({ ...options, resume: restored, decision });
}

// Reads an SSE response body into [{ event, data }].
export async function readSse(response) {
  const text = await response.text();
  return text.split("\n\n").filter(Boolean).map((block) => {
    const event = block.match(/^event: (.*)$/m)?.[1];
    const data = block.match(/^data: (.*)$/m)?.[1];
    return { event, data: data ? JSON.parse(data) : null };
  });
}

// Serves a Fetch-API handler over real HTTP, so the orchestrator's self-calls cross a socket.
export async function serve(handler) {
  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = chunks.length ? Buffer.concat(chunks) : undefined;
    const request = new Request(`http://${req.headers.host}${req.url}`, {
      method: req.method,
      headers: req.headers,
      body: ["GET", "HEAD"].includes(req.method) ? undefined : body
    });
    const response = await handler(request);
    res.writeHead(response.status, Object.fromEntries(response.headers));
    res.end(Buffer.from(await response.arrayBuffer()));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  return { origin: `http://127.0.0.1:${port}`, close: () => new Promise((resolve) => server.close(resolve)) };
}

// Fake OpenAI-compatible LLM endpoint: returns the queued tool calls in order, then reports exhaustion.
export function fakeLlm(replies) {
  const calls = [];
  const queue = [...replies];
  const fetchImpl = async (url, init) => {
    calls.push({ ...JSON.parse(init.body), url });
    const next = queue.shift();
    if (!next) return new Response("{}", { status: 500 });
    if (next.status) return new Response("{}", { status: next.status });
    const message = next.text
      ? { role: "assistant", content: next.text }
      : {
          role: "assistant",
          content: null,
          reasoning_content: "SECRET-REASONING should never reach the page",
          tool_calls: [{ id: `call_${calls.length}`, type: "function", function: { name: next.name, arguments: typeof next.args === "string" ? next.args : JSON.stringify(next.args) } }]
        };
    // Keep-alive empty lines before the JSON body, as the provider may send on non-streaming requests.
    const usage = { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 };
    return new Response(`\n\n${JSON.stringify({ choices: [{ message }], usage })}`, { headers: { "content-type": "application/json" } });
  };
  return { fetchImpl, calls };
}
