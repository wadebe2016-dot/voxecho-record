import { Client } from 'ldapts';
import type { AttributsAnnuaire } from '@voxecho/shared';

/**
 * Le peu qu'on demande à un annuaire — CLAUDE.md §9.37.
 *
 * L'interface est étroite à dessein : elle borne ce que le produit sait faire
 * d'un annuaire — se lier, chercher un compte, lister les comptes d'un
 * groupe — et rien de plus. Elle rend aussi le reste éprouvable sans serveur,
 * ce qui compte pour un chemin d'authentification qu'on ne veut pas découvrir
 * en production.
 */
export interface Annuaire {
  /**
   * Se lie au compte de service, puis cherche `login`.
   * Rend `null` quand le compte n'existe pas — ce qui n'est pas une erreur.
   */
  chercher(login: string): Promise<CompteAnnuaire | null>;

  /** Vérifie les identifiants d'un compte trouvé, par un second bind. */
  verifierIdentifiants(dn: string, motDePasse: string): Promise<boolean>;

  /** Tous les comptes que le produit connaît, pour la synchronisation. */
  listerParIdentifiants(identifiants: string[]): Promise<CompteAnnuaire[]>;
}

export interface CompteAnnuaire {
  dn: string;
  /** `objectGUID`, stable : il survit à un changement d'adresse ou de nom. */
  externalId: string | null;
  login: string | null;
  email: string | null;
  nomAffiche: string | null;
  groupes: string[];
}

export interface ConnexionAnnuaire {
  url: string;
  startTls: boolean;
  verifierCertificat: boolean;
  acPem: string | null;
  baseDn: string;
  bindDn: string;
  bindMotDePasse: string;
  filtre: string;
  attributs: AttributsAnnuaire;
}

/** L'annuaire n'a pas répondu. À distinguer d'un compte introuvable. */
export class AnnuaireInjoignable extends Error {
  constructor(cause: string) {
    super(`Annuaire injoignable : ${cause}`);
    this.name = 'AnnuaireInjoignable';
  }
}

/**
 * Implémentation ldapts.
 *
 * Chaque opération ouvre et referme sa propre connexion. Un pool tiendrait des
 * sockets ouvertes vers le contrôleur de domaine d'une banque pendant des
 * heures, pour un produit qui interroge l'annuaire à chaque connexion et
 * toutes les six heures — le coût d'une poignée de main TLS est ici sans
 * commune mesure avec celui d'une socket qu'on croit vivante et qui ne l'est
 * plus.
 */
export class AnnuaireLdap implements Annuaire {
  constructor(private readonly connexion: ConnexionAnnuaire) {}

  private client(): Client {
    return new Client({
      url: this.connexion.url,
      timeout: 10_000,
      connectTimeout: 10_000,
      tlsOptions: {
        // Refuser un certificat inconnu est le défaut ; le contraire ne vaut
        // qu'en laboratoire, et l'écran le dit.
        rejectUnauthorized: this.connexion.verifierCertificat,
        ...(this.connexion.acPem === null ? {} : { ca: [this.connexion.acPem] }),
      },
    });
  }

  /** Ouvre, exécute, referme — quoi qu'il arrive. */
  private async avec<T>(travail: (client: Client) => Promise<T>): Promise<T> {
    const client = this.client();
    try {
      if (this.connexion.startTls) await client.startTLS({});
      return await travail(client);
    } catch (e) {
      if (e instanceof AnnuaireInjoignable) throw e;
      throw new AnnuaireInjoignable(e instanceof Error ? e.message : 'cause inconnue');
    } finally {
      await client.unbind().catch(() => undefined);
    }
  }

  async chercher(login: string): Promise<CompteAnnuaire | null> {
    return this.avec(async (client) => {
      await client.bind(this.connexion.bindDn, this.connexion.bindMotDePasse);
      const { searchEntries } = await client.search(this.connexion.baseDn, {
        scope: 'sub',
        filter: this.connexion.filtre.replace('{login}', echapperFiltre(login)),
        attributes: [...Object.values(this.connexion.attributs), 'objectGUID'],
      });
      const entree = searchEntries[0];
      return entree === undefined ? null : this.versCompte(entree);
    });
  }

  async verifierIdentifiants(dn: string, motDePasse: string): Promise<boolean> {
    const client = this.client();
    try {
      if (this.connexion.startTls) await client.startTLS({});
      await client.bind(dn, motDePasse);
      return true;
    } catch (e) {
      // Un mot de passe faux et un annuaire éteint ne se traitent pas
      // pareil : le premier refuse la personne, le second refuse tout le
      // monde et doit se voir à l'écran d'état.
      if (estRefusDIdentifiants(e)) return false;
      throw new AnnuaireInjoignable(e instanceof Error ? e.message : 'cause inconnue');
    } finally {
      await client.unbind().catch(() => undefined);
    }
  }

  async listerParIdentifiants(identifiants: string[]): Promise<CompteAnnuaire[]> {
    if (identifiants.length === 0) return [];
    return this.avec(async (client) => {
      await client.bind(this.connexion.bindDn, this.connexion.bindMotDePasse);
      const { searchEntries } = await client.search(this.connexion.baseDn, {
        scope: 'sub',
        filter: '(objectClass=*)',
        attributes: [...Object.values(this.connexion.attributs), 'objectGUID'],
      });
      return searchEntries.map((entree) => this.versCompte(entree));
    });
  }

  private versCompte(entree: Record<string, unknown>): CompteAnnuaire {
    const { attributs } = this.connexion;
    return {
      dn: String(entree.dn ?? ''),
      externalId: guid(entree.objectGUID),
      login: premier(entree[attributs.login]),
      email: premier(entree[attributs.email]),
      nomAffiche: premier(entree[attributs.nomAffiche]),
      groupes: liste(entree[attributs.groupes]),
    };
  }
}

/**
 * Échappement d'un filtre LDAP (RFC 4515).
 *
 * Sans lui, un login contenant `*)(` réécrirait le filtre : c'est l'injection
 * LDAP, et elle rendrait ici n'importe quel compte de l'annuaire.
 */
export function echapperFiltre(valeur: string): string {
  return valeur.replace(/[\\*()\0/]/g, (caractere) => {
    const code = caractere.charCodeAt(0).toString(16).padStart(2, '0');
    return `\\${code}`;
  });
}

function premier(valeur: unknown): string | null {
  if (Array.isArray(valeur)) return valeur.length > 0 ? String(valeur[0]) : null;
  if (valeur === undefined || valeur === null) return null;
  const texte = String(valeur);
  return texte === '' ? null : texte;
}

function liste(valeur: unknown): string[] {
  if (Array.isArray(valeur)) return valeur.map(String);
  if (valeur === undefined || valeur === null) return [];
  return [String(valeur)];
}

/** `objectGUID` arrive en binaire ; on le retient en hexadécimal. */
function guid(valeur: unknown): string | null {
  if (Buffer.isBuffer(valeur)) return valeur.toString('hex');
  if (Array.isArray(valeur) && Buffer.isBuffer(valeur[0])) {
    return (valeur[0] as Buffer).toString('hex');
  }
  return premier(valeur);
}

/** 49 : `invalidCredentials`. Tout le reste est un incident de service. */
function estRefusDIdentifiants(erreur: unknown): boolean {
  const code = (erreur as { code?: unknown } | null)?.code;
  return code === 49;
}
