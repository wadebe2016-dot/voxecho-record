import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { AppConfigModule } from '../src/config/config.module';
import { HealthModule } from '../src/health/health.module';

describe('sonde de vie', () => {
  let app: INestApplication;

  beforeAll(async () => {
    // `InstanceController` lit la configuration validée (§9.18) : la sonde se
    // monte donc avec le module qui la fournit, comme le fait l'application.
    const moduleRef = await Test.createTestingModule({
      imports: [AppConfigModule, HealthModule],
    }).compile();
    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api');
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  it('répond ok sans authentification', async () => {
    const response = await request(app.getHttpServer()).get('/api/health').expect(200);
    expect(response.body.status).toBe('ok');
    expect(response.body.service).toBe('voxecho-record-api');
    expect(Date.parse(response.body.time)).not.toBeNaN();
  });
});
