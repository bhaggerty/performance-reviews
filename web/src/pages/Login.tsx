export function Login() {
  return (
    <div className="login-page">
      <div className="login-card">
        <div className="app-brand">
          <span className="accent">C1</span>
          <span>People Console</span>
        </div>
        <p className="text-muted">
          Sign in with your workspace Slack account to manage performance review cycles.
        </p>
        <a className="btn btn-primary" href="/auth/slack/login" style={{ width: '100%', justifyContent: 'center', marginTop: 12 }}>
          Sign in with Slack
        </a>
      </div>
    </div>
  );
}
