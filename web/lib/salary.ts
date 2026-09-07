import { parseSalaryText } from "@/lib/scraper/normalize";

export type SalaryFloor = { min: number; currency: string };

/**
 * True when a posting states a range whose top reaches the salary floor from
 * Settings. A preference, never a filter: the queue badges and ranks by it,
 * nothing is dropped for failing it — most boards publish no pay at all.
 */
export function meetsSalaryFloor(salaryRange: string | null, floor: SalaryFloor | null): boolean {
  if (!floor) return false;
  const { min, max } = parseSalaryText(salaryRange);
  const top = max ?? min;
  return top !== null && top >= floor.min;
}
