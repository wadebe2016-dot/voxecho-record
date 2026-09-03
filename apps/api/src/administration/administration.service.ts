import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Injectable } from '@nestjs/common';
import type { InstanceSettingsResponse, ReglageInstance } from '@voxecho/shared';
import { AppConfig } from '../config/config.module';
import { PrismaService } from '../prisma/prisma.service';
import { empreinteCleMaitre, TAILLE_CLE } from '../storage/coffre';

/**
 * Lecture des réglages de l'instance — CLAUDE.md §9.22.
 *
 * Premier écran de la console : il ne change rien, il montre. C'est déjà
 * beaucoup — jusqu'ici, répondre à « quelle conservation minimale impose cette
 * instance ? » ou « à quels relais fait-elle confiance ? » supposait d'ouvrir
 * un fichier sur le serveur.
 */
@Injectable()
export class AdministrationService {
  constructor(
    private readonly config: AppConfig,
    private readonly prisma: PrismaService,
  ) {}

  private version(): string {
    try {
      const brut = readFileSync(join(__dirname, '..', '..', 'package.json'), 'utf8');
      return (JSON.parse(brut) as { version?: string }).version ?? 'inconnue';
    } catch {
      return 'inconnue';
    }
  }

  /** Empreinte publique de la clé maître, ou son absence. Jamais la clé. */
  private cleMaitre(): string {
    const brut = this.config.get('STORAGE_MASTER_KEY');
    if (brut === '') return 'aucune clé configurée';
    const cle = Buffer.from(brut, 'base64');
    if (cle.length !== TAILLE_CLE) return 'clé de taille invalide';
    return empreinteCleMaitre(cle);
  }

  async reglages(): Promise<InstanceSettingsResponse> {
    const chiffre = this.config.get('STORAGE_ENCRYPTION_ENABLED');

    const conservation: ReglageInstance[] = [
      {
        cle: 'RETENTION_MIN_DAYS',
        valeur: String(this.config.get('RETENTION_MIN_DAYS')),
        effet:
          'Plancher de conservation de l’instance. Une politique plus courte exige un motif écrit, conservé et inscrit au journal.',
        raisonLectureSeule:
          'Un plancher qu’on abaisse d’un clic ne protège plus rien : il se règle à l’installation, pas en cours d’exploitation (§9.6).',
      },
    ];

    const preuve: ReglageInstance[] = [
      {
        cle: 'STORAGE_ENCRYPTION_ENABLED',
        valeur: chiffre ? 'actif' : 'inactif',
        effet: chiffre
          ? 'Les pièces rangées à partir de maintenant sont scellées en AES-256-GCM par trames.'
          : 'Les pièces sont rangées en clair. L’api sait lire les deux formats.',
      },
      {
        cle: 'STORAGE_KEY_REF',
        valeur: this.config.get('STORAGE_KEY_REF'),
        effet: 'Référence de la clé en service, inscrite sur chaque pièce scellée.',
      },
      {
        cle: 'Empreinte de la clé maître',
        valeur: this.cleMaitre(),
        effet:
          'Reconnaît la clé sans la révéler : c’est elle qu’une sauvegarde retient pour vérifier, le jour d’une restauration, qu’on détient la bonne.',
        raisonLectureSeule: 'La clé elle-même ne quitte jamais l’environnement d’exécution.',
      },
    ];

    const acces: ReglageInstance[] = [
      {
        cle: 'TRUSTED_PROXIES',
        valeur: this.config.get('TRUSTED_PROXIES') || 'aucun relais déclaré',
        effet:
          'Relais dont l’en-tête X-Forwarded-For est cru. C’est ce qui décide de l’adresse inscrite au journal d’audit.',
        raisonLectureSeule:
          'Modifiable depuis la console, un compte compromis déclarerait confiance à tout le monde et se rendrait invisible du journal (§9.16).',
      },
      {
        cle: 'API_BEHIND_TLS',
        valeur: this.config.get('API_BEHIND_TLS') ? 'oui' : 'non',
        effet: 'Commande l’émission de HSTS, qu’il serait malhonnête de promettre en clair.',
      },
      {
        cle: 'JWT_ACCESS_TTL',
        valeur: this.config.get('JWT_ACCESS_TTL'),
        effet: 'Durée d’un jeton d’accès, donc délai au bout duquel une révocation prend effet.',
      },
      {
        cle: 'AUTH_MAX_FAILED_ATTEMPTS',
        valeur: String(this.config.get('AUTH_MAX_FAILED_ATTEMPTS')),
        effet: 'Échecs tolérés avant verrouillage temporaire d’un compte.',
      },
      {
        cle: 'AUTH_RATE_MAX',
        valeur: `${this.config.get('AUTH_RATE_MAX')} échec(s) / ${this.config.get('AUTH_RATE_WINDOW_SEC')} s`,
        effet: 'Limitation par adresse, qui freine le balayage de comptes.',
      },
    ];

    const capture: ReglageInstance[] = [
      {
        cle: 'INGEST_DIR',
        valeur: this.config.get('INGEST_DIR'),
        effet: 'Répertoire surveillé, où la capture dépose la paire wav + json du contrat §3.',
      },
      {
        cle: 'STORAGE_DIR',
        valeur: this.config.get('STORAGE_DIR'),
        effet: 'Destination probante, rangée par identifiant de locataire puis par mois.',
      },
      {
        cle: 'QUARANTINE_DIR',
        valeur: this.config.get('QUARANTINE_DIR'),
        effet: 'Dépôts écartés. Rien n’y est supprimé silencieusement.',
      },
      {
        cle: 'INGEST_POLL_MS',
        valeur: `${this.config.get('INGEST_POLL_MS')} ms`,
        effet: 'Période de balayage du répertoire d’ingestion.',
      },
    ];

    const locataires = await this.prisma.tenant.findMany({
      orderBy: { name: 'asc' },
      select: {
        id: true,
        name: true,
        slug: true,
        active: true,
        _count: { select: { users: true, recordings: true } },
      },
    });

    return {
      version: this.version(),
      evaluation: this.config.get('INSTANCE_EVALUATION'),
      groupes: [
        { titre: 'Conservation', reglages: conservation },
        { titre: 'Preuve et chiffrement', reglages: preuve },
        { titre: 'Accès et sessions', reglages: acces },
        { titre: 'Capture et stockage', reglages: capture },
      ],
      locataires: locataires.map((locataire) => ({
        id: locataire.id,
        nom: locataire.name,
        slug: locataire.slug,
        actif: locataire.active,
        comptes: locataire._count.users,
        enregistrements: locataire._count.recordings,
      })),
    };
  }
}
