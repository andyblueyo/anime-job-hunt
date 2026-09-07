import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import {
  FetchFailure,
  MAX_BYTES,
  assertPublicTarget,
  fetchPostingHtml,
  isPrivateAddress,
  parseHttpUrl,
} from "./fetch";
import { parsePostingUrl } from "./index";

const publicResolver = async () => ["93.184.216.34"];

async function kind(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
    return "ok";
  } catch (error) {
    if (error instanceof FetchFailure) return error.kind;
    throw error;
  }
}

describe("URL validation", () => {
  test.each(["https://example.com/jobs/1", "http://example.com", " https://example.com/x?y=1 "])(
    "accepts %s",
    (input) => {
      expect(parseHttpUrl(input).protocol).toMatch(/^https?:$/);
    },
  );

  test.each([
    "ftp://example.com/file",
    "file:///etc/passwd",
    "javascript:alert(1)",
    "example.com/jobs",
    "",
    "https://user:pw@example.com/",
  ])("rejects %s", (input) => {
    expect(() => parseHttpUrl(input)).toThrow(FetchFailure);
  });
});

describe("private address detection", () => {
  test.each([
    "127.0.0.1",
    "127.8.8.8",
    "10.0.0.5",
    "172.16.0.1",
    "172.31.255.255",
    "192.168.1.1",
    "169.254.169.254",
    "100.64.1.1",
    "0.0.0.0",
    "224.0.0.1",
    "255.255.255.255",
    "::1",
    "::",
    "fc00::1",
    "fd12:3456::1",
    "fe80::1%en0",
    "fe80::1",
    "::ffff:127.0.0.1",
    "::ffff:10.0.0.1",
    "::ffff:7f00:1",
    "ff02::1",
    "not-an-ip",
  ])("%s is private/forbidden", (ip) => {
    expect(isPrivateAddress(ip)).toBe(true);
  });

  test.each(["93.184.216.34", "8.8.8.8", "172.32.0.1", "172.15.0.1", "2606:4700::6810:84e5", "::ffff:8.8.8.8"])(
    "%s is public",
    (ip) => {
      expect(isPrivateAddress(ip)).toBe(false);
    },
  );
});

describe("SSRF guard", () => {
  test.each([
    "http://localhost/",
    "http://localhost:3000/api/x",
    "http://foo.localhost/",
    "http://printer.local/",
    "http://metadata.google.internal/computeMetadata/v1/",
    "http://127.0.0.1/",
    "http://[::1]:8080/",
    "http://169.254.169.254/latest/meta-data/",
    "http://10.1.2.3/",
    "http://0x7f000001/",
  ])("%s is blocked without a lookup", async (input) => {
    let looked = false;
    await expect(
      kind(
        assertPublicTarget(new URL(input), async () => {
          looked = true;
          return ["93.184.216.34"];
        }),
      ),
    ).resolves.toBe("blocked_target");
    expect(looked).toBe(false);
  });

  test("a hostname resolving to private space is blocked", async () => {
    await expect(
      kind(assertPublicTarget(new URL("https://evil.example/"), async () => ["10.0.0.9"])),
    ).resolves.toBe("blocked_target");
    await expect(
      kind(assertPublicTarget(new URL("https://evil.example/"), async () => ["93.184.216.34", "::1"])),
    ).resolves.toBe("blocked_target");
  });

  test("a hostname resolving to public space passes", async () => {
    await expect(kind(assertPublicTarget(new URL("https://example.com/"), publicResolver))).resolves.toBe("ok");
  });

  test("a hostname that fails to resolve is a network error, not a pass", async () => {
    await expect(
      kind(
        assertPublicTarget(new URL("https://nope.invalid/"), async () => {
          throw new Error("ENOTFOUND");
        }),
      ),
    ).resolves.toBe("network");
  });
});

// A tiny fetch double: URL -> Response. Anything unlisted throws like a
// connection failure would.
function fakeFetch(routes: Record<string, () => Response>): typeof fetch {
  return (async (input: RequestInfo | URL) => {
    const key = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const route = routes[key];
    if (!route) throw new TypeError(`fetch failed: ${key}`);
    return route();
  }) as typeof fetch;
}

const html = (body: string, init: ResponseInit = {}) =>
  new Response(body, { status: 200, headers: { "content-type": "text/html; charset=utf-8" }, ...init });

