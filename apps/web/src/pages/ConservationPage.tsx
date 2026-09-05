import { useCallback, useEffect, useState } from 'react';
import {
  INGEST_OPERATION_CATEGORIES,
  RETENTION_SCOPE_ALL,
  type RetentionPolicyEntry,
  type RetentionPolicySetResponse,
} from '@voxecho/shared';
import { ApiError, api } from '../api/client';
import { useAuth } from '../auth/auth-context';
import { Aide } from '../components/Aide';
import { formatHorodatage, libelleCategorie } from '../lib/format';
import { peut } from '../lib/permissions';

/**
 * Durées de conservation — CLAUDE.md §9.6, §9.28 et §9.30.
 *
 * Un écran de conservation doit répondre à trois questions dans cet ordre :
 * combien de temps garde-t-on, cette durée a-t-elle été décidée ou héritée,
 * et jusqu'où peut-on descendre. Les deux planchers ne disent pas la même
 * chose et ne se présentent donc pas de la même façon : celui de l'instance
 * se franchit avec un motif écrit, celui du texte ne se franchit pas.
 */
export function ConservationPage() {
  const { profil } = useAuth();
  const peutGerer = peut(profil?.role, 'gererRetention');

  const [ensemble, setEnsemble] = useState<RetentionPolicySetResponse | null>(null);
  const [chargement, setChargement] = useState(true);
  const [erreur, setErreur] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [encours, setEnCours] = useState<string | null>(null);

  const charger = useCallback(async () => {
    setChargement(true);
    try {
      setEnsemble(await api.conservation());
      setErreur(null);
    } catch (e) {
      setErreur(e instanceof ApiError ? e.message : 'Le service est momentanément indisponible.');
    } finally {
      setChargement(false);
    }
  }, []);

  useEffect(() => {
    void charger();
  }, [charger]);

  async function definir(appliesTo: string, days: number, motif: string): Promise<void> {
    setEnCours(appliesTo);
    setErreur(null);
    setMessage(null);
    try {
      await api.definirConservation({
        days,
        appliesTo,
        ...(motif.trim() === '' ? {} : { belowFloorReason: motif.trim() }),
      });
      setMessage(
        `${appliesTo === RETENTION_SCOPE_ALL ? 'Durée générale' : libelleCategorie(appliesTo)} : ${days} jours. Le changement est inscrit au journal d’audit.`,
      );
      await charger();
    } catch (e) {
      setErreur(e instanceof ApiError ? e.message : 'Le changement n’a pas été enregistré.');
    } finally {
      setEnCours(null);
    }
  }

  if (chargement) return <p className="text-sm text-ardoise-600">Chargement des durées…</p>;
  if (ensemble === null) {
    return (
      <p role="alert" className="rounded border border-red-200 bg-red-50 p-4 text-sm text-red-800">
        {erreur ?? 'Le service est momentanément indisponible.'}
      </p>
    );
  }

  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-lg font-semibold tracking-tight">
          Durées de conservation
          <Aide texte="Combien de temps les enregistrements sont gardés avant d’être purgeables. La purge ne se déclenche jamais seule : elle s’autorise sur un rapport." />
        </h1>
      </header>

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

      <Planchers ensemble={ensemble} />

      <section aria-labelledby="generale">
        <h2 id="generale" className="mb-2 text-sm font-semibold">
          Durée générale
        </h2>
        <Ligne
          entree={ensemble.generale}
          intitule="Tous les appels"
          minDays={ensemble.minDays}
          modifiable={peutGerer}
          enCours={encours === RETENTION_SCOPE_ALL}
          onDefinir={definir}
        />
      </section>

      <section aria-labelledby="categories">
        <h2 id="categories" className="mb-2 text-sm font-semibold">
          Par catégorie d’opération
          <Aide texte="La politique la plus précise l’emporte sur la générale. Une catégorie sans durée propre suit la générale." />
        </h2>
        <div className="space-y-2">
          {INGEST_OPERATION_CATEGORIES.map((categorie) => {
            const entree = ensemble.parCategorie.find((e) => e.appliesTo === categorie);
            if (entree === undefined) return null;
            return (
              <Ligne
                key={categorie}
                entree={entree}
                intitule={libelleCategorie(categorie)}
                minDays={ensemble.minDays}
                modifiable={peutGerer}
                enCours={encours === categorie}
                onDefinir={definir}
              />
            );
          })}
        </div>
      </section>
    </div>
  );
}

/**
 * Les deux planchers, en lecture seule. Celui de l'instance est posé par
 * Atlastech au déploiement : ce n'est pas un réglage client, et un
 * administrateur ne doit pas pouvoir l'abaisser depuis un écran.
 */
