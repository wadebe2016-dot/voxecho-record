import { describe, expect, it } from 'vitest';
import {
  deciderEnregistrement,
  parseRecordingPolicy,
  politiqueParDefaut,
  tirageEchantillon,
  type AppelACapturer,
  type RecordingPolicy,
} from '../src/index.js';

/**
 * Politique d'enregistrement sélectif — CLAUDE.md §9.23.
 *
 * Ce que ces tests protègent : le jour où le produit cesse d'enregistrer
 * systématiquement, chaque appel manquant doit avoir une explication. On
 * vérifie donc moins « la bonne décision » que « la décision motivée, dans le
 * bon ordre, et rejouable ».
 */

const APPEL: AppelACapturer = {
  refci: '16778001',
  near: '1001',
  far: '699112233',
  direction: 'outbound',
};

function politique(partie: Partial<RecordingPolicy>): RecordingPolicy {
  return { ...politiqueParDefaut(), ...partie };
}

describe('politique d’enregistrement', () => {
  describe('ordre d’évaluation', () => {
    it('fait primer une exclusion sur toute règle, même contraire', () => {
      // Le cas qui ne doit jamais se produire en clientèle : une règle
      // « enregistrer tous les appels sortants » qui attraperait la ligne de
      // la médecine du travail.
      const decision = deciderEnregistrement(
        politique({
          exclusions: ['699112233'],
          motifExclusions: 'Médecine du travail, RH, représentation du personnel',
          regles: [
            {
              libelle: 'Tous les sortants',
              critere: 'direction',
              valeur: 'outbound',
              decision: 'always',
              annonce: false,
              pauseAutorisee: false,
            },
          ],
        }),
        APPEL,
      );

      expect(decision.enregistrer).toBe(false);
      expect(decision.origine).toBe('exclusion');
      expect(decision.motif).toMatch(/Médecine du travail/);
    });

    it('retient la première règle qui correspond, pas la plus précise', () => {
      const decision = deciderEnregistrement(
        politique({
          regles: [
            {
              libelle: 'Sortants',
              critere: 'direction',
              valeur: 'outbound',
              decision: 'never',
              annonce: false,
              pauseAutorisee: false,
            },
            {
              libelle: 'Poste 1001',
              critere: 'near',
              valeur: '1001',
              decision: 'always',
              annonce: false,
              pauseAutorisee: false,
            },
          ],
        }),
        APPEL,
      );

      // L'ordre est celui que l'administrateur a écrit : le produit ne réordonne
      // pas ses règles dans son dos.
      expect(decision.enregistrer).toBe(false);
      expect(decision.regle).toBe('Sortants');
    });

    it('retombe sur le défaut, qui enregistre', () => {
      const decision = deciderEnregistrement(politiqueParDefaut(), APPEL);

      // Ne pas enregistrer doit résulter d'une décision écrite, jamais d'un
      // oubli de règle : le défaut du produit est donc « toujours ».
      expect(decision.enregistrer).toBe(true);
      expect(decision.origine).toBe('defaut');
    });
  });

  describe('critères', () => {
    it('reconnaît un préfixe, sur le poste comme sur le correspondant', () => {
      const parPrefixe = politique({
        regles: [
          {
            libelle: 'Mobiles',
            critere: 'far',
            valeur: '699*',
            decision: 'never',
            annonce: false,
            pauseAutorisee: false,
          },
        ],
      });
      expect(deciderEnregistrement(parPrefixe, APPEL).enregistrer).toBe(false);
      expect(deciderEnregistrement(parPrefixe, { ...APPEL, far: '677000000' }).enregistrer).toBe(
        true,
      );
    });

    it('résout une liste nommée, qui tient lieu de département', () => {
      const decision = deciderEnregistrement(
        politique({
          listes: [{ nom: 'Salle des marchés', numeros: ['1001', '1002'] }],
          regles: [
            {
              libelle: 'Salle des marchés',
              critere: 'liste',
              valeur: 'Salle des marchés',
              decision: 'always',
              annonce: true,
              pauseAutorisee: true,
            },
          ],
        }),
        APPEL,
      );

      expect(decision.enregistrer).toBe(true);
      expect(decision.annonce).toBe(true);
      expect(decision.pauseAutorisee).toBe(true);
    });

    it('n’attrape pas un appel sans catégorie avec une règle sur « autre »', () => {
      // C'est l'ingestion qui range en « autre » ce que le producteur n'a pas
      // déclaré (§9.10) ; au moment de décider, l'absence n'est pas un choix.
      const surAutre = politique({
        regles: [
          {
            libelle: 'Opérations diverses',
            critere: 'category',
            valeur: 'autre',
            decision: 'never',
            annonce: false,
            pauseAutorisee: false,
          },
        ],
      });
      expect(deciderEnregistrement(surAutre, APPEL).origine).toBe('defaut');
      expect(deciderEnregistrement(surAutre, { ...APPEL, category: 'autre' }).origine).toBe(
        'regle',
      );
    });
  });

  describe('échantillonnage', () => {
    it('se calcule sans dépendance, donc partout où il devra être rejoué', () => {
      // Le moteur tourne dans le navigateur (simulateur), dans l'api, et
      // demain dans le connecteur en Lua : un hachage de dix lignes vaut mieux
      // qu'une dépendance qui n'existe pas dans l'un des trois.
      expect(tirageEchantillon('16778001', 'r')).toBe(tirageEchantillon('16778001', 'r'));
      expect(Number.isInteger(tirageEchantillon('a', 'b'))).toBe(true);
    });

    it('rejoue toujours le même tirage pour le même appel', () => {
      // Sans cela, « pourquoi cet appel n'a-t-il pas été enregistré ? » n'aurait
      // pour réponse que « le hasard » — indéfendable en contrôle.
      const premier = tirageEchantillon('16778001', 'Sondage qualité');
      const second = tirageEchantillon('16778001', 'Sondage qualité');
      expect(premier).toBe(second);
      expect(premier).toBeGreaterThanOrEqual(0);
      expect(premier).toBeLessThan(100);

      // Deux règles distinctes ne tirent pas le même numéro : un appel écarté
      // par l'une peut être retenu par l'autre.
      expect(tirageEchantillon('16778001', 'Autre règle')).not.toBe(premier);
    });

    it('porte le taux et le tirage dans la décision, pour qu’on puisse la vérifier', () => {
      const decision = deciderEnregistrement(
        politique({ parDefaut: 'sample', tauxParDefautPourcent: 20 }),
        APPEL,
      );

      expect(decision.decision).toBe('sample');
      expect(decision.tauxPourcent).toBe(20);
      expect(decision.tirage).toBeGreaterThanOrEqual(0);
      expect(decision.enregistrer).toBe((decision.tirage as number) < 20);
      expect(decision.motif).toMatch(/échantillon 20 %, tirage \d+/);
    });

    it('répartit à peu près comme le taux l’annonce', () => {
      const politiqueSondage = politique({ parDefaut: 'sample', tauxParDefautPourcent: 25 });
      let retenus = 0;
      const total = 4000;
      for (let index = 0; index < total; index += 1) {
        if (
          deciderEnregistrement(politiqueSondage, { ...APPEL, refci: `appel-${index}` }).enregistrer
        ) {
          retenus += 1;
        }
      }
      // Tolérance large : on vérifie qu'un taux de 25 % ne rend pas 5 % ni
      // 60 %, pas la pureté statistique d'un hachage.
      expect(retenus / total).toBeGreaterThan(0.22);
      expect(retenus / total).toBeLessThan(0.28);
    });
  });

  describe('à la demande', () => {
    it('n’enregistre pas d’office et le dit', () => {
      const decision = deciderEnregistrement(politique({ parDefaut: 'on_demand' }), APPEL);
      expect(decision.enregistrer).toBe(false);
      expect(decision.motif).toMatch(/à la demande de l’agent/);
    });
  });

  describe('validation', () => {
    it('refuse un échantillonnage sans taux, et un taux sans échantillonnage', () => {
      expect(parseRecordingPolicy({ ...politiqueParDefaut(), parDefaut: 'sample' }).ok).toBe(false);

      const tauxInutile = parseRecordingPolicy({
        ...politiqueParDefaut(),
        regles: [
          {
            libelle: 'Tous',
            critere: 'direction',
            valeur: 'inbound',
            decision: 'always',
            tauxPourcent: 50,
            annonce: false,
            pauseAutorisee: false,
          },
        ],
      });
      expect(tauxInutile.ok).toBe(false);
      if (!tauxInutile.ok) {
        expect(tauxInutile.errors.join(' ')).toMatch(
          /ne se lit que sur une règle d’échantillonnage/,
        );
      }
    });

    it('refuse une règle qui désigne une liste inexistante', () => {
      const resultat = parseRecordingPolicy({
        ...politiqueParDefaut(),
        regles: [
          {
            libelle: 'Service inconnu',
            critere: 'liste',
            valeur: 'Comptabilité',
            decision: 'never',
            annonce: false,
            pauseAutorisee: false,
          },
        ],
      });
      expect(resultat.ok).toBe(false);
      if (!resultat.ok) expect(resultat.errors.join(' ')).toMatch(/aucune liste nommée/);
    });

    it('refuse un sens ou une catégorie hors contrat d’ingestion', () => {
      const regle = {
        libelle: 'Essai',
        decision: 'never' as const,
        annonce: false,
        pauseAutorisee: false,
      };
      expect(
        parseRecordingPolicy({
          ...politiqueParDefaut(),
          regles: [{ ...regle, critere: 'direction', valeur: 'sortant' }],
        }).ok,
      ).toBe(false);
      expect(
        parseRecordingPolicy({
          ...politiqueParDefaut(),
          regles: [{ ...regle, critere: 'category', valeur: 'confirmation_chèque' }],
        }).ok,
      ).toBe(false);
    });

    it('refuse un motif de numéro qui n’en est pas un', () => {
      const resultat = parseRecordingPolicy({
        ...politiqueParDefaut(),
        exclusions: ['.*(rh|syndicat).*'],
      });
      // Une expression régulière dans une liste d'exclusion serait illisible
      // pour l'administrateur qui la relit, et donc dangereuse.
      expect(resultat.ok).toBe(false);
    });
  });
});
