// Small regex-based HTML helpers for the posting parser. No DOM parser: the
// repo already reads job pages this way (lib/scraper/sources/jsonld.ts), and
// the fields we want live in <head> metadata and structured data, not deep in
// the document tree.

const NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  ndash: "–",
  mdash: "—",
  hellip: "…",
  rsquo: "’",
  lsquo: "‘",
  rdquo: "”",
  ldquo: "“",
  copy: "©",
  reg: "®",
  trade: "™",
  middot: "·",
  bull: "•",
};

export function decodeEntities(input: string): string {
  return input.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, body: string) => {
    if (body[0] === "#") {
      const code = body[1].toLowerCase() === "x" ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      if (!Number.isFinite(code) || code <= 0 || code > 0x10ffff) return whole;
      try {
        return String.fromCodePoint(code);
      } catch {
        return whole;
      }
    }
    return NAMED_ENTITIES[body.toLowerCase()] ?? whole;
  });
}

/** Decode entities, drop stray tags, collapse whitespace, trim. */
export function cleanText(input: string | null | undefined): string {
  if (!input) return "";
  return decodeEntities(input.replace(/<[^>]+>/g, " "))
    .replace(/\s+/g, " ")
    .trim();
}

/** Cut at a word boundary with an ellipsis; nothing absurdly long reaches the DB. */
export function truncate(input: string, max: number): string {
  if (input.length <= max) return input;
  const cut = input.slice(0, max - 1);
  const atWord = cut.lastIndexOf(" ");
  return `${atWord > max * 0.6 ? cut.slice(0, atWord) : cut}…`;
}

/** The value of one attribute on a tag's attribute string, entity-decoded. */
export function attr(tag: string, name: string): string | null {
  const re = new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s"'>]+))`, "i");
  const match = re.exec(tag);
  if (!match) return null;
  return decodeEntities(match[1] ?? match[2] ?? match[3] ?? "");
}

/** All `<meta …>` tags as a list of {name|property, content}. */
export function metaTags(html: string): Array<{ key: string; content: string }> {
  const out: Array<{ key: string; content: string }> = [];
  const re = /<meta\b[^>]*>/gi;
  let match: RegExpExecArray | null;
  while ((match = re.exec(html))) {
    const key = attr(match[0], "property") ?? attr(match[0], "name");
    const content = attr(match[0], "content");
    if (key && content !== null) out.push({ key: key.toLowerCase(), content });
  }
  return out;
}

export function metaContent(html: string, ...keys: string[]): string | null {
  const tags = metaTags(html);
  for (const key of keys) {
    const hit = tags.find((t) => t.key === key.toLowerCase());
    if (hit && cleanText(hit.content)) return cleanText(hit.content);
  }
  return null;
}

export function documentTitle(html: string): string | null {
  const match = /<title\b[^>]*>([\s\S]*?)<\/title>/i.exec(html);
  return match ? cleanText(match[1]) || null : null;
}

/** Only the part of the page that matters for the "is this a login wall" check. */
export function headHtml(html: string): string {
  const end = html.search(/<body\b/i);
  return end === -1 ? html.slice(0, 20_000) : html.slice(0, end);
}
