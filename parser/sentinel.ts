// parser/sentinel.ts — recognizes a line that is exactly one sentinel tag (spec §3.2.2).
export interface SentinelTag {
  closing: boolean;
  name: string;
  slug?: string;
  params: Record<string, string>;
}

// {name}, {/name}, {name: slug}, {name: slug | key: value | ...}, {name | key: value}
const SENTINEL_RE = /^\{(\/?)([a-z][a-z-]*)\s*(?::\s*([^|}]*?))?\s*((?:\|[^|}]*)*)\}$/;

export function parseSentinelLine(line: string): SentinelTag | null {
  const m = line.trim().match(SENTINEL_RE);
  if (!m) return null;
  const [, close, name, slug, rest] = m;
  const params: Record<string, string> = {};
  if (rest) {
    for (const pair of rest.split("|")) {
      const t = pair.trim();
      if (!t) continue;
      const i = t.indexOf(":");
      if (i === -1) params[t] = "";
      else params[t.slice(0, i).trim()] = t.slice(i + 1).trim();
    }
  }
  return {
    closing: close === "/",
    name: name!,
    slug: slug?.trim() || undefined,
    params,
  };
}
