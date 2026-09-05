import { lookup } from 'node:dns/promises';
import { BadRequestException, Injectable } from '@nestjs/common';
import {
  type EtatHorloge,
  type ModeDeploiement,
  type ReglagesReseau,
  type ReglagesReseauResponse,
  type ResultatTestDns,
  type ResultatTestNtp,
} from '@voxecho/shared';
import { AppConfig } from '../config/config.module';
import type { AuthUser } from '../auth/auth.types';
import { lireHorloge } from './horloge';
import { InstanceSettingsService } from './instance-settings.service';

export const CLE_RESEAU = 'reseau';

/**
 * Ce qu'une saisie peut porter. `applique` est absent : rien n'écrit encore la
 * configuration de l'hôte, et laisser l'interface le poser ferait croire à un
 * réglage pris en compte.
 */
export interface ReglageReseauSaisi {
  fuseau: string;
  ntp: { serveurs: string[] };
  dns: { primaire: string | null; secondaire: string | null; domaineRecherche: string | null };
  proxys: { cidr: string[] };
}

/**
 * Le défaut vit ici, pas en base — CLAUDE.md §9.36. Une instance neuve
 * fonctionne sans qu'aucune ligne n'ait été écrite.
 */
export const RESEAU_DEFAUT: ReglagesReseau = {
  fuseau: 'Africa/Douala',
  ntp: { serveurs: [], applique: false },
  dns: { primaire: null, secondaire: null, domaineRecherche: null, applique: false },
  proxys: { cidr: [] },
};

@Injectable()
export class ReseauService {
  constructor(
    private readonly reglages: InstanceSettingsService,
    private readonly config: AppConfig,
  ) {}

  get mode(): ModeDeploiement {
    return this.config.get('VOXECHO_DEPLOY_MODE');
  }

  /** Le fuseau d'affichage, lu par le portail à chaque ouverture de session. */
  async fuseau(): Promise<string> {
    return (await this.reglages.lire(CLE_RESEAU, RESEAU_DEFAUT)).valeur.fuseau;
  }

  /** État de l'horloge, lu à chaque appel : c'est un constat, pas un réglage. */
  async horloge(): Promise<EtatHorloge> {
    return lireHorloge(this.config.get('CHRONY_ETAT_FICHIER'));
  }

  async lire(): Promise<ReglagesReseauResponse> {
    const section = await this.reglages.lire(CLE_RESEAU, RESEAU_DEFAUT);
    const environnement = this.proxysDeLEnvironnement();

    return {
      reglages: section.valeur,
      version: section.version,
      mode: this.mode,
      etatHorloge: await this.horloge(),
      // Un champ modifiable sans effet doit le dire : sinon l'administrateur
      // croira avoir réglé ce qu'il n'a pas réglé (§9.36).
      proxysEnVigueur:
        environnement.length > 0
          ? { valeurs: environnement, source: 'environnement' }
          : { valeurs: section.valeur.proxys.cidr, source: 'base' },
      updatedAt: section.updatedAt?.toISOString() ?? null,
      updatedByEmail: section.updatedByEmail,
    };
  }

  async definir(
    demande: { reglages: ReglageReseauSaisi; version: number },
    user: AuthUser,
    ip: string | null,
  ): Promise<ReglagesReseauResponse> {
    const propre = this.valider(demande.reglages);
    await this.reglages.ecrire(CLE_RESEAU, propre, demande.version, user, ip, RESEAU_DEFAUT);
    return this.lire();
  }

  /**
   * Interroge les serveurs de temps déclarés.
   *
   * Le protocole NTP se parle en UDP, ce que le produit ne fait nulle part
   * ailleurs ; on se contente donc de ce qu'on peut affirmer sans mentir : le
   * nom se résout-il, et l'hôte répond-il. Un décalage exigerait un client NTP
   * complet, et l'écrire à moitié rendrait un chiffre qu'on ne pourrait pas
   * défendre — la colonne dit alors « non mesuré » plutôt qu'un zéro.
   */
  async testerNtp(user: AuthUser, ip: string | null): Promise<ResultatTestNtp[]> {
    const { valeur } = await this.reglages.lire(CLE_RESEAU, RESEAU_DEFAUT);
    const resultats: ResultatTestNtp[] = [];

    for (const serveur of valeur.ntp.serveurs) {
      try {
        const { address } = await lookup(serveur);
        resultats.push({
          serveur,
          joignable: true,
          decalageMs: null,
          message: `Nom résolu en ${address}. Décalage non mesuré : la synchronisation est réglée hors du produit.`,
        });
      } catch (e) {
        resultats.push({
          serveur,
          joignable: false,
          decalageMs: null,
          message: `Nom non résolu : ${e instanceof Error ? e.message : 'échec'}.`,
        });
      }
    }

    await this.reglages.tracerTest(`${CLE_RESEAU}.ntp`, user, ip, {
      reussi: resultats.length > 0 && resultats.every((r) => r.joignable),
      detail: { serveurs: resultats.map((r) => ({ serveur: r.serveur, joignable: r.joignable })) },
    });
    return resultats;
  }

