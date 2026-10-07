import test from "node:test";
import assert from "node:assert/strict";
import { handleSystemRequest, employeeIdFor, SIM_HEADER } from "../config/onboarding/systems.js";

const BASE = "https://demo.test/api/onboarding/systems";

function call(path, { method = "POST", body, scenario = "happy", attempt = 1 } = {}) {
  return handleSystemRequest(new Request(`${BASE}${path}`, {
    method,
    headers: { "content-type": "application/json", "x-demo-scenario": scenario, "x-demo-attempt": String(attempt) },
    body: body ? JSON.stringify(body) : undefined
  }));
}

test("HRIS creates deterministic employee records", async () => {
  const first = await call("/hris/employees", { body: { hireId: "hire-ada" } });
  const second = await call("/hris/employees", { body: { hireId: "hire-ada" } });
  assert.equal(first.status, 201);
  assert.equal(first.headers.get(SIM_HEADER), "1");
  const a = await first.json();
  assert.deepEqual(a, await second.json());
  assert.equal(a.employeeId, employeeIdFor("hire-ada"));
  assert.match(a.employeeId, /^EMP-[A-Z0-9]{7}$/);
  assert.notEqual(employeeIdFor("hire-ada"), employeeIdFor("hire-mateo"));
});

test("IT provisioning returns 503 on the first attempt only in the transient scenario", async () => {
  const body = { employeeId: employeeIdFor("hire-mateo"), laptopModel: "Heron 16 Workstation", accessGroups: ["engineering"] };
  assert.equal((await call("/it/tickets", { body, scenario: "transient", attempt: 1 })).status, 503);
  assert.equal((await call("/it/tickets", { body, scenario: "transient", attempt: 2 })).status, 201);
  assert.equal((await call("/it/tickets", { body, scenario: "happy", attempt: 1 })).status, 201);
});

test("stock check reports a shortage with an alternative in the decision scenario", async () => {
  const url = `/it/stock?model=${encodeURIComponent("Kestrel 14 Pro")}&hireId=hire-ada`;
  const short = await (await call(url, { method: "GET", scenario: "decision" })).json();
  assert.equal(short.available, false);
  assert.equal(short.alternative, "Kestrel 14");
  assert.equal(short.restockDate, "2026-11-07");
  const fine = await (await call(url, { method: "GET", scenario: "happy" })).json();
  assert.equal(fine.available, true);
});

test("systems validate input and reject unknown routes and methods", async () => {
  assert.equal((await call("/hris/employees", { body: { hireId: "someone-else" } })).status, 400);
  assert.equal((await call("/payroll/employees", { body: { employeeId: "EMP-0000000", country: "GB", startDate: "2026-11-02" } })).status, 404);
  assert.equal((await call("/payroll/employees", { body: { employeeId: employeeIdFor("hire-ada"), country: "IT", startDate: "2026-11-02" } })).status, 422);
  assert.equal((await call("/hris/employees", { method: "GET" })).status, 405);
  assert.equal((await call("/unknown", { body: {} })).status, 404);
});

test("calendar books five first-week meetings from the start date", async () => {
  const res = await call("/calendar/events", { body: { employeeId: employeeIdFor("hire-saoirse"), startDate: "2026-11-16" } });
  const body = await res.json();
  assert.equal(body.events.length, 5);
  assert.equal(body.events[0].date, "2026-11-16");
  assert.equal(body.events.at(-1).date, "2026-11-20");
});
