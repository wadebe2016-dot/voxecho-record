import { useEffect, useState } from 'react';
import type { RecordingListItem } from '@voxecho/shared';
import { ApiError, api, telecharger, urlAudio } from '../api/client';
import {
  formatDuree,
  formatHorodatage,
  formatTaille,
  libelleDirection,
  libelleStatut,
} from '../lib/format';

interface Props {
  appel: RecordingListItem;
  onFermer: () => void;
}

/**
 * Fiche d'un appel et son lecteur — CLAUDE.md §6.
 *
 * Ouvrir la fiche ne déclenche **aucune** écoute : un contrôleur qui vient
 * relever une empreinte n'a pas écouté l'appel, et le journal ne doit pas
 * prétendre le contraire. L'écoute commence quand on la demande, et c'est ce
 * geste-là qui s'inscrit au journal.
 */
export function RecordingDetail({ appel, onFermer }: Props) {
  const [source, setSource] = useState<string | null>(null);
  const [erreur, setErreur] = useState<string | null>(null);
  const [ouverture, setOuverture] = useState(false);
  const [exportEnCours, setExportEnCours] = useState(false);
  const [integrite, setIntegrite] = useState<'concordante' | 'divergente' | null>(null);

  // Changer d'appel referme le lecteur : le billet précédent ne vaut que pour
  // l'enregistrement pour lequel il a été délivré.
  useEffect(() => {
    setSource(null);
    setErreur(null);
    setIntegrite(null);
  }, [appel.id]);

  const ecouter = async (): Promise<void> => {
    setOuverture(true);
    setErreur(null);
    try {
      const billet = await api.ouvrirEcoute(appel.id);
      setSource(urlAudio(appel.id, billet.ticket));
    } catch (e) {
      setErreur(e instanceof ApiError ? e.message : 'La réécoute est momentanément indisponible.');
    } finally {
      setOuverture(false);
    }
  };

  /**
   * L'export emporte l'audio et sa fiche. L'empreinte est recalculée côté
   * serveur au moment où le fichier quitte le coffre : si elle a divergé, le
   * portail le dit ici, en plus de la fiche et du journal.
   */
  const exporter = async (): Promise<void> => {
    setExportEnCours(true);
    setErreur(null);
    setIntegrite(null);
    try {
      const archive = await api.exporterAppel(appel.id);
      telecharger(archive);
      setIntegrite(archive.integrite);
    } catch (e) {
      setErreur(e instanceof ApiError ? e.message : 'L’export est momentanément indisponible.');
    } finally {
      setExportEnCours(false);
    }
  };

  return (
    <section
      aria-labelledby="fiche-appel"
      className="mb-4 rounded border border-ardoise-300 bg-white p-4"
    >
      <header className="mb-3 flex items-baseline justify-between gap-3">
        <h2 id="fiche-appel" className="text-base font-semibold tracking-tight">
          Appel {appel.refci} — {formatHorodatage(appel.startedAt)}
        </h2>
        <button
          type="button"
          onClick={onFermer}
          className="rounded border border-ardoise-200 px-2 py-1 text-sm"
        >
          Fermer
        </button>
      </header>

      {appel.underHold && (
        /* Une conservation forcée change ce que devient l'appel : elle le
           soustrait à la rétention jusqu'à sa levée. Un auditeur qui consulte
           la fiche doit le voir sans avoir à le deviner. */
        <p
          className="mb-3 rounded border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900"
          role="status"
        >
          <span className="font-medium">Sous conservation forcée.</span> Cet appel est soustrait à
          la purge automatique jusqu’à la levée de la mesure.
        </p>
      )}

      <dl className="grid grid-cols-2 gap-x-6 gap-y-1 text-sm sm:grid-cols-4">
        <Champ intitule="Sens" valeur={libelleDirection(appel.direction)} />
        <Champ intitule="Poste enregistré" valeur={appel.near} />
        <Champ intitule="Correspondant" valeur={appel.far} />
        <Champ intitule="Durée" valeur={formatDuree(appel.durationSec)} />
        <Champ intitule="Taille" valeur={formatTaille(appel.sizeBytes)} />
        <Champ intitule="Source" valeur={appel.source} />
        <Champ intitule="Statut" valeur={libelleStatut(appel.status)} />
        <Champ intitule="Référence PBX" valeur={appel.refci} />
      </dl>

      <div className="mt-3 border-t border-ardoise-100 pt-3">
        <dt className="text-xs uppercase tracking-wide text-ardoise-600">
          Empreinte SHA-256 à l’ingestion
        </dt>
        {/* En entier, et sélectionnable : c'est la valeur qu'un contrôleur
            recopie pour la confronter à la sienne. */}
        <dd className="mt-1 font-mono text-xs break-all">{appel.sha256}</dd>
      </div>

      <div className="mt-4">
        {source === null ? (
          <button
            type="button"
            onClick={() => void ecouter()}
            disabled={ouverture}
            className="rounded bg-ardoise-800 px-3 py-1.5 text-sm text-white disabled:opacity-50"
          >
            {ouverture ? 'Ouverture…' : 'Écouter cet appel'}
          </button>
        ) : (
          <>
            <audio
              controls
              autoPlay
              preload="none"
              src={source}
              aria-label={`Lecture de l’appel ${appel.refci}`}
              className="w-full"
            />
            <p className="mt-2 text-xs text-ardoise-600">
              Cette écoute est inscrite au journal d’audit.
            </p>
          </>
        )}

        {erreur !== null && (
          <p role="alert" className="mt-2 text-sm text-red-800">
            {erreur}
          </p>
        )}
      </div>

      <div className="mt-4 border-t border-ardoise-100 pt-3">
        <button
          type="button"
          onClick={() => void exporter()}
          disabled={exportEnCours || appel.status === 'purged'}
          className="rounded border border-ardoise-300 px-3 py-1.5 text-sm disabled:opacity-50"
        >
          {exportEnCours ? 'Préparation de l’archive…' : 'Exporter (audio + fiche)'}
        </button>
        <p className="mt-2 text-xs text-ardoise-600">
          Archive ZIP : le fichier audio, une fiche PDF et une fiche JSON portant l’empreinte
          SHA-256, le demandeur et l’horodatage. Cet export est inscrit au journal d’audit.
        </p>

        {integrite === 'concordante' && (
          <p role="status" className="mt-2 text-xs text-emerald-800">
            Empreinte vérifiée au moment de l’export : elle concorde avec celle relevée à
            l’ingestion.
          </p>
        )}
        {integrite === 'divergente' && (
          <p
            role="alert"
            className="mt-2 rounded border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-900"
          >
            <span className="font-medium">Empreinte divergente.</span> Le fichier exporté ne porte
            plus l’empreinte relevée à son ingestion : il ne peut pas être présenté comme une pièce
            intacte. L’écart est consigné au journal d’audit.
          </p>
        )}
      </div>
    </section>
  );
}

function Champ({ intitule, valeur }: { intitule: string; valeur: string }) {
  return (
    <div>
      <dt className="text-xs uppercase tracking-wide text-ardoise-600">{intitule}</dt>
      <dd className="tabular-nums">{valeur}</dd>
    </div>
  );
}
