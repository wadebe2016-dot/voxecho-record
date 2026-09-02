import { corsOrigins, validateEnv } from '../src/config/env.schema';

const base = {
  DATABASE_URL: 'postgresql://voxecho:secret@localhost:5432/voxecho?schema=public',
  JWT_ACCESS_SECRET: 'a'.repeat(48),
  JWT_REFRESH_SECRET: 'b'.repeat(48),
};

describe('validation de la configuration', () => {
  it('accepte un environnement minimal et applique les valeurs par défaut', () => {
    const env = validateEnv({ ...base });
    expect(env.NODE_ENV).toBe('development');
    expect(env.TZ).toBe('Africa/Douala');
    expect(env.API_PORT).toBe(3000);
    expect(env.JWT_ACCESS_TTL).toBe('15m');
    expect(env.AUTH_MAX_FAILED_ATTEMPTS).toBe(5);
    expect(env.INGEST_DIR).toBe('./data/ingest');
  });

  it('lit « false » comme faux : une chaîne non vide ne vaut pas activation', () => {
    // `z.coerce.boolean()` accepterait « false » comme vrai et laisserait un
    // balayage tourner là où l'exploitant l'a explicitement coupé.
    expect(validateEnv({ ...base }).INGEST_POLL_ENABLED).toBe(true);
    expect(validateEnv({ ...base, INGEST_POLL_ENABLED: 'false' }).INGEST_POLL_ENABLED).toBe(false);
    expect(() => validateEnv({ ...base, INGEST_POLL_ENABLED: 'oui' })).toThrow();
  });

  it('convertit les nombres fournis en chaînes', () => {
    const env = validateEnv({ ...base, API_PORT: '8080', AUTH_LOCK_DURATION_MIN: '30' });
    expect(env.API_PORT).toBe(8080);
    expect(env.AUTH_LOCK_DURATION_MIN).toBe(30);
  });

  it('refuse une URL de base de données absente', () => {
    const { DATABASE_URL: _omis, ...sansBase } = base;
    expect(() => validateEnv(sansBase)).toThrow(/DATABASE_URL/);
  });

  it('refuse un secret laissé à sa valeur d’exemple', () => {
    expect(() => validateEnv({ ...base, JWT_ACCESS_SECRET: 'changeme-access-secret' })).toThrow(
      /JWT_ACCESS_SECRET/,
    );
  });

  it('refuse un secret trop court', () => {
    expect(() => validateEnv({ ...base, JWT_REFRESH_SECRET: 'court' })).toThrow(
      /JWT_REFRESH_SECRET/,
    );
  });

  it('refuse deux secrets identiques', () => {
    expect(() => validateEnv({ ...base, JWT_REFRESH_SECRET: base.JWT_ACCESS_SECRET })).toThrow(
      /doivent différer/,
    );
  });

  it('refuse une durée de jeton mal formée', () => {
    expect(() => validateEnv({ ...base, JWT_ACCESS_TTL: '15 minutes' })).toThrow(/JWT_ACCESS_TTL/);
  });

  it('signale tous les manques d’un coup', () => {
    let message = '';
    try {
      validateEnv({});
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toContain('DATABASE_URL');
    expect(message).toContain('JWT_ACCESS_SECRET');
    expect(message).toContain('JWT_REFRESH_SECRET');
  });
});

describe('origines autorisées', () => {
  it('découpe et nettoie la liste', () => {
    expect(corsOrigins('http://localhost:5173, https://portail.exemple.cm ')).toEqual([
      'http://localhost:5173',
      'https://portail.exemple.cm',
    ]);
  });

  it('rend une liste vide pour une chaîne vide', () => {
    expect(corsOrigins('')).toEqual([]);
  });
});
