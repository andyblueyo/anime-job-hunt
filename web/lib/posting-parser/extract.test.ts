import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import {
  companyFromUrl,
  extractPosting,
  formatCompactSalary,
  normalizeDate,
  splitGreenhouseTitle,
  stripCompanyFromTitle,
  titleCaseSlug,
} from "./extract";
import { decodeEntities, truncate } from "./html";

function fixture(name: string): string {
  return readFileSync(new URL(`./__fixtures__/${name}`, import.meta.url), "utf8");
}

describe("real Greenhouse page (job-boards.greenhouse.io, saved 2026-09-07)", () => {
  const url = "https://job-boards.greenhouse.io/anthropic/jobs/5183044008";
  const parsed = extractPosting(fixture("greenhouse-anthropic.html"), url);

  test("company and role come from the <title> pattern, not the ATS name", () => {
    expect(parsed.fields.title).toBe("Anthropic Fellows Program, AI Safety & Security");
    expect(parsed.fields.company).toBe("Anthropic");
    expect(parsed.provenance.title).toBe("meta");
    expect(parsed.provenance.company).toBe("meta");
  });

  test("location is read from og:description on Greenhouse hosts only", () => {
    expect(parsed.fields.location).toContain("London, UK");
    expect(parsed.provenance.location).toBe("meta");
  });

  test("fields with no source stay blank with provenance none", () => {
    expect(parsed.fields.salary_range).toBe("");
    expect(parsed.provenance.salary_range).toBe("none");
    expect(parsed.fields.posted_date).toBe("");
    expect(parsed.provenance.posted_date).toBe("none");
  });

  test("url is echoed back with url provenance", () => {
    expect(parsed.fields.url).toBe(url);
    expect(parsed.provenance.url).toBe("url");
  });
});

describe("real Lever page (jobs.lever.co, saved 2026-09-07)", () => {
  const url = "https://jobs.lever.co/palantir/ac978161-6f46-4f6b-ad9e-a258e642751c";
  const parsed = extractPosting(fixture("lever-palantir.html"), url);

  test("JSON-LD wins for company, role, location, and date", () => {
    expect(parsed.fields.title).toBe("Administrative Business Partner");
    expect(parsed.fields.company).toBe("Palantir Technologies");
    expect(parsed.fields.location).toBe("London, United Kingdom");
    expect(parsed.fields.posted_date).toBe("2024-03-25");
    expect(parsed.provenance).toMatchObject({
      title: "jsonld",
      company: "jsonld",
      location: "jsonld",
      posted_date: "jsonld",
      salary_range: "none",
    });
  });
});

describe("JSON-LD nested in @graph with an array @type", () => {
  const parsed = extractPosting(
    fixture("jsonld-graph.html"),
    "https://careers.acme-robotics.example/jobs/123",
  );

  test("maps every field", () => {
    expect(parsed.fields).toEqual({
      company: "Acme Robotics",
      title: "Senior Product Manager, Payments & Risk",
      url: "https://careers.acme-robotics.example/jobs/123",
      location: "Remote — Austin, TX",
      salary_range: "$165k–$195k",
      posted_date: "2026-08-30",
    });
    expect(Object.values(parsed.provenance).filter((p) => p === "jsonld")).toHaveLength(5);
  });
});

describe("microdata JobPosting", () => {
  const parsed = extractPosting(fixture("microdata.html"), "https://kelp.example/careers/staff-pm");

  test("same mapping as JSON-LD, hourly salary keeps its unit", () => {
    expect(parsed.fields.title).toBe("Staff Product Manager");
    expect(parsed.fields.company).toBe("Kelp & Co");
    expect(parsed.fields.location).toBe("Vancouver, BC");
    expect(parsed.fields.salary_range).toBe("CA$60–CA$75/hr");
    expect(parsed.fields.posted_date).toBe("2026-09-01");
    expect(parsed.provenance.title).toBe("microdata");
    expect(parsed.provenance.salary_range).toBe("microdata");
  });
});

describe("page with only OG tags", () => {
  const parsed = extractPosting(fixture("og-only.html"), "https://nimbus.example/jobs/product-lead");

  test("title from og:title with the site name stripped; company from og:site_name", () => {
    expect(parsed.fields.title).toBe("Product Lead");
    expect(parsed.fields.company).toBe("Nimbus Weather");
    expect(parsed.provenance.title).toBe("meta");
    expect(parsed.provenance.company).toBe("meta");
  });

  test("never guesses location or salary from body text", () => {
    expect(parsed.fields.location).toBe("");
    expect(parsed.fields.salary_range).toBe("");
  });
});

describe("page with nothing parseable", () => {
  test("every field blank, every provenance none (except the url)", () => {
    const parsed = extractPosting(fixture("nothing.html"), "https://spa.example/job/1");
    expect(parsed.fields).toEqual({
      company: "",
      title: "",
      url: "https://spa.example/job/1",
      location: "",
      salary_range: "",
      posted_date: "",
    });
    expect(parsed.provenance.title).toBe("none");
    expect(parsed.provenance.company).toBe("none");
  });

  test("an ATS og:site_name is not taken as the company", () => {
    const html = `<html><head><title>Jobs</title><meta property="og:site_name" content="Lever"></head></html>`;
    const parsed = extractPosting(html, "https://example.com/x");
    expect(parsed.fields.company).toBe("");
  });
});

