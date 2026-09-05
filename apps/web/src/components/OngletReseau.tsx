import { useCallback, useEffect, useState } from 'react';
import type {
  EtatHorloge,
  ReglagesReseau,
  ReglagesReseauResponse,
  ResultatTestDns,
  ResultatTestNtp,
} from '@voxecho/shared';
import { ApiError, api } from '../api/client';
import { Aide } from './Aide';
import { formatHorodatage } from '../lib/format';

/** Fuseaux proposés. La saisie libre reste possible : l'api valide. */
const FUSEAUX = [
  'Africa/Douala',
  'Africa/Abidjan',
  'Africa/Lagos',
  'Africa/Libreville',
  'Africa/Kinshasa',
  'Europe/Paris',
  'UTC',
];

/**
 * Onglet Réseau des réglages d'instance — CLAUDE.md §9.36.
 *
 * Quatre sections dans l'ordre où elles engagent : l'heure, dont dépend la
 * valeur probante de tout le reste ; le temps et les noms, réglés hors du
 * produit sur un boîtier ; les relais, qui décident de l'adresse inscrite au
 * journal d'audit.
 */
export function OngletReseau() {
  const [donnees, setDonnees] = useState<ReglagesReseauResponse | null>(null);
  const [saisie, setSaisie] = useState<ReglagesReseau | null>(null);
  const [erreur, setErreur] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [envoi, setEnvoi] = useState(false);
  const [testsNtp, setTestsNtp] = useState<ResultatTestNtp[] | null>(null);
  const [testsDns, setTestsDns] = useState<ResultatTestDns[] | null>(null);

  const charger = useCallback(async () => {
    try {
      const valeur = await api.reglagesReseau();
      setDonnees(valeur);
      setSaisie(valeur.reglages);
      setErreur(null);
    } catch (e) {
      setErreur(e instanceof ApiError ? e.message : 'Le service est momentanément indisponible.');
    }
  }, []);

  useEffect(() => {
    void charger();
  }, [charger]);

  // L'horloge est un constat, pas un réglage : elle se rafraîchit toute seule.
  useEffect(() => {
    const minuterie = setInterval(() => {
      void api
        .horloge()
        .then((etat) => setDonnees((actuel) => (actuel ? { ...actuel, etatHorloge: etat } : actuel)))
        .catch(() => undefined);
    }, 60_000);
    return () => clearInterval(minuterie);
  }, []);

  async function enregistrer(): Promise<void> {
    if (saisie === null || donnees === null) return;
    setEnvoi(true);
    setErreur(null);
    setMessage(null);
    try {
      const apres = await api.definirReglagesReseau({
        reglages: saisie,
        version: donnees.version,
      });
      setDonnees(apres);
      setSaisie(apres.reglages);
      setMessage('Réglages enregistrés. Le changement est inscrit au journal d’audit.');
    } catch (e) {
      setErreur(e instanceof ApiError ? e.message : 'Le changement n’a pas été enregistré.');
    } finally {
      setEnvoi(false);
    }
  }

  if (donnees === null || saisie === null) {
    return erreur === null ? (
      <p className="text-sm text-ardoise-600">Chargement des réglages réseau…</p>
    ) : (
      <p role="alert" className="rounded border border-red-200 bg-red-50 p-4 text-sm text-red-800">
        {erreur}
      </p>
    );
  }

  const onprem = donnees.mode === 'onprem';

  return (
    <div className="space-y-6">
      {message !== null && (
        <p
          role="status"
          className="rounded border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-900"
        >
          {message}
        </p>
      )}
      {erreur !== null && (
        <p
          role="alert"
          className="rounded border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800"
        >
          {erreur}
        </p>
      )}

      <section aria-labelledby="heure" className="rounded border border-ardoise-200 bg-white p-4">
        <h3 id="heure" className="mb-3 text-sm font-semibold">
          Fuseau horaire et heure
        </h3>

        <label className="block text-xs font-medium text-ardoise-700" htmlFor="fuseau">
          Fuseau d’affichage
          <Aide texte="Le fuseau dans lequel le portail présente toutes ses dates. La base, elle, écrit toujours en UTC." />
        </label>
        <input
          id="fuseau"
          list="fuseaux"
          value={saisie.fuseau}
          onChange={(e) => setSaisie({ ...saisie, fuseau: e.target.value })}
          className="mt-1 w-72 rounded border border-ardoise-300 px-2 py-1 text-sm"
        />
        <datalist id="fuseaux">
          {FUSEAUX.map((zone) => (
            <option key={zone} value={zone} />
          ))}
        </datalist>

        <EtatHorlogeBloc etat={donnees.etatHorloge} />
      </section>

      <section aria-labelledby="ntp" className="rounded border border-ardoise-200 bg-white p-4">
        <h3 id="ntp" className="mb-3 text-sm font-semibold">
          Serveurs de temps
        </h3>
        {!onprem ? (
          <p className="text-sm text-ardoise-600">
            Synchronisation fournie par Amazon Time Sync.
            <Aide texte="Sur une instance en nuage, l’heure est tenue par l’hébergeur : il n’y a pas de serveur à déclarer." />
          </p>
        ) : (
          <>
            <p className="mb-2 rounded border border-ardoise-200 bg-ardoise-50 px-3 py-2 text-xs text-ardoise-700">
              Configuré à l’installation du boîtier — contactez le support pour modifier. La valeur
              saisie ici est conservée et affichée, elle n’est pas appliquée.
            </p>
            {[0, 1, 2].map((rang) => (
              <div key={rang} className="mt-2">
                <label
                  className="block text-xs font-medium text-ardoise-700"
                  htmlFor={`ntp-${rang}`}
                >
                  Serveur {rang + 1}
                </label>
                <input
                  id={`ntp-${rang}`}
                  value={saisie.ntp.serveurs[rang] ?? ''}
                  placeholder="ntp.camtel.cm"
                  onChange={(e) => {
                    const serveurs = [0, 1, 2].map((i) =>
                      i === rang ? e.target.value : (saisie.ntp.serveurs[i] ?? ''),
                    );
                    setSaisie({ ...saisie, ntp: { ...saisie.ntp, serveurs } });
                  }}
                  className="mt-1 w-72 rounded border border-ardoise-300 px-2 py-1 text-sm"
                />
              </div>
            ))}
            <Tester
              libelle="Tester les serveurs de temps"
              onTester={() => api.testerNtp().then(setTestsNtp)}
              onErreur={setErreur}
            />
            {testsNtp !== null && (
              <ul className="mt-2 space-y-1 text-xs">
                {testsNtp.length === 0 && <li className="text-ardoise-600">Aucun serveur déclaré.</li>}
                {testsNtp.map((test) => (
                  <li key={test.serveur} className={test.joignable ? 'text-emerald-800' : 'text-red-800'}>
                    {test.serveur} — {test.message}
                  </li>
                ))}
              </ul>
            )}
          </>
        )}
      </section>

      <section aria-labelledby="dns" className="rounded border border-ardoise-200 bg-white p-4">
        <h3 id="dns" className="mb-3 text-sm font-semibold">
          Résolution de noms
        </h3>
        {!onprem ? (
          <p className="text-sm text-ardoise-600">
            Résolveur fourni par AWS.
            <Aide texte="Sur une instance en nuage, la résolution de noms est celle du réseau de l’hébergeur." />
          </p>
        ) : (
          <>
            <p className="mb-2 rounded border border-ardoise-200 bg-ardoise-50 px-3 py-2 text-xs text-ardoise-700">
              Configuré à l’installation du boîtier — contactez le support pour modifier.
            </p>
            <Champ
              id="dns-primaire"
              libelle="Résolveur primaire"
              valeur={saisie.dns.primaire}
              onChange={(v) => setSaisie({ ...saisie, dns: { ...saisie.dns, primaire: v } })}
            />
            <Champ
              id="dns-secondaire"
              libelle="Résolveur secondaire"
              valeur={saisie.dns.secondaire}
              onChange={(v) => setSaisie({ ...saisie, dns: { ...saisie.dns, secondaire: v } })}
            />
            <Champ
              id="dns-recherche"
              libelle="Domaine de recherche"
              valeur={saisie.dns.domaineRecherche}
              onChange={(v) => setSaisie({ ...saisie, dns: { ...saisie.dns, domaineRecherche: v } })}
            />
            <Tester
              libelle="Tester la résolution"
              onTester={() => api.testerDns().then(setTestsDns)}
              onErreur={setErreur}
            />
            {testsDns !== null && (
              <ul className="mt-2 space-y-1 text-xs">
                {testsDns.length === 0 && (
                  <li className="text-ardoise-600">
                    Aucun nom à résoudre : ni annuaire ni serveur de courriel n’est déclaré.
                  </li>
                )}
                {testsDns.map((test) => (
                  <li key={test.cible} className={test.resolu ? 'text-emerald-800' : 'text-red-800'}>
                    {test.usage} — {test.cible} : {test.message}
                  </li>
                ))}
              </ul>
            )}
          </>
        )}
      </section>

      <section aria-labelledby="proxys" className="rounded border border-ardoise-200 bg-white p-4">
        <h3 id="proxys" className="mb-3 text-sm font-semibold">
          Relais de confiance
          <Aide texte="Relais dont l’en-tête X-Forwarded-For est cru. C’est ce qui décide de l’adresse inscrite au journal d’audit : un relais de trop, et n’importe qui choisit l’adresse inscrite à son nom." />
        </h3>

        <label className="block text-xs font-medium text-ardoise-700" htmlFor="proxys-cidr">
          Adresses ou plages, une par ligne
        </label>
        <textarea
          id="proxys-cidr"
          rows={3}
          value={saisie.proxys.cidr.join('\n')}
          placeholder="172.20.0.0/16"
          onChange={(e) =>
            setSaisie({
              ...saisie,
              proxys: { cidr: e.target.value.split('\n').map((l) => l.trim()).filter((l) => l !== '') },
            })
          }
          className="mt-1 w-full rounded border border-ardoise-300 px-2 py-1 font-mono text-sm"
        />

        <p className="mt-2 text-xs text-ardoise-700">
          {donnees.proxysEnVigueur.source === 'environnement' ? (
            <>
              <span className="font-medium">En vigueur : la variable d’environnement</span> (
              {donnees.proxysEnVigueur.valeurs.join(', ')}). La valeur saisie ici est conservée mais
              ne s’applique pas.
              <Aide texte="L’environnement l’emporte : un administrateur ne doit pas pouvoir fausser depuis l’interface l’adresse inscrite au journal d’audit." />
            </>
          ) : (
            <>
              En vigueur : la valeur saisie ici.
              {donnees.proxysEnVigueur.valeurs.length === 0 && ' Aucun relais déclaré — l’api ne croit que sa socket.'}
            </>
          )}
        </p>
      </section>

      <div className="flex items-center gap-3">
        <button
          type="button"
          disabled={envoi}
          onClick={() => void enregistrer()}
          className="rounded bg-ardoise-800 px-3 py-1.5 text-sm text-white disabled:opacity-50"
        >
          {envoi ? 'Enregistrement…' : 'Enregistrer'}
        </button>
        {donnees.updatedAt !== null && (
          <span className="text-xs text-ardoise-600">
            Dernière modification le {formatHorodatage(donnees.updatedAt)} par{' '}
            {donnees.updatedByEmail ?? '—'} (version {donnees.version}).
          </span>
        )}
      </div>
    </div>
  );
}

