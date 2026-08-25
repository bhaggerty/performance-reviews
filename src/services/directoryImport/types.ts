export interface DirectoryRow {
  name: string;
  email: string;
  manager_email: string;
  department: string;
  status: 'active' | 'inactive';
  slack_id?: string;
}

/**
 * Adapter interface so a future HRIS (e.g. Rippling) can replace CSV without rewriting the
 * review system. Today only CsvEmployeeDirectorySource exists — no live Rippling integration.
 */
export interface EmployeeDirectorySource {
  name: string;
  fetchRows(raw: unknown): Promise<DirectoryRow[]> | DirectoryRow[];
}

export interface ImportIssue {
  row?: number;
  email?: string;
  message: string;
}

export interface ImportPlanRow {
  row: number;
  email: string;
  action: 'create' | 'update' | 'unchanged' | 'deactivate' | 'unresolved' | 'error';
  changes?: Record<string, { from: unknown; to: unknown }>;
  slack_resolved?: boolean;
}

export interface ImportPlan {
  rows: ImportPlanRow[];
  warnings: ImportIssue[];
  errors: ImportIssue[];
  createdCount: number;
  updatedCount: number;
  unchangedCount: number;
  deactivatedCount: number;
  unresolvedCount: number;
}