describe("fetchPostingHtml", () => {
  test("follows redirects and re-checks each hop", async () => {
    let checked: string[] = [];
    const resolve = async (host: string) => {
      checked.push(host);
      return host === "internal.example" ? ["10.0.0.1"] : ["93.184.216.34"];
    };
    const routes = {
      "https://a.example/": () => new Response(null, { status: 302, headers: { location: "https://b.example/job" } }),
      "https://b.example/job": () => html("<html><head><title>x</title></head></html>"),
      "https://c.example/": () => new Response(null, { status: 301, headers: { location: "http://internal.example/" } }),
    };
    const page = await fetchPostingHtml("https://a.example/", { fetch: fakeFetch(routes), resolve });
    expect(page.finalUrl).toBe("https://b.example/job");
    expect(checked).toEqual(["a.example", "b.example"]);

    checked = [];
    await expect(kind(fetchPostingHtml("https://c.example/", { fetch: fakeFetch(routes), resolve }))).resolves.toBe(
      "blocked_target",
    );
    expect(checked).toEqual(["c.example", "internal.example"]);
  });

  test("gives up after too many redirects", async () => {
    const routes: Record<string, () => Response> = {};
    for (let i = 0; i < 10; i++) {
      routes[`https://r.example/${i}`] = () =>
        new Response(null, { status: 302, headers: { location: `https://r.example/${i + 1}` } });
    }
    await expect(
      kind(fetchPostingHtml("https://r.example/0", { fetch: fakeFetch(routes), resolve: publicResolver })),
    ).resolves.toBe("network");
  });

  test("non-HTML content types are refused before the body is read", async () => {
    const routes = {
      "https://p.example/job.pdf": () =>
        new Response("%PDF-1.4", { status: 200, headers: { "content-type": "application/pdf" } }),
      "https://p.example/api": () =>
        new Response("{}", { status: 200, headers: { "content-type": "application/json" } }),
    };
    await expect(
      kind(fetchPostingHtml("https://p.example/job.pdf", { fetch: fakeFetch(routes), resolve: publicResolver })),
    ).resolves.toBe("not_html");
    await expect(
      kind(fetchPostingHtml("https://p.example/api", { fetch: fakeFetch(routes), resolve: publicResolver })),
    ).resolves.toBe("not_html");
  });

  test("HTTP errors carry their status", async () => {
    const routes = { "https://li.example/": () => html("<html></html>", { status: 403 }) };
    try {
      await fetchPostingHtml("https://li.example/", { fetch: fakeFetch(routes), resolve: publicResolver });
      throw new Error("expected a throw");
    } catch (error) {
      expect(error).toBeInstanceOf(FetchFailure);
      expect((error as FetchFailure).kind).toBe("http_error");
      expect((error as FetchFailure).status).toBe(403);
    }
  });

  test("oversized bodies are cut at the cap, not rejected", async () => {
    const big = `<html><head><title>Big</title></head><body>${"x".repeat(MAX_BYTES + 5000)}</body></html>`;
    const routes = { "https://big.example/": () => html(big) };
    const page = await fetchPostingHtml("https://big.example/", { fetch: fakeFetch(routes), resolve: publicResolver });
    expect(page.truncated).toBe(true);
    expect(page.html.length).toBeLessThanOrEqual(MAX_BYTES);
    expect(page.html.startsWith("<html><head><title>Big</title>")).toBe(true);
  });

  test("connection failures are network errors", async () => {
    await expect(
      kind(fetchPostingHtml("https://down.example/", { fetch: fakeFetch({}), resolve: publicResolver })),
    ).resolves.toBe("network");
  });
});

