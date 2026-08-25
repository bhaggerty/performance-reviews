import { parse } from 'csv-parse/sync';
import type { DirectoryRow, EmployeeDirectorySource } from './types';

const MAX_CSV_BYTES = 2 * 1024 * 1024; // 2MB
const ALLOWED_STATUSES = new Set(['active', 'inactive']);

function cell(row: Record<string, string>, ...keys: string[]): string {
  for (const key of keys) {
    if (row[key] !== undefined) return String(row[key]).trim();
  }
  return '';
}

/**
 * CSV employee-directory source. Verifies actual content (not filename/MIME type), enforces a
 * size limit, and normalizes every row. Column validation (duplicates, unknown managers, self-
 * management, cycles) happens in the importer, which works against any EmployeeDirectorySource.
 */
export class CsvEmployeeDirectorySource implements EmployeeDirectorySource {
  readonly name = 'csv';

  fetchRows(raw: unknown): DirectoryRow[] {
    const text = this.toText(raw);
    if (Buffer.byteLength(text, 'utf-8') > MAX_CSV_BYTES) {
      throw new Error(`CSV exceeds the ${MAX_CSV_BYTES / (1024 * 1024)}MB upload limit.`);
    }

    let records: Record<string, string>[];
    try {
      records = parse(text, { columns: true, skip_empty_lines: true, trim: true, bom: true });
    } catch (error) {
      throw new Error(`Could not parse CSV: ${error instanceof Error ? error.message : String(error)}`);
    }

    return records.map((row) => {
      const statusRaw = cell(row, 'status', 'Status').toLowerCase() || 'active';
      const status = ALLOWED_STATUSES.has(statusRaw) ? (statusRaw as 'active' | 'inactive') : 'active';
      return {
        name: cell(row, 'name', 'Name'),
        email: cell(row, 'email', 'Email').toLowerCase(),
        manager_email: cell(row, 'manager_email', 'Manager_Email', 'Manager Email').toLowerCase(),
        department: cell(row, 'department', 'Department'),
        status,
        slack_id: cell(row, 'slack_id', 'Slack_ID', 'Slack ID') || undefined,
      };
    });
  }

  private toText(raw: unknown): string {
    if (typeof raw === 'string') return raw;
    if (Buffer.isBuffer(raw)) return raw.toString('utf-8');
    if (raw && typeof raw === 'object' && 'data' in raw) {
      const data = raw.data;
      return typeof data === 'string' ? data : Buffer.from(data as Uint8Array).toString('utf-8');
    }
    throw new Error('Send CSV as a raw text/csv body or { "data": "csv string" }.');
  }
}
