import { useAuth } from '../AuthContext';

export function NotAuthorized() {
  const { me, refresh } = useAuth();

  const handleLogout = async () => {
    await fetch('/auth/logout', {
      method: 'POST',
      credentials: 'include',
      headers: {
        'X-CSRF-Token': document.cookie.match(/(?:^|; )pr_csrf=([^;]*)/)?.[1] ?? '',
      },
    });
    await refresh();
  };

  return (
    <div className="login-page">
      <div className="login-card">
        <div className="app-brand">
          <span className="accent">C1</span>
          <span>People Console</span>
        </div>
        <h3>Not authorized</h3>
        <p className="text-muted">
          {me ? `Signed in as ${me.employee.email}, but this` : 'This'} account is not a People
          admin. Ask a People admin to grant access if you believe this is a mistake.
        </p>
        <button className="btn" style={{ width: '100%' }} onClick={handleLogout}>
          Sign out
        </button>
      </div>
    </div>
  );
}
