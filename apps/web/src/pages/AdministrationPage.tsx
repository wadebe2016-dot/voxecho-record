import { useEffect, useState } from 'react';
import type { InstanceSettingsResponse } from '@voxecho/shared';
import { ApiError, api } from '../api/client';
import { useAuth } from '../auth/auth-context';
import { Aide } from '../components/Aide';
import { OngletReseau } from '../components/OngletReseau';

/**
 * Console d'administration, écran des réglages — CLAUDE.md §9.22.
 *
 * L'écran ne change rien, il montre. Ce qu'un réglage commande, et pourquoi
 * certains ne se modifient pas ici, se lisent au survol de l'icône d'aide
 * plutôt qu'en paragraphes : le détail complet est au manuel (§9.24).
 */
/**
 * Onglets des réglages d'instance — CLAUDE.md §9.36. Ils se rempliront lot par
 * lot ; celui qui n'existe pas encore n'est pas affiché en grisé, il n'est pas
 * affiché du tout.
 */
const ONGLETS = [
  { cle: 'general', libelle: 'Général' },
  { cle: 'reseau', libelle: 'Réseau' },
] as const;

type CleOnglet = (typeof ONGLETS)[number]['cle'];

export function AdministrationPage() {
  const { profil } = useAuth();
  const [onglet, setOnglet] = useState<CleOnglet>('general');
  const [reglages, setReglages] = useState<InstanceSettingsResponse | null>(null);
  const [erreur, setErreur] = useState<string | null>(null);
  const [chargement, setChargement] = useState(true);

  useEffect(() => {
    let vivant = true;
    void api
      .reglagesInstance()
      .then((valeur) => {
        if (vivant) setReglages(valeur);
      })
      .catch((e: unknown) => {
        if (vivant) {
          setErreur(
            e instanceof ApiError ? e.message : 'Le service est momentanément indisponible.',
          );
        }
      })
      .finally(() => {
        if (vivant) setChargement(false);
      });
    return () => {
      vivant = false;
    };
  }, []);

  if (profil?.instanceAdmin !== true) {
    // Le masquage de la navigation suffit en temps normal ; ce garde couvre
    // l'accès direct par l'url. L'api refuse de toute façon (§9.9).
    return (
      <p className="rounded border border-ardoise-200 bg-white p-4 text-sm text-ardoise-600">
        Réservé aux administrateurs de l’instance.
        <Aide texte="Administrer un locataire et administrer l’instance qui l’héberge sont deux habilitations distinctes. Ce n’est pas une panne." />
      </p>
    );
  }

  if (chargement && onglet === 'general') {
    return <p className="text-sm text-ardoise-600">Chargement des réglages…</p>;
  }
  if (erreur !== null) {
    return (
      <p role="alert" className="rounded border border-red-200 bg-red-50 p-4 text-sm text-red-800">
        {erreur}
      </p>
    );
  }
  if (!reglages) return null;

  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-lg font-semibold tracking-tight">Administration de l’instance</h1>
        <p className="mt-1 text-sm text-ardoise-600">
          Version {reglages.version}
          {reglages.evaluation ? ' · version d’évaluation' : ''}
          <Aide texte="Ces réglages valent pour tous les locataires servis par cette instance." />
        </p>
      </header>

      <div className="flex gap-1 border-b border-ardoise-200" role="tablist">
        {ONGLETS.map((entree) => (
          <button
            key={entree.cle}
            type="button"
            role="tab"
            aria-selected={onglet === entree.cle}
            onClick={() => setOnglet(entree.cle)}
            className={`-mb-px border-b-2 px-3 py-1.5 text-sm ${
              onglet === entree.cle
                ? 'border-ardoise-800 font-medium text-ardoise-900'
                : 'border-transparent text-ardoise-600 hover:text-ardoise-900'
            }`}
          >
            {entree.libelle}
          </button>
        ))}
      </div>

      {onglet === 'reseau' && <OngletReseau />}
      {onglet === 'general' && (
        <>

      <section aria-labelledby="locataires">
        <h2 id="locataires" className="mb-2 text-sm font-semibold">
          Locataires
        </h2>
        <table className="w-full border border-ardoise-200 bg-white text-sm">
          <thead className="bg-ardoise-50 text-left text-xs uppercase tracking-wide text-ardoise-600">
            <tr>
              <th className="px-3 py-2 font-medium">Nom</th>
              <th className="px-3 py-2 font-medium">Répertoire d’ingestion</th>
              <th className="px-3 py-2 font-medium">État</th>
              <th className="px-3 py-2 text-right font-medium">Comptes</th>
              <th className="px-3 py-2 text-right font-medium">Appels</th>
            </tr>
          </thead>
          <tbody>
            {reglages.locataires.map((locataire) => (
              <tr key={locataire.id} className="border-t border-ardoise-100">
                <td className="px-3 py-2">{locataire.nom}</td>
                <td className="px-3 py-2 font-mono text-xs text-ardoise-600">{locataire.slug}</td>
                <td className="px-3 py-2">
                  {locataire.actif ? (
                    'actif'
                  ) : (
                    <span className="text-amber-700">
                      désactivé — ses dépôts partent en quarantaine
                    </span>
                  )}
                </td>
                <td className="px-3 py-2 text-right tabular-nums">{locataire.comptes}</td>
                <td className="px-3 py-2 text-right tabular-nums">{locataire.enregistrements}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      {reglages.groupes.map((groupe) => (
        <section key={groupe.titre} aria-labelledby={`groupe-${groupe.titre}`}>
          <h2 id={`groupe-${groupe.titre}`} className="mb-2 text-sm font-semibold">
            {groupe.titre}
          </h2>
          <dl className="divide-y divide-ardoise-100 border border-ardoise-200 bg-white">
            {groupe.reglages.map((reglage) => (
              <div key={reglage.cle} className="flex flex-wrap items-baseline gap-x-3 px-3 py-2">
                <dt className="font-mono text-xs text-ardoise-600">
                  {reglage.cle}
                  <Aide
                    texte={
                      reglage.raisonLectureSeule === undefined
                        ? reglage.effet
                        : `${reglage.effet} — Non modifiable ici : ${reglage.raisonLectureSeule}`
                    }
                  />
                </dt>
                <dd className="text-sm font-medium">{reglage.valeur}</dd>
                {reglage.raisonLectureSeule !== undefined && (
                  <dd className="text-xs text-ardoise-400">lecture seule</dd>
                )}
              </div>
            ))}
          </dl>
        </section>
      ))}
        </>
      )}
    </div>
  );
}
