import { Navigate, Route, Routes } from 'react-router-dom';
import { AppShell } from './components/AppShell';
import { AuthProvider } from './auth/AuthProvider';
import { useAuth } from './auth/auth-context';
import { JournalPage } from './pages/JournalPage';
import { LoginPage } from './pages/LoginPage';
import { RecordingsPage } from './pages/RecordingsPage';
import { TableauDeBordPage } from './pages/TableauDeBordPage';
import { AdministrationPage } from './pages/AdministrationPage';
import { ComptesPage } from './pages/ComptesPage';
import { MotDePassePage } from './pages/MotDePassePage';
import { PolitiquesPage } from './pages/PolitiquesPage';
import { ConservationPage } from './pages/ConservationPage';
import { PurgePage } from './pages/PurgePage';

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

  // Mot de passe provisoire : aucun autre écran n'est atteignable. L'api le
  // refuse de toute façon (§9.26) ; le portail évite d'y conduire.
  if (profil.mustChangePassword) {
    return <MotDePassePage />;
  }

  return (
    <AppShell>
      <Routes>
        <Route path="/tableau-de-bord" element={<TableauDeBordPage />} />
        <Route path="/enregistrements" element={<RecordingsPage />} />
        <Route path="/journal" element={<JournalPage />} />
        <Route path="/politiques" element={<PolitiquesPage />} />
        <Route path="/comptes" element={<ComptesPage />} />
        <Route path="/conservation" element={<ConservationPage />} />
        <Route path="/purge" element={<PurgePage />} />
        <Route path="/administration" element={<AdministrationPage />} />
        <Route path="*" element={<Navigate to="/enregistrements" replace />} />
      </Routes>
    </AppShell>
  );
}
