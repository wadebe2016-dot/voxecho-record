/** @type {import('jest').Config} */
module.exports = {
  rootDir: '.',
  testEnvironment: 'node',
  moduleFileExtensions: ['js', 'json', 'ts'],
  testRegex: '.*\\.spec\\.ts$',
  globalSetup: '<rootDir>/test/setup/global-setup.ts',
  setupFiles: ['<rootDir>/test/setup/env.ts'],
  transform: {
    '^.+\\.ts$': ['ts-jest', { tsconfig: '<rootDir>/tsconfig.json' }],
  },
  collectCoverageFrom: ['src/**/*.ts', '!src/main.ts', '!src/**/*.module.ts'],
  coverageDirectory: 'coverage',
  moduleNameMapper: {
    '^@voxecho/shared$': '<rootDir>/../../packages/shared/src/index.ts',
    // `packages/shared` écrit ses imports relatifs avec l'extension `.js`,
    // seule forme valable pour sa sortie ESM. Les tests lisent les sources
    // TypeScript, où le résolveur de Jest ne fait pas cette substitution.
    '^(\\.{1,2}/.*)\\.js$': '$1',
  },
  testTimeout: 20000,
};