/** Le bloc d'état, en lecture seule : c'est un constat, pas un réglage. */
function EtatHorlogeBloc({ etat }: { etat: EtatHorloge }) {
  const teintes: Record<string, string> = {
    synchronise: 'border-emerald-300 bg-emerald-50 text-emerald-900',
    derive: 'border-amber-300 bg-amber-50 text-amber-900',
    non_synchronise: 'border-red-300 bg-red-50 text-red-900',
    indisponible: 'border-amber-300 bg-amber-50 text-amber-900',
  };
  const libelles: Record<string, string> = {
    synchronise: 'Synchronisée',
    derive: 'Dérive',
    non_synchronise: 'Non synchronisée',
    indisponible: 'État indisponible',
  };

  return (
    <div className={`mt-4 rounded border px-3 py-2 text-sm ${teintes[etat.statut] ?? ''}`}>
      <p className="font-medium">État de l’horloge : {libelles[etat.statut] ?? etat.statut}</p>
      <p className="mt-1 text-xs">{etat.message}</p>
      <dl className="mt-2 grid grid-cols-2 gap-x-6 gap-y-1 text-xs sm:grid-cols-4">
        <Releve intitule="Source" valeur={etat.source ?? '—'} />
        <Releve
          intitule="Décalage"
          valeur={etat.decalageMs === null ? '—' : `${etat.decalageMs} ms`}
        />
        <Releve intitule="Stratum" valeur={etat.stratum === null ? '—' : String(etat.stratum)} />
        <Releve
          intitule="Dernière synchronisation"
          valeur={etat.derniereSynchro === null ? '—' : formatHorodatage(etat.derniereSynchro)}
        />
      </dl>
    </div>
  );
}

