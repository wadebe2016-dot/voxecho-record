import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
    // Les tests de dépôt écrivent de vrais WAV sur un vrai système de
    // fichiers — jusqu'à cinquante appels de dix minutes. Le défaut de cinq
    // secondes tient sur une machine au repos et lâche dès que les quatre
    // paquets du dépôt sont testés en parallèle.
    testTimeout: 30_000,
  },
});
