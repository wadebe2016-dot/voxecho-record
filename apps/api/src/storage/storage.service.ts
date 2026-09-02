import { createReadStream } from 'node:fs';
import { readFile, rename, writeFile } from 'node:fs/promises';
import type { Readable } from 'node:stream';
import { Injectable, Logger } from '@nestjs/common';
import { AppConfig } from '../config/config.module';
import { estConteneur, ouvrir, premiersOctets, sceller, fluxDeClair, TAILLE_CLE } from './coffre';

/** Ce qu'il faut savoir d'un enregistrement pour ouvrir son fichier. */
export interface PieceStockee {
  recordingId: string;
  chemin: string;
  encrypted: boolean;
}

/**
 * Accès au stockage — CLAUDE.md §8 et §9.13.
 *
 * Le reste de l'api ne sait pas si une pièce est chiffrée : elle demande des
 * octets de clair et en reçoit. C'est ce qui permet au chiffrement d'être
 * activé, ou introduit progressivement, sans que la réécoute, l'export ou la
 * purge aient à en tenir compte.
 */
@Injectable()
export class StorageService {
  private readonly logger = new Logger(StorageService.name);
  private readonly cleMaitre: Buffer | null;
  private readonly actif: boolean;
  private readonly reference: string;

  constructor(config: AppConfig) {
    this.actif = config.get('STORAGE_ENCRYPTION_ENABLED');
    this.reference = config.get('STORAGE_KEY_REF');
    const brut = config.get('STORAGE_MASTER_KEY');
    this.cleMaitre = brut === '' ? null : Buffer.from(brut, 'base64');

    if (this.actif) {
      if (this.cleMaitre === null || this.cleMaitre.length !== TAILLE_CLE) {
        // La validation d'environnement le refuse déjà ; ce garde-fou existe
        // pour qu'un chemin de test ne puisse pas contourner la règle.
        throw new Error(
          `STORAGE_MASTER_KEY absente ou de mauvaise taille : ${TAILLE_CLE} octets en base64 attendus.`,
        );
      }
      this.logger.log(`Chiffrement au repos actif (clé « ${this.reference} »)`);
    }
  }

  /** Le chiffrement s'applique-t-il aux pièces nouvellement rangées ? */
  get chiffrementActif(): boolean {
    return this.actif;
  }

  /** Référence de la clé maître en service, consignée sur l'enregistrement. */
  get referenceCle(): string {
    return this.reference;
  }

  /**
   * Range une pièce : telle quelle, ou scellée si le chiffrement est actif.
   * Rend ce qu'il faut inscrire en base.
   */
  async ranger(
    cheminClair: string,
    recordingId: string,
  ): Promise<{ encrypted: boolean; keyRef: string | null }> {
    if (!this.actif || this.cleMaitre === null) return { encrypted: false, keyRef: null };

    const clair = await readFile(cheminClair);
    const conteneur = sceller(clair, this.cleMaitre, recordingId);

    // Écriture à côté puis bascule : une coupure de courant laisse l'ancien
    // fichier intact plutôt qu'un conteneur à moitié écrit.
    const provisoire = `${cheminClair}.coffre`;
    await writeFile(provisoire, conteneur);
    await rename(provisoire, cheminClair);

    return { encrypted: true, keyRef: this.reference };
  }

  /**
   * Flux de clair pour une plage d'octets, bornes incluses. Une pièce en clair
   * est lue directement ; une pièce scellée n'ouvre que les trames concernées.
   */
  fluxPartiel(piece: PieceStockee, debut: number, fin: number): Readable {
    if (!piece.encrypted) return createReadStream(piece.chemin, { start: debut, end: fin });
    return fluxDeClair(piece.chemin, this.exigerCle(), piece.recordingId, debut, fin);
  }

  /** Clair entier d'une pièce — pour l'export, qui en a besoin d'un bloc. */
  async lireEntier(piece: PieceStockee): Promise<Buffer> {
    const brut = await readFile(piece.chemin);
    if (!piece.encrypted) return brut;
    return ouvrir(brut, this.exigerCle(), piece.recordingId);
  }

  /**
   * Le fichier sur disque est-il un conteneur ? La base fait foi, mais un
   * outil d'administration a besoin de constater l'état réel du disque.
   */
  async estScelle(chemin: string): Promise<boolean> {
    return estConteneur(await premiersOctets(chemin));
  }

  private exigerCle(): Buffer {
    if (this.cleMaitre === null) {
      // Une pièce chiffrée sans clé en service est un incident d'exploitation,
      // pas une requête invalide : on le dit clairement.
      throw new Error(
        'Pièce chiffrée mais aucune clé maître n’est configurée : vérifier STORAGE_MASTER_KEY.',
      );
    }
    return this.cleMaitre;
  }
}
