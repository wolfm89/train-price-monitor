// The repo-level mise env sets NODE_ENV=development. aws-cdk-lib 2.275 then
// instruments fs.realpathSync, which recurses inside Jest's module resolver.
process.env.NODE_ENV = 'test';

module.exports = {
  testEnvironment: 'node',
  roots: ['<rootDir>/test'],
  testMatch: ['**/*.test.ts'],
  // `tsc` emits .js next to .ts (no outDir); prefer the source so a stale build
  // artifact cannot shadow the refactored module under ts-jest.
  moduleFileExtensions: ['ts', 'tsx', 'js', 'json', 'node'],
  transform: {
    '^.+\\.tsx?$': 'ts-jest',
  },
  // ts-jest loads aws-cdk-lib, so each worker holds roughly 1.5 GB. The default
  // (one worker per CPU) has pushed a 17.6 GB WSL VM into OOM when other work
  // ran alongside; two workers keep the suite under ~3 GB.
  maxWorkers: 2,
  workerIdleMemoryLimit: '2GB',
};
