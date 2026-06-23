/** @type {import('jest').Config} */
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  roots: ['<rootDir>/src'],
  testMatch: [
    '**/__tests__/**/*.test.ts',
    '**/*.test.ts',
  ],
  transform: {
    '^.+\\.tsx?$': [
      'ts-jest',
      {
        tsconfig: {
          // Override for Jest — needs CommonJS + Node resolution
          module: 'CommonJS',
          moduleResolution: 'Node',
          strict: true,
          noUncheckedIndexedAccess: true,
          esModuleInterop: true,
          skipLibCheck: true,
        },
      },
    ],
  },
  collectCoverageFrom: [
    'src/money/money.ts',
    'src/time/time.ts',
    'src/inventory/stock.ts',
    'src/id/id.ts',
    '!src/**/*.test.ts',
    '!src/**/__tests__/**',
  ],
  coverageThreshold: {
    global: {
      lines: 90,
    },
  },
};
