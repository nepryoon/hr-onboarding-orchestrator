import test from "node:test";
import assert from "node:assert/strict";
import { validateToolCall, TOOL_NAMES } from "../config/onboarding/tools.js";
import { initialFacts, checkPolicy, applyResult } from "../config/onboarding/policy.js";
import { employeeIdFor } from "../config/onboarding/systems.js";
import { MAX_TOOL_CALLS } from "../config/onboarding/catalogue.js";

const reason = "Testing the guardrail.";
const emp = employeeIdFor("hire-ada");

test("schema validation rejects unknown tools, missing fields, extra fields and bad formats", () => {
  assert.equal(validateToolCall("delete_everything", { reason }).ok, false);
  assert.equal(validateToolCall("hris_create_employee", { hire_id: "hire-ada" }).ok, false);
  assert.equal(validateToolCall("hris_create_employee", { reason, hire_id: "hire-ada", salary: 1 }).ok, false);
  assert.equal(validateToolCall("payroll_register", { reason, employee_id: emp, country: "GB", start_date: "2 Nov" }).ok, false);
  assert.equal(validateToolCall("it_check_stock", { reason, laptop_model: "Any laptop" }).ok, false);
  assert.equal(validateToolCall("hris_create_employee", { reason, hire_id: "hire-ada" }).ok, true);
  assert.equal(TOOL_NAMES.length, 7);
  assert.equal(MAX_TOOL_CALLS, 12);
});

test("dependency graph blocks IT, payroll and messaging before the HRIS record exists", () => {
  const facts = initialFacts("hire-ada", "happy");
  assert.equal(checkPolicy("payroll_register", { reason, employee_id: emp, country: "GB", start_date: "2026-11-02" }, facts).ok, false);
  assert.equal(checkPolicy("it_create_ticket", { reason, employee_id: emp, laptop_model: "Kestrel 14 Pro", access_groups: ["finance-core"] }, facts).ok, false);
  assert.equal(checkPolicy("messaging_send_welcome", { reason, employee_id: emp, message: "x".repeat(50) }, facts).ok, false);
  assert.equal(checkPolicy("hris_create_employee", { reason, hire_id: "hire-mateo" }, facts).ok, false, "only the selected hire");
  assert.equal(checkPolicy("hris_create_employee", { reason, hire_id: "hire-ada" }, facts).ok, true);
});

test("welcome message must come last and access groups follow least privilege", () => {
  const facts = initialFacts("hire-ada", "happy");
  applyResult("hris_create_employee", {}, { employeeId: emp, startDate: "2026-11-02" }, facts);
  applyResult("it_check_stock", {}, { model: "Kestrel 14 Pro", available: true }, facts);
  const ticket = { reason, employee_id: emp, laptop_model: "Kestrel 14 Pro", access_groups: ["finance-core", "hris-admin"] };
  assert.match(checkPolicy("it_create_ticket", ticket, facts).violation, /Least privilege/);
  assert.equal(checkPolicy("it_create_ticket", { ...ticket, access_groups: ["finance-core"] }, facts).ok, true);
  assert.match(checkPolicy("messaging_send_welcome", { reason, employee_id: emp, message: "x".repeat(50) }, facts).violation, /goes last/);
  assert.match(checkPolicy("hris_create_employee", { reason, hire_id: "hire-ada" }, facts).violation, /already completed/);
});

test("an out-of-stock laptop blocks everything until a human decides", () => {
  const facts = initialFacts("hire-ada", "decision");
  applyResult("hris_create_employee", {}, { employeeId: emp, startDate: "2026-11-02" }, facts);
  applyResult("it_check_stock", {}, { model: "Kestrel 14 Pro", available: false, alternative: "Kestrel 14", restockDate: "2026-11-07" }, facts);
  assert.match(checkPolicy("payroll_register", { reason, employee_id: emp, country: "GB", start_date: "2026-11-02" }, facts).violation, /human decision/);
  facts.decision = "delay";
  assert.match(checkPolicy("payroll_register", { reason, employee_id: emp, country: "GB", start_date: "2026-11-02" }, facts).violation, /update the start date/);
  assert.equal(checkPolicy("hris_update_start_date", { reason, employee_id: emp, new_start_date: "2026-11-30" }, facts).ok, false);
  assert.equal(checkPolicy("hris_update_start_date", { reason, employee_id: emp, new_start_date: "2026-11-09" }, facts).ok, true);
});
