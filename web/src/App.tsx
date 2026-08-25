import { BrowserRouter, Routes, Route, Outlet } from 'react-router-dom';
import { AuthProvider, useAuth } from './AuthContext';
import { Layout } from './components/Layout';
import { LoadingState } from './components/DataState';
import { Login } from './pages/Login';
import { NotAuthorized } from './pages/NotAuthorized';
import { Dashboard } from './pages/Dashboard';
import { Directory } from './pages/Directory';
import { Cycles } from './pages/Cycles';
import { CycleDetail } from './pages/CycleDetail';
import { ReviewQueue } from './pages/ReviewQueue';
import { ReviewDetail } from './pages/ReviewDetail';
import { AtRisk } from './pages/AtRisk';
import { UpwardFeedback } from './pages/UpwardFeedback';
import { Reminders } from './pages/Reminders';
import { Exports } from './pages/Exports';
import { Audit } from './pages/Audit';
import { Operations } from './pages/Operations';

function Gate() {
  const { loading, authenticated, me } = useAuth();

  if (loading) {
    return (
      <div className="login-page">
        <LoadingState label="Loading console…" />
      </div>
    );
  }

  if (!authenticated || !me) {
    return <Login />;
  }

  if (!me.roles.isPeopleAdmin) {
    return <NotAuthorized />;
  }

  return <Outlet />;
}

export default function App() {
  return (
    <AuthProvider>
      <BrowserRouter basename="/console">
        <Routes>
          <Route element={<Gate />}>
            <Route element={<Layout />}>
              <Route index element={<Dashboard />} />
              <Route path="directory" element={<Directory />} />
              <Route path="cycles" element={<Cycles />} />
              <Route path="cycles/:cycleId" element={<CycleDetail />} />
              <Route path="cycles/:cycleId/reviews" element={<ReviewQueue />} />
              <Route path="cycles/:cycleId/reviews/:employeeId" element={<ReviewDetail />} />
              <Route path="cycles/:cycleId/at-risk" element={<AtRisk />} />
              <Route path="cycles/:cycleId/upward-feedback" element={<UpwardFeedback />} />
              <Route path="cycles/:cycleId/reminders" element={<Reminders />} />
              <Route path="cycles/:cycleId/exports" element={<Exports />} />
              <Route path="audit" element={<Audit />} />
              <Route path="operations" element={<Operations />} />
            </Route>
          </Route>
        </Routes>
      </BrowserRouter>
    </AuthProvider>
  );
}
