/**
 * Money is stored as integer minor units (paise) per ADR-0010 — never float.
 * These helpers convert at the edges (seed data, tests). Formatting to ₹ for
 * display lives on the frontend.
 */
export const rupeesToPaise = (rupees: number): number =>
  Math.round(rupees * 100);

export const paiseToRupees = (paise: number): number => paise / 100;