describe("parsePostingUrl verdicts", () => {
  const deps = (routes: Record<string, () => Response>) => ({ fetch: fakeFetch(routes), resolve: publicResolver });

  test("invalid input never fetches", async () => {
    const result = await parsePostingUrl("not a url", deps({}));
    expect(result.outcome).toBe("invalid_url");
    expect(result.fields.url).toBe("not a url");
  });

  // (LinkedIn's real 999 can't be built with new Response(); the status check
  // for it is the same branch as 401/403.)
  test("a LinkedIn 401/403/404 reads as a login wall, with the URL kept", async () => {
    for (const status of [401, 403, 404]) {
      const url = `https://www.linkedin.com/jobs/view/${status}/`;
      const result = await parsePostingUrl(url, deps({ [url]: () => html("<html><title>LinkedIn</title></html>", { status }) }));
      expect(result.outcome).toBe("blocked");
      expect(result.message).toMatch(/LinkedIn/);
      expect(result.fields).toMatchObject({ url, company: "", title: "" });
    }
  });

  test("a 200 that is really a sign-in page reads as a login wall", async () => {
    const url = "https://jobs.example/view/1";
    const wall = `<html><head><title>Sign In | Example Jobs</title><meta property="og:site_name" content="Example Jobs"></head></html>`;
    const result = await parsePostingUrl(url, deps({ [url]: () => html(wall) }));
    expect(result.outcome).toBe("blocked");
    expect(result.fields.company).toBe("");
    // The saved fixture of the same shape agrees.
    const fixture = readFileSync(new URL("./__fixtures__/login-wall.html", import.meta.url), "utf8");
    expect((await parsePostingUrl(url, deps({ [url]: () => html(fixture) }))).outcome).toBe("blocked");
  });

  test("a redirect onto an authwall reads as a login wall", async () => {
    const result = await parsePostingUrl(
      "https://www.linkedin.com/jobs/view/123/",
      deps({
        "https://www.linkedin.com/jobs/view/123/": () =>
          new Response(null, { status: 302, headers: { location: "https://www.linkedin.com/authwall?x=1" } }),
        "https://www.linkedin.com/authwall?x=1": () => html("<html><head><title>LinkedIn</title></head></html>"),
      }),
    );
    expect(result.outcome).toBe("blocked");
  });

  test("a LinkedIn 200 with only a <title> (a search listing, not the job) is a wall, not a role", async () => {
    const url = "https://www.linkedin.com/jobs/view/4295000000/";
    const listing = `<html><head><title>(703 vacantes) empleos de Abogado Fiscal en España | LinkedIn</title><meta property="og:title" content="703 empleos de Abogado Fiscal"></head><body></body></html>`;
    const result = await parsePostingUrl(url, deps({ [url]: () => html(listing) }));
    expect(result.outcome).toBe("blocked");
    expect(result.fields.title).toBe("");
  });

  test("a LinkedIn 200 that does carry JobPosting JSON-LD is parsed normally", async () => {
    const url = "https://www.linkedin.com/jobs/view/123/";
    const real = `<html><head><title>Product Manager - Acme | LinkedIn</title><script type="application/ld+json">{"@type":"JobPosting","title":"Product Manager","hiringOrganization":{"@type":"Organization","name":"Acme"},"jobLocation":{"@type":"Place","address":{"addressLocality":"Denver","addressRegion":"CO"}}}</script></head></html>`;
    const result = await parsePostingUrl(url, deps({ [url]: () => html(real) }));
    expect(result.outcome).toBe("ok");
    expect(result.fields).toMatchObject({ title: "Product Manager", company: "Acme", location: "Denver, CO" });
  });

  test("a fetched page with no job data says so", async () => {
    const url = "https://spa.example/job/1";
    const result = await parsePostingUrl(url, deps({ [url]: () => html("<html><body><div id=root></div></body></html>") }));
    expect(result.outcome).toBe("no_job_data");
    expect(result.message).toMatch(/no job data/);
  });

  test("a 404 on an ordinary host is a network-class failure that keeps the URL", async () => {
    const url = "https://acme.example/jobs/gone";
    const result = await parsePostingUrl(url, deps({ [url]: () => html("<html></html>", { status: 404 }) }));
    expect(result.outcome).toBe("network");
    expect(result.message).toMatch(/404/);
  });

  test("non-HTML", async () => {
    const url = "https://acme.example/jd.pdf";
    const result = await parsePostingUrl(
      url,
      deps({ [url]: () => new Response("%PDF", { status: 200, headers: { "content-type": "application/pdf" } }) }),
    );
    expect(result.outcome).toBe("not_html");
    expect(result.message).toMatch(/application\/pdf/);
  });

  test("a full parse has no message; a partial one counts fields", async () => {
    const url = "https://jobs.lever.co/acme/1";
    const full = `<html><head><script type="application/ld+json">{"@type":"JobPosting","title":"PM","hiringOrganization":{"name":"Acme"},"jobLocation":{"address":{"addressLocality":"Oslo"}},"baseSalary":{"currency":"USD","value":{"minValue":100000,"maxValue":120000,"unitText":"YEAR"}},"datePosted":"2026-09-01"}</script></head></html>`;
    const partial = `<html><head><title>PM - Acme</title><meta property="og:site_name" content="Acme"></head></html>`;
    expect((await parsePostingUrl(url, deps({ [url]: () => html(full) }))).message).toBeNull();
    const result = await parsePostingUrl(url, deps({ [url]: () => html(partial) }));
    expect(result.outcome).toBe("ok");
    expect(result.message).toMatch(/2 of 5/);
    expect(result.fields.title).toBe("PM");
  });
});
