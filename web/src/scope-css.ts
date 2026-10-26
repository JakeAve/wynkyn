// web/src/scope-css.ts — keep one preview render's CSS on its own pages.
// Paged.js puts every render's sheets in the document, so while a new render
// is laid out beside the pages on screen each would take the other's look.
// preview.ts marks a render's root `data-scope` and scopes its sheets here.

// `scope` before each selector in the list; a leading :root, html or body
// becomes the scope itself (Paged.js sets the page size on :root).
export function scopeSelector(list: string, scope: string): string {
  const parts: string[] = [];
  let depth = 0, start = 0;
  for (let i = 0; i < list.length; i++) {
    const ch = list[i];
    if (ch === "(" || ch === "[") depth++;
    else if (ch === ")" || ch === "]") depth--;
    else if (ch === "," && depth === 0) {
      parts.push(list.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(list.slice(start));
  return parts.map((s) => {
    s = s.trim();
    const root = /^(:root|html|body)(?![\w-])/.exec(s);
    return root ? scope + s.slice(root[0].length) : `${scope} ${s}`;
  }).join(", ");
}

// Every style rule in `sheet`, inside @media and @supports too, in place.
// @page, @font-face and @keyframes aren't about elements, so they stay.
export function scopeSheet(sheet: CSSStyleSheet, scope: string): void {
  const walk = (rules: CSSRuleList) => {
    for (const rule of rules) {
      if (rule instanceof CSSStyleRule) {
        rule.selectorText = scopeSelector(rule.selectorText, scope);
      } else if (
        rule instanceof CSSMediaRule || rule instanceof CSSSupportsRule
      ) walk(rule.cssRules);
    }
  };
  walk(sheet.cssRules);
}
