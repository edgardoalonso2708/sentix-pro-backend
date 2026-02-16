module.exports = {
  testEnvironment: 'node',
  testMatch: ['**/__tests__/**/*.test.js'],
  collectCoverageFrom: [
    'lib/**/*.js',
    'server.js',
    '!node_modules/**',
  ],
  coverageDirectory: 'coverage',
  verbose: true,
};
