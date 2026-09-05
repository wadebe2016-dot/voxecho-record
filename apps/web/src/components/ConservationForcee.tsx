import { useCallback, useEffect, useState } from 'react';
import type { LegalHoldResponse } from '@voxecho/shared';
import { ApiError, api } from '../api/client';
import { useAuth } from '../auth/auth-context';
import { Aide } from './Aide';
import { formatHorodatage } from '../lib/format';
import { peut } from '../lib/permissions';

/**
 * Conservation forcée d'un appel — CLAUDE.md §9.29.
 *
 * Poser protège une preuve, lever la rend destructible : les deux actes
 * n'engagent pas également, et l'écran ne les présente donc pas de la même
 * façon. La pose demande un motif et la référence du dossier ; la levée passe
 * par un second administrateur, et ne s'en dispense qu'en le disant.
 */
export function ConservationForcee({
  recordingId,
  sousConservation,
  onChangement,
}: {
  recordingId: string;
  /**
   * Ce que la liste sait déjà de l'appel. Il sert de garde : si l'historique
   * ne se charge pas, la fiche annonce quand même la mesure plutôt que de
   * laisser croire à un appel ordinaire.
   */
  sousConservation: boolean;
  onChangement?: () => void;
}) {
  const { profil } = useAuth();
  const peutAgir = peut(profil?.role, 'gererConservationForcee');

  const [holds, setHolds] = useState<LegalHoldResponse[] | null>(null);
  const [echec, setEchec] = useState(false);
  const [erreur, setErreur] = useState<string | null>(null);
  const [envoi, setEnvoi] = useState(false);
  const [formulaire, setFormulaire] = useState<'pose' | 'levee' | null>(null);
  const [motif, setMotif] = useState('');
  const [dossier, setDossier] = useState('');
  /**
   * Passe à vrai quand l'api a refusé la levée faute d'un second
   * administrateur. L'acceptation est alors demandée explicitement — et
   * consignée : empêcher aurait créé un blocage sans issue, laisser passer en
   * silence aurait effacé la différence entre deux niveaux de garantie.
   */
  const [sansContreValidation, setSansContreValidation] = useState(false);

  const charger = useCallback(async () => {
    try {
      setHolds(await api.conservationsForcees(recordingId));
      setEchec(false);
    } catch {
      setEchec(true);
      // On ne remplace pas un historique manquant par une liste vide : ce
      // serait affirmer qu'il n'y a pas de conservation, alors qu'on n'en
      // sait rien. C'est ce qui déclenche le bandeau de garde ci-dessous.
      setHolds(null);
    }
  }, [recordingId]);

  useEffect(() => {
    setFormulaire(null);
    setMotif('');
    setDossier('');
    setSansContreValidation(false);
    setErreur(null);
    void charger();
  }, [charger]);

  const actif = holds?.find((hold) => hold.releasedAt === null) ?? null;

  async function poser(): Promise<void> {
    setEnvoi(true);
    setErreur(null);
    try {
      await api.poserConservationForcee(recordingId, motif, dossier);
      setFormulaire(null);
      setMotif('');
      setDossier('');
      await charger();
      onChangement?.();
    } catch (e) {
      setErreur(e instanceof ApiError ? e.message : 'La conservation n’a pas été posée.');
    } finally {
      setEnvoi(false);
    }
  }

  async function lever(): Promise<void> {
    setEnvoi(true);
    setErreur(null);
    try {
      await api.leverConservationForcee(recordingId, {
        reason: motif,
        ...(sansContreValidation ? { acceptSansContreValidation: true } : {}),
      });
      setFormulaire(null);
      setMotif('');
      setSansContreValidation(false);
      await charger();
      onChangement?.();
    } catch (e) {
      const message = e instanceof ApiError ? e.message : 'La levée n’a pas été enregistrée.';
      setErreur(message);
      // Le refus « aucun autre administrateur actif » n'est pas un échec : il
      // demande d'assumer la levée. L'écran le propose plutôt que de laisser
      // l'utilisateur relire le message et deviner ce qu'on attend de lui.
      if (message.includes('sans contre-validation')) setSansContreValidation(true);
    } finally {
      setEnvoi(false);
    }
  }

  return (
    <section
      aria-labelledby="conservation-forcee"
      className="mt-4 border-t border-ardoise-100 pt-3"
    >
      <h3
        id="conservation-forcee"
        className="mb-2 text-xs uppercase tracking-wide text-ardoise-600"
      >
        Conservation forcée
        <Aide texte="Une conservation forcée soustrait l’appel à la purge, quelle que soit son ancienneté. Elle se pose sur pièce et se lève à quatre yeux." />
      </h3>

      {actif !== null ? (
        <div
          role="status"
          className="rounded border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900"
        >
          <p>
            <span className="font-medium">Sous conservation forcée.</span> Cet appel est soustrait à
            la purge automatique jusqu’à la levée de la mesure.
          </p>
          <p className="mt-1">Motif : « {actif.reason} »</p>
          <p>
            Dossier :{' '}
            {actif.caseReference.trim() === '' ? (
              <span className="text-amber-800">non renseignée</span>
            ) : (
              actif.caseReference
            )}
          </p>
          <p className="mt-1 text-xs">
            Posée par {actif.setByEmail} le {formatHorodatage(actif.at)}.
          </p>
        </div>
      ) : sousConservation && holds === null ? (
        <p
          role="status"
          className="rounded border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900"
        >
          <span className="font-medium">Sous conservation forcée.</span> Cet appel est soustrait à
          la purge automatique jusqu’à la levée de la mesure.
          {echec ? ' Le détail de la mesure n’a pas pu être chargé.' : ' Détail en chargement…'}
        </p>
      ) : holds === null ? (
        <p className="text-sm text-ardoise-600">Chargement…</p>
      ) : (
        <p className="text-sm text-ardoise-600">Aucune conservation forcée en cours.</p>
      )}

      {peutAgir && formulaire === null && holds !== null && (
        <div className="mt-2">
          <button
            type="button"
            onClick={() => {
              setMotif('');
              setDossier('');
              setErreur(null);
              setFormulaire(actif === null ? 'pose' : 'levee');
            }}
            className="rounded border border-ardoise-300 px-3 py-1 text-sm hover:bg-ardoise-50"
          >
            {actif === null ? 'Poser une conservation' : 'Lever la conservation'}
          </button>
        </div>
      )}

      {formulaire !== null && (
        <div className="mt-2 space-y-2 rounded border border-ardoise-200 p-3">
          <div>
            <label className="block text-xs font-medium text-ardoise-700" htmlFor="hold-motif">
              Motif
            </label>
            <input
              id="hold-motif"
              value={motif}
              onChange={(e) => setMotif(e.target.value)}
              placeholder={formulaire === 'pose' ? 'Réquisition judiciaire' : 'Dossier clos'}
              className="w-full rounded border border-ardoise-300 px-2 py-1 text-sm"
            />
          </div>

          {formulaire === 'pose' && (
            <div>
              <label className="block text-xs font-medium text-ardoise-700" htmlFor="hold-dossier">
                Référence du dossier
                <Aide texte="Ce qu’un contrôleur demandera : de quel dossier relève cette conservation. La forme est libre — chaque banque numérote à sa façon." />
              </label>
              <input
                id="hold-dossier"
                value={dossier}
                onChange={(e) => setDossier(e.target.value)}
                placeholder="n° 2026-118 du parquet"
                className="w-full rounded border border-ardoise-300 px-2 py-1 text-sm"
              />
            </div>
          )}

          {sansContreValidation && (
            <p className="rounded border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-900">
              La levée sera consignée comme faite sans contre-validation.
            </p>
          )}

          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              disabled={
                envoi ||
                motif.trim().length < 10 ||
                (formulaire === 'pose' && dossier.trim() === '')
              }
              onClick={() => void (formulaire === 'pose' ? poser() : lever())}
              className="rounded bg-ardoise-800 px-3 py-1 text-sm text-white disabled:opacity-50"
            >
              {envoi
                ? 'Enregistrement…'
                : formulaire === 'pose'
                  ? 'Poser'
                  : sansContreValidation
                    ? 'Lever sans contre-validation'
                    : 'Lever'}
            </button>
            <button
              type="button"
              onClick={() => {
                setFormulaire(null);
                setSansContreValidation(false);
                setErreur(null);
              }}
              className="rounded border border-ardoise-300 px-3 py-1 text-sm"
            >
              Annuler
            </button>
          </div>
        </div>
      )}

      {erreur !== null && (
        <p role="alert" className="mt-2 text-sm text-red-800">
          {erreur}
        </p>
      )}

      {(holds ?? []).some((hold) => hold.releasedAt !== null) && (
        <details className="mt-3">
          <summary className="cursor-pointer text-xs text-ardoise-600">
            Conservations levées ({(holds ?? []).filter((hold) => hold.releasedAt !== null).length})
          </summary>
          <ul className="mt-2 space-y-2 text-xs text-ardoise-700">
            {(holds ?? [])
              .filter((hold) => hold.releasedAt !== null)
              .map((hold) => (
                <li key={hold.id} className="border-l-2 border-ardoise-200 pl-2">
                  <p>
                    « {hold.reason} » — dossier{' '}
                    {hold.caseReference.trim() === '' ? 'non renseignée' : hold.caseReference}
                  </p>
                  <p className="text-ardoise-600">
                    Posée par {hold.setByEmail} le {formatHorodatage(hold.at)}, levée par{' '}
                    {hold.releasedByEmail ?? '—'} le {formatHorodatage(hold.releasedAt ?? '')}
                    {hold.releaseReason === null ? '' : ` — « ${hold.releaseReason} »`}
                  </p>
                  {hold.releasedWithoutSecondApproval && (
                    <p className="text-amber-800">Levée sans contre-validation.</p>
                  )}
                </li>
              ))}
          </ul>
        </details>
      )}
    </section>
  );
}
