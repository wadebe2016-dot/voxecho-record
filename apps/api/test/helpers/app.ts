import { ValidationPipe, type INestApplication } from '@nestjs/common';
import { Test, type TestingModuleBuilder } from '@nestjs/testing';
import { AppModule } from '../../src/app.module';
import { configurerSecuriteHttp } from '../../src/config/http';

export interface OptionsTestApp {
  /** Proxys déclarés, comme `TRUSTED_PROXIES` en livraison (§9.16). */
  trustedProxies?: string;
  derriereTls?: boolean;
  /** Substitution de fournisseurs, pour éprouver un réglage serré. */
  personnaliser?: (builder: TestingModuleBuilder) => TestingModuleBuilder;
}

/** Monte l'application complète (gardes globaux compris) sur le schéma de test. */
export async function createTestApp(options: OptionsTestApp = {}): Promise<INestApplication> {
  const base = Test.createTestingModule({ imports: [AppModule] });
  const moduleRef = await (options.personnaliser ? options.personnaliser(base) : base).compile();
  const app = moduleRef.createNestApplication();
  // Les mêmes réglages qu'en livraison : une protection posée seulement dans
  // `main.ts` ne serait jamais éprouvée.
  configurerSecuriteHttp(app, {
    trustedProxies: options.trustedProxies ?? '',
    derriereTls: options.derriereTls ?? false,
  });
  app.setGlobalPrefix('api');
  app.useGlobalPipes(
    new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
  );
  await app.init();
  return app;
}