function Releve({ intitule, valeur }: { intitule: string; valeur: string }) {
  return (
    <div>
      <dt className="uppercase tracking-wide opacity-70">{intitule}</dt>
      <dd className="tabular-nums">{valeur}</dd>
    </div>
  );
}

function Champ({
  id,
  libelle,
  valeur,
  onChange,
}: {
  id: string;
  libelle: string;
  valeur: string | null;
  onChange: (valeur: string) => void;
}) {
  return (
    <div className="mt-2">
      <label className="block text-xs font-medium text-ardoise-700" htmlFor={id}>
        {libelle}
      </label>
      <input
        id={id}
        value={valeur ?? ''}
        onChange={(e) => onChange(e.target.value)}
        className="mt-1 w-72 rounded border border-ardoise-300 px-2 py-1 text-sm"
      />
    </div>
  );
}

/** Un bouton de test : le résultat s'inscrit au journal, réussite ou non. */
function Tester({
  libelle,
  onTester,
  onErreur,
}: {
  libelle: string;
  onTester: () => Promise<unknown>;
  onErreur: (message: string) => void;
}) {
  const [encours, setEnCours] = useState(false);
  return (
    <button
      type="button"
      disabled={encours}
      onClick={() => {
        setEnCours(true);
        onTester()
          .catch((e: unknown) =>
            onErreur(e instanceof ApiError ? e.message : 'Le test n’a pas pu être mené.'),
          )
          .finally(() => setEnCours(false));
      }}
      className="mt-3 rounded border border-ardoise-300 px-3 py-1 text-sm hover:bg-ardoise-50 disabled:opacity-60"
    >
      {encours ? 'Test en cours…' : libelle}
    </button>
  );
}
