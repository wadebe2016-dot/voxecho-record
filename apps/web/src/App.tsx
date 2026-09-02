import { Navigate, Route, Routes } from 'react-router-dom';
import { AppShell } from './components/AppShell';
import { AuthProvider } from './auth/AuthProvider';
import { useAuth } from './auth/auth-context';
import { LoginPage } from './pages/LoginPage';
import { RecordingsPage } from './pages/RecordingsPage';

export function App() {
  return (
    <AuthProvider>
      <Routes>
        <Route path="/*" element={<Portail />} />
      </Routes>
    </AuthProvider>
  );
}

function Portail() {
  const { profil, chargement } = useAuth();

  if (chargement) {
    return (
      <main className="flex min-h-full items-center justify-center text-sm text-ardoise-600">
        Ouverture de la session…
      </main>
    );
  }

  if (!profil) {
    return <LoginPage />;
  }

  return (
    <AppShell>
      <Routes>
        <Route path="/enregistrements" element={<RecordingsPage />} />
        <Route path="*" element={<Navigate to="/enregistrements" replace />} />
      </Routes>
    </AppShell>
  );
}
