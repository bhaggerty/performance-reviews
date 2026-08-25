import { NavLink, Outlet, useNavigate } from 'react-router-dom';
import { useAuth } from '../AuthContext';

const NAV_ITEMS = [
  { to: '/', label: 'Dashboard', end: true },
  { to: '/directory', label: 'Employee Directory' },
  { to: '/cycles', label: 'Cycle Management' },
  { to: '/audit', label: 'Audit' },
  { to: '/operations', label: 'Operations' },
];

export function Layout() {
  const { me, refresh } = useAuth();
  const navigate = useNavigate();

  const handleLogout = async () => {
    try {
      await fetch('/auth/logout', {
        method: 'POST',
        credentials: 'include',
        headers: {
          'X-CSRF-Token':
            document.cookie.match(/(?:^|; )pr_csrf=([^;]*)/)?.[1] ?? '',
        },
      });
    } finally {
      await refresh();
      navigate('/');
    }
  };

  return (
    <div className="app-shell">
      <nav className="app-nav" aria-label="Main navigation">
        <div className="app-brand">
          <span className="accent">C1</span>
          <span>People Console</span>
        </div>
        {NAV_ITEMS.map((item) => (
          <NavLink
            key={item.to}
            to={item.to}
            end={item.end}
            className={({ isActive }) => (isActive ? 'active' : '')}
          >
            {item.label}
          </NavLink>
        ))}
        <div className="user-info">
          {me && (
            <>
              <div>{me.employee.name}</div>
              <div>{me.employee.email}</div>
              <button className="btn btn-sm" style={{ marginTop: 8 }} onClick={handleLogout}>
                Sign out
              </button>
            </>
          )}
        </div>
      </nav>
      <main className="app-main">
        <Outlet />
      </main>
    </div>
  );
}
