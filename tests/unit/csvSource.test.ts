import { describe, it, expect } from 'vitest';
import { CsvEmployeeDirectorySource } from '../../src/services/directoryImport/csvSource';

describe('CsvEmployeeDirectorySource', () => {
  const source = new CsvEmployeeDirectorySource();

  it('parses a simple CSV and normalizes email/manager_email to lowercase, trimmed', () => {
    const csv =
      'name,email,manager_email,department,status\n' +
      '  Ada Lovelace  , ADA@Example.com , boss@example.com ,Eng,active\n';
    const rows = source.fetchRows(csv);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      name: 'Ada Lovelace',
      email: 'ada@example.com',
      manager_email: 'boss@example.com',
      department: 'Eng',
      status: 'active',
    });
  });

  it('defaults status to active when the column is missing/blank', () => {
    const csv = 'name,email\nBob,bob@example.com\n';
    const rows = source.fetchRows(csv);
    expect(rows[0].status).toBe('active');
  });

  it('falls back to active for an invalid status value', () => {
    const csv = 'name,email,status\nBob,bob@example.com,onboarding\n';
    const rows = source.fetchRows(csv);
    expect(rows[0].status).toBe('active');
  });

  it('accepts a genuine "inactive" status', () => {
    const csv = 'name,email,status\nBob,bob@example.com,inactive\n';
    const rows = source.fetchRows(csv);
    expect(rows[0].status).toBe('inactive');
  });

  it('strips a UTF-8 BOM before parsing', () => {
    const csv = '﻿name,email\nCarol,carol@example.com\n';
    const rows = source.fetchRows(csv);
    expect(rows).toHaveLength(1);
    expect(rows[0].name).toBe('Carol');
  });

  it('accepts a Buffer input', () => {
    const rows = source.fetchRows(Buffer.from('name,email\nDan,dan@example.com\n', 'utf-8'));
    expect(rows[0].email).toBe('dan@example.com');
  });

  it('accepts a { data: string } wrapper', () => {
    const rows = source.fetchRows({ data: 'name,email\nEve,eve@example.com\n' });
    expect(rows[0].email).toBe('eve@example.com');
  });

  it('rejects a payload it cannot interpret as text', () => {
    expect(() => source.fetchRows({ nope: true })).toThrow(/raw text\/csv body/);
  });

  it('captures an optional slack_id column when present', () => {
    const csv = 'name,email,slack_id\nFred,fred@example.com,U123ABC\n';
    const rows = source.fetchRows(csv);
    expect(rows[0].slack_id).toBe('U123ABC');
  });

  it('rejects a CSV over the 2MB upload limit', () => {
    const bigValue = 'x'.repeat(3 * 1024 * 1024);
    const csv = `name,email,notes\nBig,big@example.com,${bigValue}\n`;
    expect(() => source.fetchRows(csv)).toThrow(/2MB upload limit/);
  });

  it('does not crash on non-CSV garbage text — it either parses leniently or throws a clear Error', () => {
    const garbage = 'this is not a csv file at all\njust some prose\nwith random text';
    try {
      const rows = source.fetchRows(garbage);
      expect(Array.isArray(rows)).toBe(true);
    } catch (error) {
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toMatch(/Could not parse CSV/);
    }
  });
});