describe("known-host URL heuristics", () => {
  test.each([
    ["https://boards.greenhouse.io/duolingo/jobs/123", "Duolingo"],
    ["https://job-boards.greenhouse.io/anthropic/jobs/5183044008", "Anthropic"],
    ["https://jobs.lever.co/palantir/ac978161", "Palantir"],
    ["https://jobs.ashbyhq.com/notion/abc-def", "Notion"],
    ["https://jobs.lever.co/acme-corp/xyz", "Acme Corp"],
  ])("%s -> %s", (input, expected) => {
    expect(companyFromUrl(new URL(input))).toBe(expected);
  });

  test("nothing for unknown hosts or a bare board root", () => {
    expect(companyFromUrl(new URL("https://example.com/acme/jobs/1"))).toBeNull();
    expect(companyFromUrl(new URL("https://jobs.lever.co/"))).toBeNull();
  });

  test("used as a last resort with url provenance", () => {
    const parsed = extractPosting(fixture("nothing.html"), "https://jobs.lever.co/acme-corp/xyz");
    expect(parsed.fields.company).toBe("Acme Corp");
    expect(parsed.provenance.company).toBe("url");
  });

  test("titleCaseSlug", () => {
    expect(titleCaseSlug("studio_ghibli")).toBe("Studio Ghibli");
    expect(titleCaseSlug("a-b%20c")).toBe("A B C");
  });
});

describe("cleanup", () => {
  test("Greenhouse title split", () => {
    expect(splitGreenhouseTitle("Job Application for Product Manager at Studio Ghibli")).toEqual({
      title: "Product Manager",
      company: "Studio Ghibli",
    });
    expect(splitGreenhouseTitle("Product Manager")).toBeNull();
  });

  test("company suffixes and prefixes are stripped from titles", () => {
    expect(stripCompanyFromTitle("Product Manager - Acme", "Acme")).toBe("Product Manager");
    expect(stripCompanyFromTitle("Product Manager | Acme", "Acme")).toBe("Product Manager");
    expect(stripCompanyFromTitle("Product Manager at Acme", "Acme")).toBe("Product Manager");
    expect(stripCompanyFromTitle("Acme - Product Manager", "Acme")).toBe("Product Manager");
    expect(stripCompanyFromTitle("Product Manager", "")).toBe("Product Manager");
    expect(stripCompanyFromTitle("Product Manager at Acme Inc.", "Acme Inc.")).toBe("Product Manager");
  });

  test("entities and whitespace", () => {
    expect(decodeEntities("AI Safety &amp; Security &#8211; R&#x26;D&nbsp;team")).toBe(
      "AI Safety & Security – R&D team",
    );
    const parsed = extractPosting(
      `<html><head><title>  Product\n\n  Manager   &mdash;  Acme </title><meta property="og:site_name" content="Acme"></head></html>`,
      "https://acme.example/j",
    );
    expect(parsed.fields.title).toBe("Product Manager");
  });

  test("absurdly long values are truncated", () => {
    const long = "Very ".repeat(100).trim();
    expect(truncate(long, 40).length).toBeLessThanOrEqual(40);
    expect(truncate(long, 40).endsWith("…")).toBe(true);
    const parsed = extractPosting(
      `<html><head><title>${long}</title></head></html>`,
      "https://acme.example/j",
    );
    expect(parsed.fields.title.length).toBeLessThanOrEqual(160);
  });

  test("dates", () => {
    expect(normalizeDate("2026-08-30T14:03:00+00:00")).toBe("2026-08-30");
    expect(normalizeDate("2026-08-30")).toBe("2026-08-30");
    expect(normalizeDate("not a date")).toBe("");
    expect(normalizeDate(null)).toBe("");
  });
});

describe("salary normalization", () => {
  test.each([
    [140000, 170000, "USD", "YEAR", "$140k–$170k"],
    [140000, 170000, null, null, "140k–170k"],
    [150000, null, "USD", "YEAR", "$150k"],
    [null, 150000, "USD", "YEAR", "$150k"],
    [142500, 170000, "USD", "YEAR", "$142.5k–$170k"],
    [60, 75, "USD", "HOUR", "$60–$75/hr"],
    [45.5, 45.5, "GBP", "HOUR", "£45.5/hr"],
    [8000, 9000, "EUR", "MONTH", "€8000–€9000/mo"],
    [90000, 90000, "CHF", "YEAR", "CHF 90k"],
    [null, null, "USD", "YEAR", ""],
    [0, -5, "USD", "YEAR", ""],
  ])("%s–%s %s/%s -> %s", (min, max, currency, unit, expected) => {
    expect(formatCompactSalary(min, max, currency, unit)).toBe(expected);
  });

  test("a bare number baseSalary", () => {
    const html = `<script type="application/ld+json">{"@type":"JobPosting","title":"PM","hiringOrganization":"Acme","baseSalary":120000}</script>`;
    expect(extractPosting(html, "https://acme.example").fields.salary_range).toBe("120k");
  });
});
