// Guardrails enforced in code. The model is told about them, but never trusted to obey them.

import { HIRES, LAPTOPS, DELAY_DAYS, addDays } from "./catalogue.js";

export function initialFacts(hireId, scenarioId) {
  return {
    hireId,
    scenarioId,
    employeeId: null,
    startDate: HIRES[hireId].startDate,
    stock: {},          // model -> { available, alternative, restockDate }
    decision: null,     // "alternative" | "delay" once a human has approved
    done: {}            // tool name -> summarised result
  };
}

export function expectedLaptop(facts) {
  const hire = HIRES[facts.hireId];
  const requested = facts.stock[hire.laptopModel];
  if (!requested || requested.available || facts.decision === "delay") return hire.laptopModel;
  if (facts.decision === "alternative") return LAPTOPS[hire.laptopModel].alternative;
  return null;
}

export function awaitingDecision(facts) {
  const hire = HIRES[facts.hireId];
  const requested = facts.stock[hire.laptopModel];
  return Boolean(requested && !requested.available && !facts.decision);
}

const block = (violation) => ({ ok: false, violation });
const OK = { ok: true, violation: null };

function needsEmployee(facts, args) {
  if (!facts.done.hris_create_employee) return block("The HRIS record must exist before this step.");
  if (args.employee_id !== facts.employeeId) return block(`employee_id must be the HRIS-issued ID ${facts.employeeId}.`);
  return null;
}

function needsSettledStartDate(facts) {
  if (facts.decision === "delay" && !facts.done.hris_update_start_date) {
    return block("A delay was approved: update the start date in the HRIS first.");
  }
  return null;
}

export function checkPolicy(name, args, facts) {
  const hire = HIRES[facts.hireId];
  if (awaitingDecision(facts)) return block("A human decision on the laptop shortage is pending.");
  if (facts.done[name] && name !== "it_check_stock") return block(`${name} has already completed for this run.`);

  switch (name) {
    case "hris_create_employee":
      if (args.hire_id !== hire.id) return block("hire_id must be the new hire selected for this run.");
      return OK;

    case "it_check_stock": {
      const allowed = [hire.laptopModel, LAPTOPS[hire.laptopModel].alternative].filter(Boolean);
      if (!allowed.includes(args.laptop_model)) return block(`Only ${allowed.join(" or ")} may be checked for this role.`);
      if (facts.stock[args.laptop_model]) return block(`Stock for ${args.laptop_model} has already been checked.`);
      return OK;
    }

    case "hris_update_start_date": {
      const err = needsEmployee(facts, args);
      if (err) return err;
      if (facts.decision !== "delay") return block("The start date can only change after a human approves a delay.");
      const expected = addDays(hire.startDate, DELAY_DAYS);
      if (args.new_start_date !== expected) return block(`The approved new start date is ${expected}.`);
      return OK;
    }

    case "it_create_ticket": {
      const err = needsEmployee(facts, args);
      if (err) return err;
      if (!facts.stock[hire.laptopModel]) return block(`Check stock for ${hire.laptopModel} before raising the ticket.`);
      const pending = needsSettledStartDate(facts);
      if (pending) return pending;
      const laptop = expectedLaptop(facts);
      if (args.laptop_model !== laptop) return block(`The approved laptop for this run is ${laptop}.`);
      const extra = args.access_groups.filter((group) => !hire.accessGroups.includes(group));
      if (extra.length) return block(`Least privilege: ${extra.join(", ")} is not approved for a ${hire.role}.`);
      return OK;
    }

    case "payroll_register":
    case "calendar_book_meetings": {
      const err = needsEmployee(facts, args) || needsSettledStartDate(facts);
      if (err) return err;
      if (args.start_date !== facts.startDate) return block(`start_date must match the HRIS record (${facts.startDate}).`);
      if (name === "payroll_register" && args.country !== hire.country) return block(`country must match the HRIS record (${hire.country}).`);
      return OK;
    }

    case "messaging_send_welcome": {
      const err = needsEmployee(facts, args);
      if (err) return err;
      const missing = ["it_create_ticket", "payroll_register", "calendar_book_meetings"].filter((t) => !facts.done[t]);
      if (missing.length) return block(`The welcome message goes last. Still to do: ${missing.join(", ")}.`);
      return OK;
    }

    default:
      return block(`Unknown tool ${name}.`);
  }
}

// Records a successful system response into the run facts.
export function applyResult(name, args, result, facts) {
  switch (name) {
    case "hris_create_employee":
      facts.employeeId = result.employeeId;
      facts.startDate = result.startDate;
      facts.done[name] = { employeeId: result.employeeId, startDate: result.startDate };
      break;
    case "it_check_stock":
      facts.stock[result.model] = {
        available: Boolean(result.available),
        alternative: result.alternative || null,
        restockDate: result.restockDate || null
      };
      facts.done[name] = { checked: Object.keys(facts.stock) };
      break;
    case "hris_update_start_date":
      facts.startDate = result.startDate;
      facts.done[name] = { startDate: result.startDate };
      break;
    case "it_create_ticket":
      facts.done[name] = { ticketId: result.ticketId, laptopModel: result.laptopModel };
      break;
    case "payroll_register":
      facts.done[name] = { payrollId: result.payrollId, currency: result.currency };
      break;
    case "calendar_book_meetings":
      facts.done[name] = { events: result.events.length };
      break;
    case "messaging_send_welcome":
      facts.done[name] = { messageId: result.messageId };
      break;
  }
}

export function remainingSteps(facts) {
  const steps = [];
  if (!facts.done.hris_create_employee) steps.push("hris_create_employee");
  if (!facts.stock[HIRES[facts.hireId].laptopModel]) steps.push("it_check_stock");
  if (facts.decision === "delay" && !facts.done.hris_update_start_date) steps.push("hris_update_start_date");
  for (const step of ["it_create_ticket", "payroll_register", "calendar_book_meetings", "messaging_send_welcome"]) {
    if (!facts.done[step]) steps.push(step);
  }
  return steps;
}

export const isComplete = (facts) => Boolean(facts.done.messaging_send_welcome);
