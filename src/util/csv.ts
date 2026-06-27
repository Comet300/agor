/**
 * Minimal, dependency-free CSV serialization (RFC-4180-ish).
 *
 * A field is quoted only when it needs to be (contains a comma, quote, or
 * newline); embedded quotes are doubled. Good enough for a spreadsheet export.
 */

/** Escape one field: quote when it contains a comma/quote/newline. */
function escapeField(value: string): string {
  if (/[",\n\r]/.test(value)) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

/**
 * Build a CSV document from `headers` (column keys) and `rows` (objects keyed by
 * those headers). Missing/undefined cells become empty; everything is coerced to
 * a string. Rows are CRLF-terminated. Pure.
 */
export function toCsv(headers: readonly string[], rows: ReadonlyArray<Record<string, unknown>>): string {
  const line = (cells: readonly string[]): string => cells.map(escapeField).join(',');
  const out: string[] = [line(headers)];
  for (const row of rows) {
    out.push(line(headers.map((h) => {
      const v = row[h];
      return v === undefined || v === null ? '' : String(v);
    })));
  }
  return out.join('\r\n');
}