function Planchers({ ensemble }: { ensemble: RetentionPolicySetResponse }) {
  const reglementaires = ensemble.parCategorie
    .filter((entree) => entree.plancherReglementaire > 0)
    .map((entree) => `${libelleCategorie(entree.appliesTo)} : ${entree.plancherReglementaire} j`);
  const general = ensemble.generale.plancherReglementaire;

  return (
    <section
      aria-labelledby="planchers"
      className="rounded border border-ardoise-200 bg-ardoise-50 p-4 text-sm"
    >
      <h2 id="planchers" className="mb-2 text-sm font-semibold">
        Minimums applicables
      </h2>
      <dl className="grid gap-x-8 gap-y-2 sm:grid-cols-2">
        <div>
          <dt className="text-xs uppercase tracking-wide text-ardoise-600">
            Plancher de l’instance
            <Aide texte="Descendre en dessous reste possible, mais exige un motif écrit qui est conservé sur la politique et inscrit au journal." />
          </dt>
          <dd className="tabular-nums">
            {ensemble.minDays} jours
            <span className="ml-2 text-xs text-ardoise-600">
              — lecture seule, fixé par Atlastech
            </span>
          </dd>
        </div>
        <div>
          <dt className="text-xs uppercase tracking-wide text-ardoise-600">
            Minimum réglementaire
            <Aide texte="Déclaré au déploiement. À la différence du plancher d’instance, il ne se déroge pas : une durée inférieure est refusée, motif ou non." />
          </dt>
          <dd className="tabular-nums">
            {general === 0 && reglementaires.length === 0 ? (
              <span className="text-ardoise-600">aucun déclaré</span>
            ) : (
              [general > 0 ? `Général : ${general} j` : null, ...reglementaires]
                .filter((texte): texte is string => texte !== null)
                .join(' · ')
            )}
            <span className="ml-2 text-xs text-ardoise-600">
              — lecture seule, fixé par Atlastech
            </span>
          </dd>
        </div>
      </dl>
    </section>
  );
}

interface LigneProps {
  entree: RetentionPolicyEntry;
  intitule: string;
  minDays: number;
  modifiable: boolean;
  enCours: boolean;
  onDefinir: (appliesTo: string, days: number, motif: string) => Promise<void>;
}

/**
 * Une durée, sa provenance et sa saisie. « Décidée » ou « héritée » : sans
 * cette distinction, on ne saurait pas si 730 jours résultent d'un choix ou
 * d'un défaut.
 */
function Ligne({ entree, intitule, minDays, modifiable, enCours, onDefinir }: LigneProps) {
  const [jours, setJours] = useState(String(entree.days));
  const [motif, setMotif] = useState('');
  const generale = entree.appliesTo === RETENTION_SCOPE_ALL;

  useEffect(() => setJours(String(entree.days)), [entree.days]);

  const saisie = Number(jours);
  const sousPlancher = Number.isFinite(saisie) && saisie > 0 && saisie < minDays;
  const identifiant = `duree-${entree.appliesTo}`;

  return (
    <div
      data-testid={`perimetre-${entree.appliesTo}`}
      className="rounded border border-ardoise-200 bg-white p-4"
    >
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h3 className="text-sm font-medium">{intitule}</h3>
        <p className="text-sm tabular-nums">
          {entree.days} jours{' '}
          <span className="text-xs text-ardoise-600">
            {entree.enregistree
              ? `— décidée le ${formatHorodatage(entree.updatedAt)}`
              : generale
                ? '— héritée du défaut produit'
                : '— héritée de la durée générale'}
          </span>
        </p>
      </div>

      {entree.belowFloorReason !== null && (
        <p className="mt-2 rounded border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900">
          <span className="font-medium">Politique dérogatoire</span> — sous le plancher de
          l’instance. Motif : « {entree.belowFloorReason} »
        </p>
      )}

      {entree.plancherReglementaire > 0 && (
        <p className="mt-2 text-xs text-ardoise-600">
          Minimum réglementaire de ce périmètre : {entree.plancherReglementaire} jours.
        </p>
      )}

      {modifiable && (
        <div className="mt-3 flex flex-wrap items-end gap-2 border-t border-ardoise-100 pt-3">
          <div>
            <label className="block text-xs font-medium text-ardoise-700" htmlFor={identifiant}>
              Durée, en jours
            </label>
            <input
              id={identifiant}
              type="number"
              min={1}
              value={jours}
              onChange={(e) => setJours(e.target.value)}
              className="w-28 rounded border border-ardoise-300 px-2 py-1 text-sm tabular-nums"
            />
          </div>

          {sousPlancher && (
            <div className="grow">
              <label
                className="block text-xs font-medium text-ardoise-700"
                htmlFor={`${identifiant}-motif`}
              >
                Motif de dérogation
                <Aide texte="Exigé sous le plancher de l’instance, et refusé au-dessus : un motif accroché à une politique qui ne déroge à rien ferait croire à une dérogation qu’il n’y a pas." />
              </label>
              <input
                id={`${identifiant}-motif`}
                value={motif}
                onChange={(e) => setMotif(e.target.value)}
                placeholder="Décision qui autorise cette durée"
                className="w-full rounded border border-ardoise-300 px-2 py-1 text-sm"
              />
            </div>
          )}

          <button
            type="button"
            disabled={enCours || jours.trim() === ''}
            onClick={() => void onDefinir(entree.appliesTo, Number(jours), motif)}
            className="rounded bg-ardoise-800 px-3 py-1.5 text-sm text-white disabled:opacity-50"
          >
            {enCours ? 'Enregistrement…' : 'Modifier'}
          </button>
        </div>
      )}
    </div>
  );
}
