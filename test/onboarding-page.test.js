import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const html = await readFile(new URL("../demos/onboarding-orchestrator/index.html", import.meta.url), "utf8");
const js = await readFile(new URL("../demos/onboarding-orchestrator/app.js", import.meta.url), "utf8");
const matches = (pattern) => [...html.matchAll(pattern)];

test("demo page keeps the site layout, provenance footer and unique IDs", () => {
  assert.equal(matches(/<main(?:\s|>)/g).length, 1);
  assert.equal(matches(/<h1(?:\s|>)/g).length, 1);
  assert.match(html, /<html lang="en-GB">/);
  assert.match(html, /<link rel="stylesheet" href="\/style.css" \/>/);
  assert.equal(matches(/<script src="\/build-info\.js"><\/script>/g).length, 1);
  const ids = matches(/\sid="([^"]+)"/g).map((m) => m[1]);
  assert.equal(new Set(ids).size, ids.length, "IDs must be unique");
  for (const id of ["build-branch", "build-commit", "build-time", "modeBadge", "timeline", "systems", "summary"]) {
    assert.ok(ids.includes(id), `missing #${id}`);
  }
  for (const id of js.matchAll(/\$\("([^"]+)"\)/g)) assert.ok(ids.includes(id[1]), `app.js references missing #${id[1]}`);
});

test("demo page shows the required notice, mode badge, systems and How it works", () => {
  assert.ok(html.includes("Synthetic data only. Simulated systems. A human approves every exception."));
  for (const system of ["hris", "it", "payroll", "calendar", "messaging"]) assert.match(html, new RegExp(`data-system="${system}"`));
  assert.match(html, /How it works/);
  assert.match(html, /href="https:\/\/github.com\/nepryoon\/hr-onboarding-orchestrator" target="_blank" rel="noopener noreferrer"/);
  assert.match(html, /Illustrative estimate/);
  assert.match(js, /LLM agent/);
  assert.match(js, /Scripted fallback/);
});

test("client renders server data as text, never as HTML", () => {
  assert.doesNotMatch(js, /innerHTML|outerHTML|insertAdjacentHTML|document\.write/);
});

test("user-facing copy uses British English", () => {
  const american = /\b(color|behavior|organization|prioritize|analyze|initialize|favorite|license|catalog|center)\b/i;
  assert.doesNotMatch(html.replace(/<style>[\s\S]*?<\/style>/, ""), american);
});
