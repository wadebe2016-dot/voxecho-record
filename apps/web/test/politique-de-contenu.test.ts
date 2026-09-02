import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Politique de contenu du portail — CLAUDE.md §9.16.
 *
 * `nginx.conf` sert une CSP sans `'unsafe-inline'`. Une telle politique ne
 * protège que si le portail n'a effectivement rien en ligne : le jour où un
 * outil de construction émettrait un `<script>` ou un `<style>` dans la page,
 * le portail cesserait de fonctionner **en production seulement**, là où
 * aucun test ne regarde. Ce test construit donc pour de bon et relit le
 * résultat.
 *
 * Il relit aussi la configuration nginx : une CSP qu'on aurait affaiblie pour
 * faire passer un correctif doit se voir en revue, pas se découvrir plus tard.
 */
describe('politique de contenu', () => {
  it('la configuration nginx sert une CSP sans autorisation d’inline', () => {
    const conf = readFileSync(join(__dirname, '..', 'nginx.conf'), 'utf8');
    const ligne = conf.split('\n').find((l) => l.includes('Content-Security-Policy'));

    expect(ligne).toBeDefined();
    expect(ligne).not.toContain('unsafe-inline');
    expect(ligne).not.toContain('unsafe-eval');
    for (const directive of [
      "default-src 'self'",
      "object-src 'none'",
      "base-uri 'none'",
      "frame-ancestors 'none'",
      "media-src 'self'",
    ]) {
      expect(ligne).toContain(directive);
    }
  });

  it('le portail construit ne contient ni script ni style en ligne', () => {
    const sortie = mkdtempSync(join(tmpdir(), 'voxecho-csp-'));
    try {
      execFileSync('pnpm', ['exec', 'vite', 'build', '--outDir', sortie, '--emptyOutDir'], {
        cwd: join(__dirname, '..'),
        stdio: 'pipe',
      });

      const pages = readdirSync(sortie).filter((nom) => nom.endsWith('.html'));
      expect(pages.length).toBeGreaterThan(0);

      for (const page of pages) {
        const html = readFileSync(join(sortie, page), 'utf8');
        // Un <script> sans src porte du code en ligne ; idem pour <style>.
        expect(html).not.toMatch(/<script(?![^>]*\bsrc=)[^>]*>[\s\S]*?\S[\s\S]*?<\/script>/i);
        expect(html).not.toMatch(/<style[^>]*>[\s\S]*?\S[\s\S]*?<\/style>/i);
        expect(html).not.toMatch(/\son\w+=/i);
      }
    } finally {
      rmSync(sortie, { recursive: true, force: true });
    }
  }, 180_000);
});
