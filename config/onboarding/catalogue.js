// Synthetic reference data for the onboarding demo.
// Every person, company and product below is fictional. Visitor input is limited to
// the IDs defined here, which act as allow-lists.

export const COMPANY = "Quillmere Analytics";

export const HIRES = Object.freeze({
  "hire-ada": Object.freeze({
    id: "hire-ada",
    fullName: "Ada Fernhill",
    firstName: "Ada",
    role: "Payroll Analyst",
    department: "Finance",
    manager: "Tobias Quell",
    country: "GB",
    countryName: "United Kingdom",
    currency: "GBP",
    startDate: "2026-11-02",
    laptopModel: "Kestrel 14 Pro",
    accessGroups: ["finance-core", "payroll-reports"]
  }),
  "hire-mateo": Object.freeze({
    id: "hire-mateo",
    fullName: "Mateo Brivani",
    firstName: "Mateo",
    role: "Data Engineer",
    department: "Platform",
    manager: "Ines Calloway",
    country: "IT",
    countryName: "Italy",
    currency: "EUR",
    startDate: "2026-11-09",
    laptopModel: "Heron 16 Workstation",
    accessGroups: ["engineering", "data-platform"]
  }),
  "hire-saoirse": Object.freeze({
    id: "hire-saoirse",
    fullName: "Saoirse Venhart",
    firstName: "Saoirse",
    role: "People Partner",
    department: "People",
    manager: "Priya Holloway",
    country: "IE",
    countryName: "Ireland",
    currency: "EUR",
    startDate: "2026-11-16",
    laptopModel: "Kestrel 14 Pro",
    accessGroups: ["people-ops", "hris-admin-readonly"]
  })
});

export const SCENARIOS = Object.freeze({
  happy: Object.freeze({
    id: "happy",
    label: "Happy path",
    description: "Every system answers first time."
  }),
  transient: Object.freeze({
    id: "transient",
    label: "Transient API failure",
    description: "The IT provisioning system returns HTTP 503 on the first call; the agent retries with backoff."
  }),
  decision: Object.freeze({
    id: "decision",
    label: "Needs human decision",
    description: "The requested laptop is out of stock; the agent stops and waits for a human to choose."
  })
});

// Fictional hardware catalogue. Each model names the in-stock alternative offered on a shortage.
export const LAPTOPS = Object.freeze({
  "Kestrel 14 Pro": Object.freeze({ alternative: "Kestrel 14" }),
  "Kestrel 14": Object.freeze({ alternative: null }),
  "Heron 16 Workstation": Object.freeze({ alternative: "Heron 16" }),
  "Heron 16": Object.freeze({ alternative: null })
});

export const DECISION_OPTIONS = Object.freeze({
  alternative: Object.freeze({
    id: "alternative",
    label: "Ship the alternative model now",
    detail: "Provision the in-stock alternative laptop; the start date is unchanged."
  }),
  delay: Object.freeze({
    id: "delay",
    label: "Wait for stock and delay the start date",
    detail: "Keep the requested laptop and move the start date back by one week."
  })
});

// Days added to the original start date when the visitor chooses to wait for stock.
export const RESTOCK_LEAD_DAYS = 5;
export const DELAY_DAYS = 7;

export const MAX_TOOL_CALLS = 12;

// Illustrative manual effort per step, in minutes. Shown on the page next to the estimate.
export const MANUAL_MINUTES = Object.freeze({
  hris_create_employee: { minutes: 10, assumption: "Key the new starter into the HRIS from the signed offer" },
  it_check_stock: { minutes: 5, assumption: "Check laptop stock with the IT service desk" },
  hris_update_start_date: { minutes: 5, assumption: "Amend the start date and notify the hiring manager" },
  it_create_ticket: { minutes: 8, assumption: "Raise the provisioning ticket with hardware and access groups" },
  payroll_register: { minutes: 12, assumption: "Register the employee with payroll for their country" },
  calendar_book_meetings: { minutes: 15, assumption: "Find slots and book five first-week meetings" },
  messaging_send_welcome: { minutes: 7, assumption: "Write and send a personalised welcome message" }
});

export function addDays(isoDate, days) {
  const date = new Date(`${isoDate}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

export function publicCatalogue() {
  return {
    company: COMPANY,
    hires: Object.values(HIRES).map(({ id, fullName, role, department, countryName, startDate, laptopModel }) => ({
      id, fullName, role, department, countryName, startDate, laptopModel
    })),
    scenarios: Object.values(SCENARIOS),
    decisionOptions: Object.values(DECISION_OPTIONS),
    maxToolCalls: MAX_TOOL_CALLS,
    manualMinutes: MANUAL_MINUTES
  };
}
