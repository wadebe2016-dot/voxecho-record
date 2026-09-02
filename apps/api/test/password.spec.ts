import { hashPassword, verifyPassword } from '../src/auth/password';

describe('hachage des mots de passe', () => {
  it('produit un hachage Argon2id distinct du mot de passe', async () => {
    const hash = await hashPassword('Demo!2026');
    expect(hash).toMatch(/^\$argon2id\$/);
    expect(hash).not.toContain('Demo!2026');
  });

  it('produit un hachage différent à chaque appel (sel aléatoire)', async () => {
    const [a, b] = await Promise.all([hashPassword('Demo!2026'), hashPassword('Demo!2026')]);
    expect(a).not.toBe(b);
  });

  it('valide le bon mot de passe et rejette les autres', async () => {
    const hash = await hashPassword('Demo!2026');
    await expect(verifyPassword(hash, 'Demo!2026')).resolves.toBe(true);
    await expect(verifyPassword(hash, 'demo!2026')).resolves.toBe(false);
    await expect(verifyPassword(hash, '')).resolves.toBe(false);
  });

  it('ne lève pas sur un hachage corrompu', async () => {
    await expect(verifyPassword('pas-un-hachage', 'Demo!2026')).resolves.toBe(false);
  });
});
