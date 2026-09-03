import { useEffect, useState } from 'react';
import type { InstanceSettingsResponse } from '@voxecho/shared';
import { ApiError, api } from '../api/client';
import { useAuth } from '../auth/auth-context';

/**
 * Console d'administration, écran des réglages — CLAUDE.md §9.22.
 *
 * Premier écran de la console : il ne change rien, il montre. C'est déjà
 * beaucoup — répondre à « quelle conservation minimale impose cette
 * instance ? » ou « à quels relais fait-elle confiance ? » supposait jusqu'ici
 * d'ouvrir un fichier sur le serveur.
 *
 * Les réglages qui commandent la valeur probante du journal sont exposés avec
 * la raison pour laquelle ils ne se changent pas ici. Un écran de conformité
 * qui grise un champ sans dire pourquoi laisse croire à un défaut ; celui-ci
 * explique une décision.
 */
export function AdministrationPage() {
  const { profil } = useAuth();
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
        L’administration de l’instance est réservée à ses administrateurs. Il ne s’agit pas d’une
        panne : administrer un locataire et administrer l’instance qui l’héberge sont deux
        habilitations distinctes.
      </p>
    );
  }

  if (chargement) return <p className="text-sm text-ardoise-600">Chargement des réglages…</p>;
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
          {reglages.evaluation ? ' · version d’évaluation' : ''}. Ces réglages valent pour tous les
          locataires servis par cette instance.
        </p>
      </header>

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
              <div key={reglage.cle} className="px-3 py-2">
                <div className="flex flex-wrap items-baseline gap-x-3">
                  <dt className="font-mono text-xs text-ardoise-600">{reglage.cle}</dt>
                  <dd className="text-sm font-medium">{reglage.valeur}</dd>
                </div>
                <p className="mt-0.5 text-xs text-ardoise-600">{reglage.effet}</p>
                {reglage.raisonLectureSeule !== undefined && (
                  <p className="mt-0.5 text-xs text-ardoise-500">
                    <span className="font-medium">Non modifiable ici.</span>{' '}
                    {reglage.raisonLectureSeule}
                  </p>
                )}
              </div>
            ))}
          </dl>
        </section>
      ))}

      <p className="text-xs text-ardoise-500">
        Ces réglages se lisent ici et se changent à l’installation. Les écrans de gestion — comptes,
        conservation, politiques d’enregistrement — viennent aux lots suivants.
      </p>
    </div>
  );
}
