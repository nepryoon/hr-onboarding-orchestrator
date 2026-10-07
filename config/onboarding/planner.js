// Deterministic planner used when the LLM is unavailable or misbehaves.
// It proposes calls through the same tools; the orchestrator still validates and polices them.

import { HIRES, COMPANY, DELAY_DAYS, addDays } from "./catalogue.js";
import { expectedLaptop, remainingSteps } from "./policy.js";

export function templateWelcome(facts) {
  const hire = HIRES[facts.hireId];
  const laptop = facts.done.it_create_ticket?.laptopModel || hire.laptopModel;
  return [
    `Dear ${hire.firstName},`,
    `Welcome to ${COMPANY}! We are delighted that you are joining the ${hire.department} team as ${hire.role} on ${facts.startDate}.`,
    `Your ${laptop} and system access are being prepared, payroll is set up, and your first-week meetings, starting with ${hire.manager}, are already in your calendar.`,
    "If you have any questions before your first day, simply reply to this message.",
    "Kind regards, the People team"
  ].join("\n\n");
}

const REASONS = {
  hris_create_employee: "Every other system keys off the HRIS employee ID, so the record comes first.",
  it_check_stock: "Confirm the requested laptop is available before raising a provisioning ticket.",
  hris_update_start_date: "A delay was approved, so the HRIS start date must move before payroll and calendar use it.",
  it_create_ticket: "Stock is settled, so raise the IT ticket with the approved laptop and role access groups.",
  payroll_register: "Register payroll for the employee's country from the confirmed start date.",
  calendar_book_meetings: "Book the first-week meetings from the confirmed start date.",
  messaging_send_welcome: "All systems are ready, so send the personalised welcome message last."
};

export function nextScriptedCall(facts) {
  const hire = HIRES[facts.hireId];
  const name = remainingSteps(facts)[0];
  if (!name) return null;
  const employee_id = facts.employeeId;
  const argsByTool = {
    hris_create_employee: { hire_id: hire.id },
    it_check_stock: { laptop_model: hire.laptopModel },
    hris_update_start_date: { employee_id, new_start_date: addDays(hire.startDate, DELAY_DAYS) },
    it_create_ticket: { employee_id, laptop_model: expectedLaptop(facts), access_groups: [...hire.accessGroups] },
    payroll_register: { employee_id, country: hire.country, start_date: facts.startDate },
    calendar_book_meetings: { employee_id, start_date: facts.startDate },
    messaging_send_welcome: { employee_id, message: templateWelcome(facts) }
  };
  return { name, args: { reason: REASONS[name], ...argsByTool[name] } };
}
