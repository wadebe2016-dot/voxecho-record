import { rm } from 'node:fs/promises';
import request from 'supertest';
import type { INestApplication } from '@nestjs/common';
import type { PrismaClient } from '@prisma/client';
import { compteDemo, LONGUEUR_MINIMALE } from '../src/demo/comptes-demo';
import { deposerJeuDeDemonstration, SLUG_DEMONSTRATION } from '../src/demo/depots-demo';
import { IngestionService } from '../src/ingestion/ingestion.service';
import { createTestApp } from './helpers/app';
import { createTestPrisma, resetTestData } from './helpers/database';

/**
 * Instance de démonstration — CLAUDE.md §9.18.
 */
describe('instance de démonstration', () => {
  describe('comptes du jeu de démonstration', () => {
    const env = (motDePasse: string): NodeJS.ProcessEnv => ({ DEMO_ADMIN_PASSWORD: motDePasse });

    it('refuse un mot de passe absent, court, ou laissé à sa valeur d’exemple', () => {
      // Ces comptes vivent sur une instance publique : un mot de passe
      // devinable y ouvrirait un portail qui sert de l'audio et un journal.
      expect(() => compteDemo('ADMIN', 'DEMO_ADMIN', 'a@b.cm', {})).toThrow(
        new RegExp(`${LONGUEUR_MINIMALE} caractères`),
      );
      expect(() => compteDemo('ADMIN', 'DEMO_ADMIN', 'a@b.cm', env('court'))).toThrow(/caractères/);
      expect(() => compteDemo('ADMIN', 'DEMO_ADMIN', 'a@b.cm', env('changeme-vraiment'))).toThrow(
        /valeur d’exemple|d'exemple/,
      );
      expect(() => compteDemo('ADMIN', 'DEMO_ADMIN', 'a@b.cm', env('Demo!2026-portail'))).toThrow(
        /exemple/,
      );
    });

    it('accepte un mot de passe tiré au hasard, et garde l’adresse fournie', () => {
      const compte = compteDemo('AUDITOR', 'DEMO_ADMIN', 'defaut@demo.cm', {
        DEMO_ADMIN_EMAIL: 'auditeur@demo.voxecho.cm',
        DEMO_ADMIN_PASSWORD: 'K7pQ2vX9mLd4RtY6',
      });
      expect(compte).toEqual({
        role: 'AUDITOR',
        email: 'auditeur@demo.voxecho.cm',
        motDePasse: 'K7pQ2vX9mLd4RtY6',
      });
    });
  });

  describe('ce que le portail apprend avant connexion', () => {
    let app: INestApplication;

    beforeAll(async () => {
      app = await createTestApp();
    });

    afterAll(async () => {
      await app.close();
    });

    it('répond sans jeton, et dit ce que vaut INSTANCE_DEMO', async () => {
      // Publique par nécessité : la mention doit s'afficher sur l'écran de
      // connexion, avant qu'aucune session n'existe.
      const reponse = await request(app.getHttpServer()).get('/api/instance').expect(200);
      expect(reponse.body).toEqual({ demo: false });
    });
  });

  describe('jeu de démonstration', () => {
    let app: INestApplication;
    let prisma: PrismaClient;
    const ingestDir = process.env.INGEST_DIR as string;
    const storageDir = process.env.STORAGE_DIR as string;

    beforeAll(async () => {
      prisma = createTestPrisma();
      await prisma.$connect();
      app = await createTestApp();
    });

    afterAll(async () => {
      await resetTestData(prisma);
      await prisma.$disconnect();
      await app.close();
      await rm(ingestDir, { recursive: true, force: true });
      await rm(storageDir, { recursive: true, force: true });
    });

    it('dépose des appels que l’ingestion du produit accepte', async () => {
      await resetTestData(prisma);
      await rm(ingestDir, { recursive: true, force: true });
      const locataire = await prisma.tenant.create({
        data: { name: 'Banque de la CEMAC (démonstration)', slug: SLUG_DEMONSTRATION },
      });

      // Le jeu de démonstration passe par INGEST_DIR, comme la capture : si un
      // seul de ses dépôts n'était pas conforme au contrat §3, la
      // démonstration s'ouvrirait sur des quarantaines.
      const depot = await deposerJeuDeDemonstration({
        ingestDir,
        jours: 3,
        dureeMaxSec: 4,
      });
      await app.get(IngestionService).scan();

      const ranges = await prisma.recording.count({ where: { tenantId: locataire.id } });
      expect(ranges).toBe(depot.appels);
      expect(await prisma.auditEvent.count({ where: { action: 'INGEST' } })).toBe(depot.appels);

      // Et le dépôt volontairement malformé fait exactement une quarantaine :
      // le tableau de bord doit pouvoir montrer que la chaîne écarte sans
      // détruire en silence (§9.12).
      expect(await prisma.auditEvent.count({ where: { action: 'QUARANTINE' } })).toBe(
        depot.quarantaines,
      );
    }, 120_000);
  });
});
