import { useEffect, useState } from 'react';
import type { EtatHorloge } from '@voxecho/shared';
import { api } from '../api/client';

/** Le relevé se rafraîchit à cette cadence, comme le bloc de l'onglet Réseau. */
const PERIODE_MS = 60_000;

/**
 * Bandeau d'horodatage non fiable — CLAUDE.md §9.36.
 *
 * Il s'affiche en tête de toute la console, pour les trois rôles : un auditeur
 * qui relève une empreinte doit savoir que l'heure inscrite à côté n'est
 * peut-être pas défendable.
 *
 * Seul l'état `non_synchronise` le lève. `indisponible` ne le lève pas — c'est
 * la différence entre « on a lu l'horloge et elle ne suit plus » et « on n'a
 * pas su la lire », et un bandeau qui crierait pour la seconde userait
 * l'avertissement jusqu'à ce que plus personne ne le lise. L'écran d'état s'en
 * charge, en orange.
 */
export function BandeauHorloge() {
  const [etat, setEtat] = useState<EtatHorloge | null>(null);

  useEffect(() => {
    let vivant = true;
    const relever = (): void => {
      void api
        .horloge()
        .then((valeur) => {
          if (vivant) setEtat(valeur);
        })
        .catch(() => {
          // Une console qui n'arrive pas à joindre l'api a d'autres façons de
          // le dire ; on ne transforme pas une panne de réseau en alerte
          // d'horodatage.
          if (vivant) setEtat(null);
        });
    };
    relever();
    const minuterie = setInterval(relever, PERIODE_MS);
    return () => {
      vivant = false;
      clearInterval(minuterie);
    };
  }, []);

  if (etat === null || etat.statut !== 'non_synchronise') return null;

  return (
    <div role="alert" className="bg-red-700 px-4 py-2 text-center text-sm text-white">
      <span className="font-semibold">Horodatage non fiable</span> — la valeur probante des
      enregistrements n’est pas garantie. {etat.message}
    </div>
  );
}
