module.exports = {
  testEnvironment: 'node',
  testMatch: ['<rootDir>/__tests__/**/*.test.js'],
  testPathIgnorePatterns: ['/node_modules/', '/.claude/'],
  collectCoverageFrom: [
    'lib/**/*.js',
    'server.js',
    'technicalAnalysis.js',
    'telegramBot.js',
    'portfolioManager.js',
    'security.js',
    '!node_modules/**',
  ],
  coverageDirectory: 'coverage',
  verbose: true,
};
