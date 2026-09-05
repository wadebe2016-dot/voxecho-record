import { useCallback, useEffect, useState } from 'react';
import {
  ROLES,
  type RegleAnnuaire,
  type ReglagesAnnuaire,
  type ReglagesAnnuaireResponse,
  type ResultatTestAnnuaire,
  type Role,
} from '@voxecho/shared';
import { ApiError, api } from '../api/client';
import { Aide } from './Aide';
import { formatHorodatage, libelleRole } from '../lib/format';

/**
 * Onglet Annuaire — CLAUDE.md §9.37.
 *
 * L'annuaire décide qui entre et avec quel rôle, donc qui peut entendre des
 * conversations de clients. L'écran l'annonce là où il engage : le mot de passe
 * ne se lit pas, une règle absente ferme la porte, et il doit rester un
 * administrateur local.
 */
export function OngletAnnuaire() {
  const [donnees, setDonnees] = useState<ReglagesAnnuaireResponse | null>(null);
  const [saisie, setSaisie] = useState<ReglagesAnnuaire | null>(null);
  const [nouveauMotDePasse, setNouveauMotDePasse] = useState<string | null>(null);
  const [erreur, setErreur] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [envoi, setEnvoi] = useState(false);
  const [loginTest, setLoginTest] = useState('');
  const [resultat, setResultat] = useState<ResultatTestAnnuaire | null>(null);

  const charger = useCallback(async () => {
    try {
      const valeur = await api.reglagesAnnuaire();
      setDonnees(valeur);
      setSaisie(valeur.reglages);
      setNouveauMotDePasse(null);
      setErreur(null);
    } catch (e) {
      setErreur(e instanceof ApiError ? e.message : 'Le service est momentanément indisponible.');
    }
  }, []);

  useEffect(() => {
    void charger();
  }, [charger]);

  async function enregistrer(): Promise<void> {
    if (saisie === null || donnees === null) return;
    setEnvoi(true);
    setErreur(null);
    setMessage(null);
    try {
      const { bindMotDePasse: _masque, ...reste } = saisie;
      const apres = await api.definirReglagesAnnuaire({
        reglages: reste,
        version: donnees.version,
        // Le secret ne part que lorsqu'on le remplace : un champ pré-rempli
        // d'un masque finirait renvoyé tel quel, et le masque deviendrait le
        // secret.
        ...(nouveauMotDePasse === null || nouveauMotDePasse === ''
          ? {}
          : { bindMotDePasse: nouveauMotDePasse }),
      });
      setDonnees(apres);
      setSaisie(apres.reglages);
      setNouveauMotDePasse(null);
      setMessage('Réglages enregistrés. Le changement est inscrit au journal d’audit.');
    } catch (e) {
      setErreur(e instanceof ApiError ? e.message : 'Le changement n’a pas été enregistré.');
    } finally {
      setEnvoi(false);
    }
  }

  async function tester(): Promise<void> {
    setErreur(null);
    setResultat(null);
    try {
      setResultat(await api.testerAnnuaire(loginTest.trim() === '' ? undefined : loginTest.trim()));
    } catch (e) {
      setErreur(e instanceof ApiError ? e.message : 'Le test n’a pas pu être mené.');
    }
  }

  if (donnees === null || saisie === null) {
    return erreur === null ? (
      <p className="text-sm text-ardoise-600">Chargement des réglages d’annuaire…</p>
    ) : (
      <p role="alert" className="rounded border border-red-200 bg-red-50 p-4 text-sm text-red-800">
        {erreur}
      </p>
    );
  }

  const modifier = (champ: Partial<ReglagesAnnuaire>): void => setSaisie({ ...saisie, ...champ });

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

      <section aria-labelledby="connexion" className="rounded border border-ardoise-200 bg-white p-4">
        <h3 id="connexion" className="mb-3 text-sm font-semibold">
          Connexion
        </h3>

        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={saisie.actif}
            onChange={(e) => modifier({ actif: e.target.checked })}
          />
          Annuaire actif
          <Aide texte="Quand il est actif, la connexion tente l’annuaire d’abord. Les comptes locaux gardent leur porte, y compris si l’annuaire est injoignable." />
        </label>

        <div className="mt-3 grid gap-3 sm:grid-cols-2">
          <Champ
            id="ldap-url"
            libelle="URL"
            valeur={saisie.url}
            placeholder="ldaps://dc01.banque.local:636"
            onChange={(url) => modifier({ url })}
          />
          <Champ
            id="ldap-base"
            libelle="Base DN"
            valeur={saisie.baseDn}
            placeholder="DC=banque,DC=local"
            onChange={(baseDn) => modifier({ baseDn })}
          />
          <Champ
            id="ldap-bind"
            libelle="DN du compte de liaison"
            valeur={saisie.bindDn}
            placeholder="CN=svc-voxecho,OU=Services,DC=banque,DC=local"
            onChange={(bindDn) => modifier({ bindDn })}
          />
          <div>
            <label className="block text-xs font-medium text-ardoise-700" htmlFor="ldap-mdp">
              Mot de passe de liaison
              <Aide texte="Chiffré au repos et jamais rendu par l’api. Le laisser vide conserve celui qui est en place." />
            </label>
            {nouveauMotDePasse === null ? (
              <div className="mt-1 flex items-center gap-2">
                <span className="font-mono text-sm text-ardoise-600">
                  {saisie.bindMotDePasse ?? 'aucun'}
                </span>
                <button
                  type="button"
                  onClick={() => setNouveauMotDePasse('')}
                  className="rounded border border-ardoise-300 px-2 py-0.5 text-xs hover:bg-ardoise-50"
                >
                  Remplacer
                </button>
              </div>
            ) : (
              <input
                id="ldap-mdp"
                type="password"
                autoComplete="new-password"
                value={nouveauMotDePasse}
                onChange={(e) => setNouveauMotDePasse(e.target.value)}
                className="mt-1 w-full rounded border border-ardoise-300 px-2 py-1 text-sm"
              />
            )}
          </div>
        </div>

        <div className="mt-3 flex flex-wrap gap-4">
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={saisie.startTls}
              onChange={(e) => modifier({ startTls: e.target.checked })}
            />
            StartTLS
          </label>
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={saisie.verifierCertificat}
              onChange={(e) => modifier({ verifierCertificat: e.target.checked })}
            />
            Valider le certificat
            <Aide texte="Décocher n’a de sens qu’en laboratoire : le produit accepterait alors n’importe quel serveur se présentant comme l’annuaire." />
          </label>
        </div>
        {!saisie.verifierCertificat && (
          <p className="mt-2 rounded border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-900">
            La validation du certificat est désactivée : la liaison n’est plus protégée contre un
            serveur qui se ferait passer pour l’annuaire.
          </p>
        )}

        <div className="mt-3">
          <label className="block text-xs font-medium text-ardoise-700" htmlFor="ldap-ac">
            Autorité de certification interne (PEM)
          </label>
          <textarea
            id="ldap-ac"
            rows={3}
            value={saisie.acPem ?? ''}
            placeholder="-----BEGIN CERTIFICATE-----"
            onChange={(e) => modifier({ acPem: e.target.value === '' ? null : e.target.value })}
            className="mt-1 w-full rounded border border-ardoise-300 px-2 py-1 font-mono text-xs"
          />
        </div>

        <div className="mt-3 grid gap-3 sm:grid-cols-2">
          <Champ
            id="ldap-filtre"
            libelle="Filtre utilisateur"
            valeur={saisie.filtre}
            onChange={(filtre) => modifier({ filtre })}
            aide="Doit contenir {login}, remplacé par l’identifiant saisi à la connexion."
          />
          {(['login', 'email', 'nomAffiche', 'groupes'] as const).map((cle) => (
            <Champ
              key={cle}
              id={`attr-${cle}`}
              libelle={`Attribut « ${cle} »`}
              valeur={saisie.attributs[cle]}
              onChange={(valeur) =>
                modifier({ attributs: { ...saisie.attributs, [cle]: valeur } })
              }
            />
          ))}
        </div>
      </section>

      <section aria-labelledby="regles" className="rounded border border-ardoise-200 bg-white p-4">
        <h3 id="regles" className="mb-1 text-sm font-semibold">
          Groupes et rôles
          <Aide texte="Plusieurs groupes donnent le rôle le plus élevé. Un utilisateur qu’aucune règle ne vise ne peut pas se connecter." />
        </h3>
        <p className="mb-3 text-xs text-ardoise-600">
          Un locataire par règle : un groupe qui doit en ouvrir plusieurs fait l’objet de plusieurs
          règles.
        </p>

        <table className="w-full text-sm">
          <thead className="text-left text-xs uppercase tracking-wide text-ardoise-600">
            <tr>
              <th className="pb-1 font-medium">Groupe (DN complet)</th>
              <th className="pb-1 font-medium">Rôle</th>
              <th className="pb-1 font-medium">Locataire</th>
              <th className="pb-1" />
            </tr>
          </thead>
          <tbody>
            {saisie.regles.map((regle, rang) => (
              <tr key={rang} className="border-t border-ardoise-100">
                <td className="py-1 pr-2">
                  <input
                    aria-label={`Groupe ${rang + 1}`}
                    value={regle.groupeDn}
                    placeholder="CN=VoxEcho-Admins,OU=Groupes,DC=banque,DC=local"
                    onChange={(e) => remplacer(rang, { ...regle, groupeDn: e.target.value })}
                    className="w-full rounded border border-ardoise-300 px-2 py-1 font-mono text-xs"
                  />
                </td>
                <td className="py-1 pr-2">
                  <select
                    aria-label={`Rôle ${rang + 1}`}
                    value={regle.role}
                    onChange={(e) => remplacer(rang, { ...regle, role: e.target.value as Role })}
                    className="rounded border border-ardoise-300 px-2 py-1 text-sm"
                  >
                    {ROLES.map((role) => (
                      <option key={role} value={role}>
                        {libelleRole(role)}
                      </option>
                    ))}
                  </select>
                </td>
                <td className="py-1 pr-2">
                  <select
                    aria-label={`Locataire ${rang + 1}`}
                    value={regle.tenantId}
                    onChange={(e) => remplacer(rang, { ...regle, tenantId: e.target.value })}
                    className="rounded border border-ardoise-300 px-2 py-1 text-sm"
                  >
                    {donnees.locataires.map((locataire) => (
                      <option key={locataire.id} value={locataire.id}>
                        {locataire.nom}
                      </option>
                    ))}
                  </select>
                </td>
                <td className="py-1 text-right">
                  <button
                    type="button"
                    onClick={() =>
                      modifier({ regles: saisie.regles.filter((_, i) => i !== rang) })
                    }
                    className="rounded border border-ardoise-300 px-2 py-1 text-xs text-red-700 hover:bg-red-50"
                  >
                    Supprimer
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>

        {saisie.regles.length === 0 && (
          <p className="mt-2 text-sm text-ardoise-600">
            Aucune règle : personne ne peut se connecter par l’annuaire.
          </p>
        )}

        <button
          type="button"
          onClick={() =>
            modifier({
              regles: [
                ...saisie.regles,
                {
                  groupeDn: '',
                  role: 'AUDITOR' as Role,
                  tenantId: donnees.locataires[0]?.id ?? '',
                },
              ],
            })
          }
          className="mt-3 rounded border border-ardoise-300 px-3 py-1 text-sm hover:bg-ardoise-50"
        >
          Ajouter une règle
        </button>
      </section>

      <section aria-labelledby="synchro" className="rounded border border-ardoise-200 bg-white p-4">
        <h3 id="synchro" className="mb-3 text-sm font-semibold">
          Synchronisation
          <Aide texte="Elle ne crée aucun compte — un compte naît d’une connexion réussie. Elle désactive ceux qui ont quitté l’annuaire ou les groupes mappés." />
        </h3>
        <div className="flex flex-wrap items-end gap-4">
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={saisie.synchro.actif}
              onChange={(e) =>
                modifier({ synchro: { ...saisie.synchro, actif: e.target.checked } })
              }
            />
            Active
          </label>
          <div>
            <label className="block text-xs font-medium text-ardoise-700" htmlFor="synchro-heures">
              Intervalle, en heures
            </label>
            <input
              id="synchro-heures"
              type="number"
              min={1}
              max={168}
              value={saisie.synchro.intervalleHeures}
              onChange={(e) =>
                modifier({
                  synchro: { ...saisie.synchro, intervalleHeures: Number(e.target.value) },
                })
              }
              className="mt-1 w-24 rounded border border-ardoise-300 px-2 py-1 text-sm tabular-nums"
            />
          </div>
          {donnees.derniereSynchro !== null && (
            <span className="text-xs text-ardoise-600">
              Dernière : {formatHorodatage(donnees.derniereSynchro.le)} —{' '}
              {donnees.derniereSynchro.vus} compte(s) vu(s),{' '}
              {donnees.derniereSynchro.desactives} désactivé(s).
            </span>
          )}
        </div>
      </section>

      <section aria-labelledby="test" className="rounded border border-ardoise-200 bg-white p-4">
        <h3 id="test" className="mb-3 text-sm font-semibold">
          Tester la connexion
        </h3>
        <div className="flex flex-wrap items-end gap-2">
          <div>
            <label className="block text-xs font-medium text-ardoise-700" htmlFor="test-login">
              Identifiant à chercher
            </label>
            <input
              id="test-login"
              value={loginTest}
              placeholder="nkolo"
              onChange={(e) => setLoginTest(e.target.value)}
              className="mt-1 w-56 rounded border border-ardoise-300 px-2 py-1 text-sm"
            />
          </div>
          <button
            type="button"
            onClick={() => void tester()}
            className="rounded border border-ardoise-300 px-3 py-1.5 text-sm hover:bg-ardoise-50"
          >
            Tester
          </button>
          <span className="text-xs text-ardoise-600">
            Résultat inscrit au journal, réussite ou échec.
          </span>
        </div>

        {resultat !== null && (
          <div className="mt-3 space-y-2 text-sm" data-testid="resultat-test-annuaire">
            <p className={resultat.bind.reussi ? 'text-emerald-800' : 'text-red-800'}>
              Liaison : {resultat.bind.message}
            </p>
            {resultat.recherche !== null && (
              <div className={resultat.recherche.trouve ? '' : 'text-amber-800'}>
                <p>Recherche : {resultat.recherche.message}</p>
                {resultat.recherche.trouve && (
                  <dl className="mt-1 grid gap-x-6 gap-y-1 text-xs sm:grid-cols-2">
                    <Releve intitule="DN" valeur={resultat.recherche.dn ?? '—'} />
                    <Releve intitule="Identifiant" valeur={resultat.recherche.login ?? '—'} />
                    <Releve intitule="Adresse" valeur={resultat.recherche.email ?? '—'} />
                    <Releve intitule="Nom affiché" valeur={resultat.recherche.nomAffiche ?? '—'} />
                  </dl>
                )}
                {resultat.recherche.groupes.length > 0 && (
                  <ul className="mt-1 space-y-0.5 font-mono text-xs text-ardoise-700">
                    {resultat.recherche.groupes.map((groupe) => (
                      <li key={groupe}>{groupe}</li>
                    ))}
                  </ul>
                )}
              </div>
            )}
            {resultat.recherche?.trouve === true && (
              <p className={resultat.correspondance === null ? 'text-amber-800' : 'text-emerald-800'}>
                {resultat.correspondance === null
                  ? 'Aucune règle ne vise ses groupes : cet utilisateur ne pourrait pas se connecter.'
                  : `Il se connecterait comme ${libelleRole(resultat.correspondance.role)}.`}
              </p>
            )}
          </div>
        )}
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

  function remplacer(rang: number, regle: RegleAnnuaire): void {
    if (saisie === null) return;
    setSaisie({ ...saisie, regles: saisie.regles.map((r, i) => (i === rang ? regle : r)) });
  }
}

function Champ({
  id,
  libelle,
  valeur,
  placeholder,
  aide,
  onChange,
}: {
  id: string;
  libelle: string;
  valeur: string | null;
  placeholder?: string;
  aide?: string;
  onChange: (valeur: string) => void;
}) {
  return (
    <div>
      <label className="block text-xs font-medium text-ardoise-700" htmlFor={id}>
        {libelle}
        {aide !== undefined && <Aide texte={aide} />}
      </label>
      <input
        id={id}
        value={valeur ?? ''}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
        className="mt-1 w-full rounded border border-ardoise-300 px-2 py-1 font-mono text-xs"
      />
    </div>
  );
}

function Releve({ intitule, valeur }: { intitule: string; valeur: string }) {
  return (
    <div>
      <dt className="uppercase tracking-wide text-ardoise-500">{intitule}</dt>
      <dd className="break-all font-mono">{valeur}</dd>
    </div>
  );
}
