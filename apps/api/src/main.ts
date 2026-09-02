import 'reflect-metadata';
import { Logger, ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { AppConfig } from './config/config.module';
import { corsOrigins } from './config/env.schema';
import { configurerSecuriteHttp } from './config/http';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule, { bufferLogs: true });
  const config = app.get(AppConfig);

  configurerSecuriteHttp(app, {
    trustedProxies: config.get('TRUSTED_PROXIES'),
    derriereTls: config.get('API_BEHIND_TLS'),
  });
  app.enableCors({
    origin: corsOrigins(config.get('CORS_ORIGINS')),
    credentials: true,
  });
  app.setGlobalPrefix('api');
  app.useGlobalPipes(
    new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
  );
  app.enableShutdownHooks();

  const port = config.get('API_PORT');
  await app.listen(port);
  new Logger('Bootstrap').log(`API VoxEcho Record à l'écoute sur le port ${port}`);
}

void bootstrap();
