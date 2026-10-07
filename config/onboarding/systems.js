// Simulated HRIS, IT service desk, Payroll, Calendar and Messaging systems.
// Stateless and deterministic: identifiers derive from the input, and failure behaviour is
// driven only by the scenario and attempt number sent in the request headers.

import { HIRES, LAPTOPS, SCENARIOS, RESTOCK_LEAD_DAYS, addDays } from "./catalogue.js";

export const SYSTEMS_PREFIX = "/api/onboarding/systems";
export const SIM_HEADER = "x-onboarding-sim";

export function stableId(prefix, ...parts) {
  // FNV-1a, 32-bit: small, dependency-free and identical in every runtime.
  let hash = 0x811c9dc5;
  for (const char of parts.join("|")) {
    hash ^= char.codePointAt(0);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return `${prefix}-${hash.toString(36).toUpperCase().padStart(7, "0")}`;
}

export const employeeIdFor = (hireId) => stableId("EMP", hireId);

function hireForEmployee(employeeId) {
  return Object.values(HIRES).find((hire) => employeeIdFor(hire.id) === employeeId) || null;
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      [SIM_HEADER]: "1"
    }
  });
}

const fail = (status, error, detail) => json({ error, detail }, status);

async function readBody(request) {
  try {
    const body = await request.json();
    return body && typeof body === "object" && !Array.isArray(body) ? body : null;
  } catch {
    return null;
  }
}

// --- Individual systems ----------------------------------------------------

function hrisCreate(body) {
  const hire = HIRES[body.hireId];
  if (!hire) return fail(400, "invalid_request", "hireId is not a known offer");
  return json({
    system: "hris",
    employeeId: employeeIdFor(hire.id),
    fullName: hire.fullName,
    role: hire.role,
    department: hire.department,
    manager: hire.manager,
    country: hire.country,
    startDate: hire.startDate,
    status: "pre-boarding"
  }, 201);
}

function hrisUpdateStartDate(employeeId, body) {
  const hire = hireForEmployee(employeeId);
  if (!hire) return fail(404, "not_found", "Unknown employee");
  if (typeof body.startDate !== "string" || !ISO_DATE.test(body.startDate)) {
    return fail(400, "invalid_request", "startDate must be YYYY-MM-DD");
  }
  if (body.startDate <= hire.startDate) {
    return fail(422, "invalid_start_date", "A delayed start date must be later than the original");
  }
  return json({
    system: "hris",
    employeeId,
    previousStartDate: hire.startDate,
    startDate: body.startDate,
    status: "pre-boarding"
  });
}

function itStock(url, scenario) {
  const model = url.searchParams.get("model");
  const hire = HIRES[url.searchParams.get("hireId")];
  if (!model || !LAPTOPS[model]) return fail(400, "invalid_request", "Unknown laptop model");
  if (!hire) return fail(400, "invalid_request", "hireId is not a known offer");

  const shortage = scenario === "decision" && model === hire.laptopModel;
  if (!shortage) {
    return json({ system: "it", model, available: true, quantity: 4 + (model.length % 5) });
  }
  return json({
    system: "it",
    model,
    available: false,
    quantity: 0,
    restockDate: addDays(hire.startDate, RESTOCK_LEAD_DAYS),
    alternative: LAPTOPS[model].alternative,
    alternativeAvailable: true
  });
}

function itCreateTicket(body, scenario, attempt) {
  if (scenario === "transient" && attempt === 1) {
    return fail(503, "service_unavailable", "IT provisioning is temporarily unavailable; retry shortly");
  }
  const hire = hireForEmployee(body.employeeId);
  if (!hire) return fail(404, "not_found", "Unknown employee");
  if (!LAPTOPS[body.laptopModel]) return fail(400, "invalid_request", "Unknown laptop model");
  if (!Array.isArray(body.accessGroups) || body.accessGroups.some((g) => typeof g !== "string")) {
    return fail(400, "invalid_request", "accessGroups must be a list of strings");
  }
  return json({
    system: "it",
    ticketId: stableId("ITSM", body.employeeId, body.laptopModel),
    employeeId: body.employeeId,
    laptopModel: body.laptopModel,
    accessGroups: body.accessGroups,
    status: "queued"
  }, 201);
}

