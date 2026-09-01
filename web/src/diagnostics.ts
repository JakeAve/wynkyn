// web/src/diagnostics.ts — parser Diagnostic (1-based line) → CodeMirror lint range.
import type { Text } from "@codemirror/state";
import type { Diagnostic as CmDiagnostic } from "@codemirror/lint";
import type { Diagnostic } from "../../parser/types.ts";

// Always "warning": BML recovers from every parse note by falling back to
// implicit close (§3.2.3), so nothing here blocks the user (§7.3).
export function toCmDiagnostics(
  doc: Text,
  diags: Diagnostic[],
): CmDiagnostic[] {
  return diags.map((d) => {
    const line = doc.line(Math.min(Math.max(d.line, 1), doc.lines));
    return {
      from: line.from,
      to: line.to,
      severity: "warning" as const,
      message: d.message,
    };
  });
}
