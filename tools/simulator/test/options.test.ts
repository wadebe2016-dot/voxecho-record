import { describe, expect, it } from 'vitest';
import { DEFAUTS, parseOptions, parseRate } from '../src/options';

const options = (argv: string[], env: NodeJS.ProcessEnv = {}) => {
  const resultat = parseOptions(argv, env);
  if (!resultat.ok) throw new Error(resultat.errors.join(' ; '));
  return resultat.value;
};

describe('lecture du débit', () => {
  it.each([
    ['10/min', 10],
    ['10 / min', 10],
    ['3/mn', 3],
    ['120/minute', 120],
    ['7', 7],
  ])('lit « %s »', (brut, attendu) => {
    expect(parseRate(brut)).toBe(attendu);
  });

  it.each(['0/min', '-4/min', 'dix/min', '10/heure', ''])('refuse « %s »', (brut) => {
    expect(parseRate(brut)).toBeNull();
  });
});

describe('analyse de la ligne de commande', () => {
  it('sans argument, dépose un appel dans le locataire par défaut', () => {
    const parsees = options([]);
    expect(parsees.mode).toBe('one');
    expect(parsees.tenants).toEqual([DEFAUTS.tenant]);
    expect(parsees.corrupt).toBe(false);
  });

  it('lit les trois modes du §4', () => {
    expect(options(['--one']).mode).toBe('one');
    expect(options(['--batch', '50'])).toMatchObject({ mode: 'batch', count: 50 });
    expect(options(['--continuous', '10/min'])).toMatchObject({ mode: 'continuous', rate: 10 });
  });

  it('accepte plusieurs locataires', () => {
    expect(options(['--tenant', 'banque-cemac,mfi-b']).tenants).toEqual(['banque-cemac', 'mfi-b']);
  });

  it('refuse un slug qui ne pourrait pas être un répertoire du contrat §3', () => {
    const resultat = parseOptions(['--tenant', 'Banque CEMAC']);
    expect(resultat.ok).toBe(false);
    if (resultat.ok) return;
    expect(resultat.errors[0]).toContain('slug de locataire invalide');
  });

  it('prend INGEST_DIR de l’environnement, que --dir emporte', () => {
    expect(options([], { INGEST_DIR: '/srv/ingest' }).ingestDir).toBe('/srv/ingest');
    expect(options(['--dir', '/autre'], { INGEST_DIR: '/srv/ingest' }).ingestDir).toBe('/autre');
  });

  it('combine --corrupt avec un mode, et vaut un dépôt seul sinon', () => {
    expect(options(['--batch', '5', '--corrupt'])).toMatchObject({
      mode: 'batch',
      count: 5,
      corrupt: true,
    });
    expect(options(['--corrupt'])).toMatchObject({ mode: 'one', corrupt: true });
  });

  it('rejoue la même graine à l’identique', () => {
    expect(options(['--seed', '42']).seed).toBe(42);
  });

  it.each([
    ['entier attendu', ['--batch', 'cinquante']],
    ['valeur manquante', ['--batch']],
    ['drapeau au lieu d’une valeur', ['--batch', '--corrupt']],
    ['débit illisible', ['--continuous', 'beaucoup']],
    ['option inconnue', ['--vitesse', '3']],
    ['jours non entiers', ['--spread-days', '2.5']],
  ])('signale : %s', (_libelle, argv) => {
    expect(parseOptions(argv).ok).toBe(false);
  });

  it('rassemble toutes les erreurs d’un coup, sans s’arrêter à la première', () => {
    const resultat = parseOptions(['--batch', 'x', '--vitesse', '3']);
    expect(resultat.ok).toBe(false);
    if (resultat.ok) return;
    expect(resultat.errors).toEqual([
      '--batch attend un entier positif, reçu « x »',
      'option inconnue : --vitesse',
      'valeur isolée sans option : « 3 »',
    ]);
  });
});