function payrollRegister(body) {
  const hire = hireForEmployee(body.employeeId);
  if (!hire) return fail(404, "not_found", "Unknown employee");
  if (body.country !== hire.country) return fail(422, "country_mismatch", "Country does not match the HRIS record");
  if (typeof body.startDate !== "string" || !ISO_DATE.test(body.startDate)) {
    return fail(400, "invalid_request", "startDate must be YYYY-MM-DD");
  }
  return json({
    system: "payroll",
    payrollId: stableId("PAY", body.employeeId, body.startDate),
    employeeId: body.employeeId,
    country: hire.country,
    currency: hire.currency,
    effectiveFrom: body.startDate,
    status: "registered"
  }, 201);
}

function calendarBook(body) {
  const hire = hireForEmployee(body.employeeId);
  if (!hire) return fail(404, "not_found", "Unknown employee");
  if (typeof body.startDate !== "string" || !ISO_DATE.test(body.startDate)) {
    return fail(400, "invalid_request", "startDate must be YYYY-MM-DD");
  }
  const plan = [
    [0, "09:30", `Welcome with ${hire.manager}`],
    [0, "11:00", "Laptop and access set-up with IT"],
    [1, "14:00", "Payroll and benefits briefing"],
    [2, "12:30", `${hire.department} team lunch`],
    [4, "15:00", "First-week check-in and 30-day goals"]
  ];
  return json({
    system: "calendar",
    employeeId: body.employeeId,
    events: plan.map(([offset, time, title]) => ({
      eventId: stableId("CAL", body.employeeId, body.startDate, title),
      date: addDays(body.startDate, offset),
      time,
      title
    })),
    status: "booked"
  }, 201);
}

function messagingSend(body) {
  const hire = hireForEmployee(body.employeeId);
  if (!hire) return fail(404, "not_found", "Unknown employee");
  if (typeof body.message !== "string" || body.message.trim().length < 20) {
    return fail(400, "invalid_request", "message is required");
  }
  return json({
    system: "messaging",
    messageId: stableId("MSG", body.employeeId, body.message),
    employeeId: body.employeeId,
    channel: "email",
    status: "sent"
  }, 201);
}

// --- Router ------------------------------------------------------------------

export async function handleSystemRequest(request) {
  const url = new URL(request.url);
  const path = url.pathname.startsWith(SYSTEMS_PREFIX)
    ? url.pathname.slice(SYSTEMS_PREFIX.length).replace(/\/+$/, "")
    : null;
  if (path === null) return fail(404, "not_found", "Unknown system route");

  const rawScenario = request.headers.get("x-demo-scenario") || "happy";
  const scenario = SCENARIOS[rawScenario] ? rawScenario : "happy";
  const attempt = Math.max(1, Number.parseInt(request.headers.get("x-demo-attempt") || "1", 10) || 1);
  const method = request.method.toUpperCase();

  if (path === "/it/stock") {
    if (method !== "GET") return fail(405, "method_not_allowed", "Use GET");
    return itStock(url, scenario);
  }

  const routes = {
    "/hris/employees": { POST: hrisCreate },
    "/it/tickets": { POST: (body) => itCreateTicket(body, scenario, attempt) },
    "/payroll/employees": { POST: payrollRegister },
    "/calendar/events": { POST: calendarBook },
    "/messaging/messages": { POST: messagingSend }
  };

  const employeeMatch = path.match(/^\/hris\/employees\/([A-Z0-9-]{4,24})$/);
  if (employeeMatch) {
    if (method !== "PATCH") return fail(405, "method_not_allowed", "Use PATCH");
    const body = await readBody(request);
    if (!body) return fail(400, "invalid_request", "Body must be a JSON object");
    return hrisUpdateStartDate(employeeMatch[1], body);
  }

  const route = routes[path];
  if (!route) return fail(404, "not_found", "Unknown system route");
  if (!route[method]) return fail(405, "method_not_allowed", `Use ${Object.keys(route).join(", ")}`);
  const body = await readBody(request);
  if (!body) return fail(400, "invalid_request", "Body must be a JSON object");
  return route[method](body);
}