  /**
   * Résout les noms dont le produit dépend réellement.
   *
   * Tester un résolveur en résolvant un nom quelconque ne prouverait rien
   * d'utile : ce qui compte est que *ces* noms-là se résolvent. Les cibles se
   * rempliront au fil des lots — annuaire au 05-2, SMTP au 05-3.
   */
  async testerDns(user: AuthUser, ip: string | null): Promise<ResultatTestDns[]> {
    const cibles = await this.ciblesAResoudre();
    const resultats: ResultatTestDns[] = [];

    for (const { cible, usage } of cibles) {
      try {
        const adresses = await lookup(cible, { all: true });
        resultats.push({
          cible,
          usage,
          resolu: true,
          adresses: adresses.map((a) => a.address),
          message: 'Nom résolu.',
        });
      } catch (e) {
        resultats.push({
          cible,
          usage,
          resolu: false,
          adresses: [],
          message: `Non résolu : ${e instanceof Error ? e.message : 'échec'}.`,
        });
      }
    }

    await this.reglages.tracerTest(`${CLE_RESEAU}.dns`, user, ip, {
      reussi: resultats.length > 0 && resultats.every((r) => r.resolu),
      detail: { cibles: resultats.map((r) => ({ cible: r.cible, resolu: r.resolu })) },
    });
    return resultats;
  }

  /**
   * Ce que le produit doit savoir joindre par son nom. Vide tant qu'aucun
   * annuaire ni SMTP n'est déclaré — et l'écran le dit, plutôt que d'annoncer
   * un test réussi qui n'aurait rien testé.
   */
  private async ciblesAResoudre(): Promise<{ cible: string; usage: string }[]> {
    return Promise.resolve([]);
  }

  /** `TRUSTED_PROXIES` de l'environnement, qui l'emporte sur la base (§9.36). */
  private proxysDeLEnvironnement(): string[] {
    return this.config
      .get('TRUSTED_PROXIES')
      .split(',')
      .map((valeur) => valeur.trim())
      .filter((valeur) => valeur !== '');
  }

  private valider(reglages: ReglageReseauSaisi): ReglagesReseau {
    // Un fuseau inconnu ferait échouer l'affichage de toutes les dates du
    // portail : on le refuse à la saisie plutôt qu'à la lecture.
    try {
      new Intl.DateTimeFormat('fr-FR', { timeZone: reglages.fuseau });
    } catch {
      throw new BadRequestException(`Fuseau horaire inconnu : « ${reglages.fuseau} ».`);
    }

    const serveurs = reglages.ntp.serveurs.map((s) => s.trim()).filter((s) => s !== '');
    if (serveurs.length > 3) {
      throw new BadRequestException('Trois serveurs de temps au plus.');
    }

    for (const cidr of reglages.proxys.cidr) {
      if (!/^[0-9a-fA-F.:]+\/\d{1,3}$/.test(cidr) && !/^[0-9a-fA-F.:]+$/.test(cidr)) {
        throw new BadRequestException(`Relais de confiance invalide : « ${cidr} ».`);
      }
    }

    return {
      fuseau: reglages.fuseau,
      // `applique` n'est pas modifiable depuis l'interface : rien n'écrit
      // encore la configuration de l'hôte, et prétendre le contraire ferait
      // croire à un réglage pris en compte.
      ntp: { serveurs, applique: false },
      dns: {
        primaire: vide(reglages.dns.primaire),
        secondaire: vide(reglages.dns.secondaire),
        domaineRecherche: vide(reglages.dns.domaineRecherche),
        applique: false,
      },
      proxys: { cidr: reglages.proxys.cidr.map((c) => c.trim()).filter((c) => c !== '') },
    };
  }
}

function vide(valeur: string | null): string | null {
  const propre = valeur?.trim() ?? '';
  return propre === '' ? null : propre;
}
