import { Injectable, Logger } from '@nestjs/common';
import { AppConfig } from '../config/config.module';

/**
 * Limitation des tentatives de connexion par adresse — CLAUDE.md §9.16.
 *
 * Elle ne remplace pas le verrouillage de compte du §5, elle le complète :
 * l'un protège un compte nommé, l'autre freine celui qui essaie mille comptes
 * à la suite. Le verrouillage seul laissait passer le balayage ; il est même
 * une arme, puisque cinq erreurs volontaires suffisent à priver un auditeur
 * de son accès pendant un quart d'heure.
 *
 * **Seuls les échecs comptent.** Dans une banque, tout le personnel sort par
 * une même adresse publique : compter les tentatives réussies reviendrait à
 * rationner les connexions d'un service entier au motif qu'il est nombreux.
 * Un balayage, lui, produit des échecs — c'est cela qu'on mesure.
 *
 * Une connexion réussie ne remet rien à zéro : sans quoi un attaquant
 * disposant d'un compte valide effacerait son propre compteur entre deux
 * salves. Les échecs s'oublient d'eux-mêmes en sortant de la fenêtre.
 */
@Injectable()
export class LimitationConnexion {
  private readonly logger = new Logger(LimitationConnexion.name);

  /** Horodatages des échecs récents, par adresse. Ordre d'accès = récence. */
  private readonly echecs = new Map<string, number[]>();
  /** Adresses dont l'épisode de blocage est déjà inscrit au journal. */
  private readonly signalees = new Set<string>();

  private readonly max: number;
  private readonly fenetreMs: number;
  private readonly maxAdresses: number;

  /** Horloge du service. Remplaçable pour éprouver une fenêtre sans attendre. */
  private maintenant: () => number = Date.now;

  constructor(config: AppConfig) {
    this.max = config.get('AUTH_RATE_MAX');
    this.fenetreMs = config.get('AUTH_RATE_WINDOW_SEC') * 1000;
    this.maxAdresses = config.get('AUTH_RATE_MAX_ADRESSES');
  }

  /**
   * Substitue l'horloge. Réservé aux tests : une fenêtre d'une minute
   * s'éprouve en la traversant, pas en attendant soixante secondes.
   */
  utiliserHorloge(source: () => number): this {
    this.maintenant = source;
    return this;
  }

  /** Secondes avant qu'une adresse bloquée retrouve le droit d'essayer. */
  private attenteSec(recents: number[]): number {
    const plusAncien = recents[0];
    if (plusAncien === undefined) return 0;
    return Math.max(1, Math.ceil((plusAncien + this.fenetreMs - this.maintenant()) / 1000));
  }

  private recents(ip: string): number[] {
    const limite = this.maintenant() - this.fenetreMs;
    const gardes = (this.echecs.get(ip) ?? []).filter((quand) => quand > limite);
    if (gardes.length === 0) {
      this.echecs.delete(ip);
      this.signalees.delete(ip);
    } else {
      // Réinsertion : la Map garde l'ordre d'insertion, qui devient l'ordre
      // de récence — c'est lui qui désigne les adresses à oublier.
      this.echecs.delete(ip);
      this.echecs.set(ip, gardes);
    }
    return gardes;
  }

  /**
   * L'adresse a-t-elle le droit d'essayer ? `premierRefus` n'est vrai qu'une
   * fois par épisode : le journal reçoit une entrée par blocage, pas une par
   * requête refusée — un inconnu ne doit pas pouvoir gonfler à volonté un
   * journal que rien ne peut purger (§9.4, §9.11).
   */
  verifier(ip: string): { autorise: boolean; attenteSec: number; premierRefus: boolean } {
    const recents = this.recents(ip);
    if (recents.length < this.max) return { autorise: true, attenteSec: 0, premierRefus: false };

    const premierRefus = !this.signalees.has(ip);
    if (premierRefus) {
      this.signalees.add(ip);
      this.logger.warn(
        `Connexions bloquées pour ${ip} : ${recents.length} échec(s) en ${this.fenetreMs / 1000} s`,
      );
    }
    return { autorise: false, attenteSec: this.attenteSec(recents), premierRefus };
  }

  /** Un échec de connexion, quelle qu'en soit la raison. */
  signalerEchec(ip: string | null): void {
    if (ip === null) return;
    const recents = this.recents(ip);
    recents.push(this.maintenant());
    this.echecs.set(ip, recents);
    this.oublierLesPlusAnciennes();
  }

  /**
   * Un balayage mené depuis des milliers d'adresses ne doit pas faire enfler
   * la mémoire de l'api : au-delà du plafond, les adresses les moins récentes
   * sont oubliées. Oublier un attaquant discret est le prix à payer pour ne
   * pas se laisser épuiser par un attaquant nombreux.
   */
  private oublierLesPlusAnciennes(): void {
    while (this.echecs.size > this.maxAdresses) {
      const plusAncienne = this.echecs.keys().next();
      if (plusAncienne.done === true) return;
      this.echecs.delete(plusAncienne.value);
      this.signalees.delete(plusAncienne.value);
    }
  }
}
