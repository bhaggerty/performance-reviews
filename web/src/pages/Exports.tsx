import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api, exportUrls } from '../api';
import type { Employee } from '../types';

export function Exports() {
  const { cycleId } = useParams<{ cycleId: string }>();
  const [employees, setEmployees] = useState<Employee[]>([]);
  const [selectedEmployee, setSelectedEmployee] = useState('');
  const [actorId, setActorId] = useState('');

  useEffect(() => {
    api
      .listEmployees()
      .then((r) => setEmployees(r.employees))
      .catch(() => undefined);
  }, []);

  if (!cycleId) return null;

  return (
    <div>
      <p>
        <Link to={`/cycles/${cycleId}`}>&larr; Cycle</Link>
      </p>
      <h1>Exports</h1>

      <div className="card">
        <div className="section-title">Cycle reports (CSV)</div>
        <div className="toolbar">
          <a className="btn" href={exportUrls.completionReport(cycleId)}>
            Completion report
          </a>
          <a className="btn" href={exportUrls.reviewStatus(cycleId)}>
            Review status
          </a>
          <a className="btn" href={exportUrls.upwardFeedbackAdmin(cycleId)}>
            Upward feedback (admin)
          </a>
        </div>
      </div>

      <div className="card">
        <div className="section-title">Directory-wide exports</div>
        <div className="toolbar">
          <a className="btn" href={exportUrls.employeeDirectory()}>
            Employee directory (CSV)
          </a>
        </div>
      </div>

      <div className="card">
        <div className="section-title">Employee final packet (JSON)</div>
        <div className="toolbar">
          <select
            value={selectedEmployee}
            onChange={(e) => setSelectedEmployee(e.target.value)}
            aria-label="Select employee"
          >
            <option value="">Select an employee…</option>
            {employees.map((e) => (
              <option key={e.id} value={e.id}>
                {e.name}
              </option>
            ))}
          </select>
          <a
            className="btn"
            href={selectedEmployee ? exportUrls.finalPacket(selectedEmployee) : undefined}
            aria-disabled={!selectedEmployee}
            onClick={(e) => {
              if (!selectedEmployee) e.preventDefault();
            }}
          >
            View final packet
          </a>
        </div>
      </div>

      <div className="card">
        <div className="section-title">Audit report (CSV)</div>
        <div className="toolbar">
          <input
            type="text"
            placeholder="Filter by actor id (optional)"
            value={actorId}
            onChange={(e) => setActorId(e.target.value)}
            style={{ maxWidth: 260 }}
          />
          <a className="btn" href={exportUrls.auditReport(actorId || undefined)}>
            Download audit report
          </a>
        </div>
      </div>
    </div>
  );
}
