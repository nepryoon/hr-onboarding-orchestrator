// Tool contracts shared by the LLM agent and the scripted planner.
// Every call, whoever proposes it, is validated against these schemas before it runs.

import { HIRES, LAPTOPS } from "./catalogue.js";

const EMPLOYEE_ID = { type: "string", pattern: "^EMP-[A-Z0-9]{7}$", description: "Employee ID issued by the HRIS" };
const ISO_DATE = { type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}$", description: "Date as YYYY-MM-DD" };
const REASON = { type: "string", minLength: 3, maxLength: 280, description: "One sentence explaining why this is the next step" };
const LAPTOP = { type: "string", enum: Object.keys(LAPTOPS) };

function objectSchema(properties) {
  return {
    type: "object",
    properties: { reason: REASON, ...properties },
    required: ["reason", ...Object.keys(properties)],
    additionalProperties: false
  };
}

export const TOOLS = Object.freeze({
  hris_create_employee: {
    system: "hris",
    description: "Create the employee record in the HRIS from the accepted offer. Returns the employee ID.",
    parameters: objectSchema({ hire_id: { type: "string", enum: Object.keys(HIRES) } }),
    request: (args) => ({ method: "POST", path: "/hris/employees", body: { hireId: args.hire_id } })
  },
  it_check_stock: {
    system: "it",
    description: "Check whether a laptop model is in stock at the IT service desk.",
    parameters: objectSchema({ laptop_model: LAPTOP }),
    request: (args, ctx) => ({
      method: "GET",
      path: `/it/stock?model=${encodeURIComponent(args.laptop_model)}&hireId=${encodeURIComponent(ctx.hireId)}`
    })
  },
  hris_update_start_date: {
    system: "hris",
    description: "Move the employee's start date in the HRIS. Only allowed after a human approved a delay.",
    parameters: objectSchema({ employee_id: EMPLOYEE_ID, new_start_date: ISO_DATE }),
    request: (args) => ({
      method: "PATCH",
      path: `/hris/employees/${args.employee_id}`,
      body: { startDate: args.new_start_date }
    })
  },
  it_create_ticket: {
    system: "it",
    description: "Raise the IT provisioning ticket for the laptop and access groups.",
    parameters: objectSchema({
      employee_id: EMPLOYEE_ID,
      laptop_model: LAPTOP,
      access_groups: { type: "array", items: { type: "string", pattern: "^[a-z0-9-]{2,40}$" }, minItems: 1, maxItems: 6 }
    }),
    request: (args) => ({
      method: "POST",
      path: "/it/tickets",
      body: { employeeId: args.employee_id, laptopModel: args.laptop_model, accessGroups: args.access_groups }
    })
  },
  payroll_register: {
    system: "payroll",
    description: "Register the employee with payroll for their country from their start date.",
    parameters: objectSchema({
      employee_id: EMPLOYEE_ID,
      country: { type: "string", enum: ["GB", "IT", "IE"] },
      start_date: ISO_DATE
    }),
    request: (args) => ({
      method: "POST",
      path: "/payroll/employees",
      body: { employeeId: args.employee_id, country: args.country, startDate: args.start_date }
    })
  },
  calendar_book_meetings: {
    system: "calendar",
    description: "Book the standard first-week meetings starting on the start date.",
    parameters: objectSchema({ employee_id: EMPLOYEE_ID, start_date: ISO_DATE }),
    request: (args) => ({
      method: "POST",
      path: "/calendar/events",
      body: { employeeId: args.employee_id, startDate: args.start_date }
    })
  },
  messaging_send_welcome: {
    system: "messaging",
    description: "Send the personalised welcome message to the new hire. Must be the final step.",
    parameters: objectSchema({
      employee_id: EMPLOYEE_ID,
      message: { type: "string", minLength: 40, maxLength: 1200, description: "Welcome message in British English, plain text" }
    }),
    request: (args) => ({
      method: "POST",
      path: "/messaging/messages",
      body: { employeeId: args.employee_id, message: args.message }
    })
  }
});

export const TOOL_NAMES = Object.freeze(Object.keys(TOOLS));

export function toolDefinitionsForLlm() {
  return TOOL_NAMES.map((name) => ({
    type: "function",
    function: { name, description: TOOLS[name].description, parameters: TOOLS[name].parameters }
  }));
}

// Minimal JSON Schema subset: object, string, array; enum, pattern, length and item bounds.
export function validateAgainstSchema(value, schema, path = "args") {
  const errors = [];
  if (schema.type === "object") {
    if (!value || typeof value !== "object" || Array.isArray(value)) return [`${path} must be an object`];
    for (const key of schema.required || []) {
      if (!(key in value)) errors.push(`${path}.${key} is required`);
    }
    for (const key of Object.keys(value)) {
      if (!schema.properties[key]) {
        if (schema.additionalProperties === false) errors.push(`${path}.${key} is not allowed`);
        continue;
      }
      errors.push(...validateAgainstSchema(value[key], schema.properties[key], `${path}.${key}`));
    }
    return errors;
  }
  if (schema.type === "array") {
    if (!Array.isArray(value)) return [`${path} must be an array`];
    if (schema.minItems !== undefined && value.length < schema.minItems) errors.push(`${path} needs at least ${schema.minItems} items`);
    if (schema.maxItems !== undefined && value.length > schema.maxItems) errors.push(`${path} allows at most ${schema.maxItems} items`);
    value.forEach((item, i) => errors.push(...validateAgainstSchema(item, schema.items, `${path}[${i}]`)));
    return errors;
  }
  if (schema.type === "string") {
    if (typeof value !== "string") return [`${path} must be a string`];
    if (schema.enum && !schema.enum.includes(value)) errors.push(`${path} must be one of ${schema.enum.join(", ")}`);
    if (schema.pattern && !new RegExp(schema.pattern).test(value)) errors.push(`${path} has an invalid format`);
    if (schema.minLength !== undefined && value.length < schema.minLength) errors.push(`${path} is too short`);
    if (schema.maxLength !== undefined && value.length > schema.maxLength) errors.push(`${path} is too long`);
    return errors;
  }
  return [`${path} has an unsupported schema`];
}

export function validateToolCall(name, args) {
  if (!TOOLS[name]) return { ok: false, errors: [`Unknown tool "${String(name).slice(0, 40)}"`] };
  const errors = validateAgainstSchema(args, TOOLS[name].parameters);
  return errors.length ? { ok: false, errors } : { ok: true, errors: [] };
}
