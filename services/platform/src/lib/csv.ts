// CSV for the audit export. Every cell is quoted, inner quotes are doubled, and a cell that a
// spreadsheet would read as a formula (starting with = + - @ tab or carriage return) gets a leading
// apostrophe. Tool names, error texts and upstream messages are chosen by clients and servers, so
// "=HYPERLINK(...)" must stay text when an admin opens the file in Excel or Sheets.
export function csvCell(v: unknown): string {
  let s = v === null || v === undefined ? '' : v instanceof Date ? v.toISOString() : String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return `"${s.replace(/"/g, '""')}"`;
}
export const csvRow = (cells: unknown[]) => `${cells.map(csvCell).join(',')}\r\n`;
