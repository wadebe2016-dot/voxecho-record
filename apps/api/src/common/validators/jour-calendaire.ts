import { registerDecorator, type ValidationOptions } from 'class-validator';
import { isCalendarDay } from '@voxecho/shared';

/**
 * Refuse une date qui n'existe pas au calendrier — « 2026-02-30 » autant que
 * « 2026-09-32 ».
 *
 * Un simple contrôle de forme laissait passer les deux : le premier partait en
 * recherche sur le 1er mars, le second finissait en erreur serveur. Le premier
 * était le pire des deux, car il rendait un résultat d'apparence normale que
 * le journal d'audit attribuait ensuite au 30 février.
 *
 * Le portail n'expose que des champs `<input type="date">`, qui ne peuvent pas
 * produire pareille saisie ; mais c'est l'api qui fait foi, et elle est
 * appelée par autre chose que le portail.
 */
export function EstJourCalendaire(options?: ValidationOptions) {
  return (objet: object, propriete: string): void => {
    registerDecorator({
      name: 'estJourCalendaire',
      target: objet.constructor,
      propertyName: propriete,
      options,
      validator: {
        validate: (valeur: unknown): boolean => typeof valeur === 'string' && isCalendarDay(valeur),
      },
    });
  };
}
