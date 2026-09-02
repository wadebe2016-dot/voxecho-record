import { AVARIES, deposerAppel, type Avarie, type Depot } from './deposit';
import type { Options } from './options';
import { creerAlea } from './random';

/**
 * Exécution des modes du simulateur. Séparé du CLI pour être testable sans
 * processus ni horloge réelle : le mode continu reçoit sa temporisation.
 */

export interface Journal {
  /** Appelé après chaque dépôt, pour l'affichage. */
  depot(depot: Depot, index: number, total: number | null): void;
}

export interface OptionsExecution {
  options: Options;
  journal: Journal;
  /** Attente entre deux dépôts en mode continu. Injectée pour les tests. */
  attendre?: (ms: number) => Promise<void>;
  /** Interrompt le mode continu. */
  arret?: () => boolean;
  /** Instant de référence, pour rendre les tests déterministes. */
  maintenant?: () => Date;
}

const patienter = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms).unref?.());

/**
 * Un appel après l'autre. En mode continu, la cadence est tenue par une
 * attente entre les dépôts : à `10/min`, un appel toutes les six secondes.
 */
export async function simuler(execution: OptionsExecution): Promise<Depot[]> {
  const { options, journal } = execution;
  const alea = creerAlea(options.seed);
  const attendre = execution.attendre ?? patienter;
  const arret = execution.arret ?? ((): boolean => false);
  const maintenant = execution.maintenant ?? ((): Date => new Date());

  const total = options.mode === 'batch' ? options.count : options.mode === 'one' ? 1 : null;
  const intervalle = Math.round(60_000 / options.rate);
  const depots: Depot[] = [];

  for (let index = 0; total === null || index < total; index += 1) {
    if (arret()) break;

    const depot = await deposerAppel({
      ingestDir: options.ingestDir,
      slug: alea.parmi(options.tenants),
      alea,
      jour: jourDeDepot(maintenant(), options.spreadDays, alea.entier(0, options.spreadDays - 1)),
      // Les avaries alternent : un lot corrompu doit exercer les deux
      // chemins de quarantaine, pas seulement le premier.
      ...(options.corrupt ? { avarie: avarie(index) } : {}),
    });

    depots.push(depot);
    journal.depot(depot, index, total);

    if (total === null || index < total - 1) {
      if (options.mode === 'continuous') await attendre(intervalle);
    }
  }

  return depots;
}

function avarie(index: number): Avarie {
  return AVARIES[index % AVARIES.length] as Avarie;
}

/** Recule de `recul` jours pour étaler un lot sur une période crédible. */
function jourDeDepot(reference: Date, spreadDays: number, recul: number): Date {
  if (spreadDays <= 1) return reference;
  const jour = new Date(reference);
  jour.setUTCDate(jour.getUTCDate() - recul);
  return jour;
}
