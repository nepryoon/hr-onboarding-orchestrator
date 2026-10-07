// /functions/api/onboarding/systems/[[path]].js
// Simulated HRIS, IT, Payroll, Calendar and Messaging APIs, served as real HTTP endpoints.

import { handleSystemRequest } from "../../../../config/onboarding/systems.js";

export function onRequest(context) {
  return handleSystemRequest(context.request);
}
