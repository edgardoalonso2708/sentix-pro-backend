// ═══════════════════════════════════════════════════════════════════════════════
// PHASE 0 HARDENING - VALIDATION TESTS
// Test new error taxonomy, logger, and security enhancements
// ═══════════════════════════════════════════════════════════════════════════════

const { ErrorType, Provider, ProviderError, classifyAxiosError } = require('../errors');
const { logger, maskValue, sanitizeData } = require('../logger');

describe('Error Taxonomy', () => {
  test('ProviderError creates correct structure', () => {
    const err = new ProviderError(Provider.COINGECKO, ErrorType.RATE_LIMIT, 'Rate limited', {
      statusCode: 429,
      endpoint: '/api/simple/price',
      retryable: true
    });

    expect(err.provider).toBe(Provider.COINGECKO);
    expect(err.type).toBe(ErrorType.RATE_LIMIT);
    expect(err.statusCode).toBe(429);
    expect(err.retryable).toBe(true);
    expect(err.endpoint).toBe('/api/simple/price');
  });

  test('classifyAxiosError identifies timeout', () => {
    const axiosError = {
      code: 'ECONNABORTED',
      message: 'timeout of 5000ms exceeded',
      config: { url: 'https://api.example.com/test' }
    };

    const err = classifyAxiosError(axiosError, Provider.COINGECKO, 'test');
    expect(err.type).toBe(ErrorType.TIMEOUT);
    expect(err.retryable).toBe(true);
  });

  test('classifyAxiosError identifies rate limit', () => {
    const axiosError = {
      response: { status: 429 },
      message: 'Request failed with status code 429',
      config: { url: 'https://api.example.com/test' }
    };

    const err = classifyAxiosError(axiosError, Provider.COINGECKO, 'test');
    expect(err.type).toBe(ErrorType.RATE_LIMIT);
    expect(err.statusCode).toBe(429);
    expect(err.retryable).toBe(true);
  });

  test('classifyAxiosError identifies server error', () => {
    const axiosError = {
      response: { status: 503 },
      message: 'Service Unavailable',
      config: { url: 'https://api.example.com/test' }
    };

    const err = classifyAxiosError(axiosError, Provider.COINGECKO, 'test');
    expect(err.type).toBe(ErrorType.SERVER_ERROR);
    expect(err.retryable).toBe(true);
  });

  test('classifyAxiosError identifies auth error', () => {
    const axiosError = {
      response: { status: 401 },
      message: 'Unauthorized',
      config: { url: 'https://api.example.com/test' }
    };

    const err = classifyAxiosError(axiosError, Provider.TELEGRAM, 'test');
    expect(err.type).toBe(ErrorType.AUTH_ERROR);
    expect(err.retryable).toBe(false);
  });

  test('classifyAxiosError identifies network error', () => {
    const axiosError = {
      code: 'ENOTFOUND',
      message: 'getaddrinfo ENOTFOUND api.example.com',
      config: { url: 'https://api.example.com/test' }
    };

    const err = classifyAxiosError(axiosError, Provider.COINCAP, 'test');
    expect(err.type).toBe(ErrorType.NETWORK_ERROR);
    expect(err.retryable).toBe(true);
  });
});

describe('Logger', () => {
  test('maskValue masks sensitive strings correctly', () => {
    const secret = 'sk-ant-1234567890abcdef';
    const masked = maskValue(secret);

    expect(masked).toContain('sk-a');
    expect(masked).toContain('cdef');
    expect(masked).toContain('****');
    expect(masked.length).toBeLessThan(secret.length);
  });

  test('maskValue handles short strings', () => {
    const short = 'abc';
    const masked = maskValue(short);
    expect(masked).toBe('***');
  });

  test('sanitizeData masks secret-looking keys', () => {
    const data = {
      username: 'john',
      api_key: 'sk-123456789012',
      password: 'secret123',
      email: 'john@example.com'
    };

    const sanitized = sanitizeData(data);
    expect(sanitized.username).toBe('john');
    expect(sanitized.email).toBe('john@example.com');
    expect(sanitized.api_key).not.toBe('sk-123456789012');
    expect(sanitized.password).not.toBe('secret123');
  });

  test('sanitizeData handles nested objects', () => {
    const data = {
      user: {
        name: 'John',
        auth: {
          token: 'bearer-xyz123456789',
          secret: 'abc123'
        }
      }
    };

    const sanitized = sanitizeData(data);
    expect(sanitized.user.name).toBe('John');
    expect(sanitized.user.auth.token).not.toBe('bearer-xyz123456789');
    expect(sanitized.user.auth.secret).not.toBe('abc123');
  });

  test('logger methods exist and are callable', () => {
    expect(typeof logger.debug).toBe('function');
    expect(typeof logger.info).toBe('function');
    expect(typeof logger.warn).toBe('function');
    expect(typeof logger.error).toBe('function');
    expect(typeof logger.providerError).toBe('function');
  });
});

describe('Provider Enum', () => {
  test('all expected providers are defined', () => {
    expect(Provider.COINGECKO).toBe('CoinGecko');
    expect(Provider.COINCAP).toBe('CoinCap');
    expect(Provider.ALTERNATIVE_ME).toBe('Alternative.me');
    expect(Provider.SUPABASE).toBe('Supabase');
    expect(Provider.RESEND).toBe('Resend');
    expect(Provider.TELEGRAM).toBe('Telegram');
  });
});

describe('ErrorType Enum', () => {
  test('all expected error types are defined', () => {
    expect(ErrorType.RATE_LIMIT).toBe('RATE_LIMIT');
    expect(ErrorType.TIMEOUT).toBe('TIMEOUT');
    expect(ErrorType.SERVER_ERROR).toBe('SERVER_ERROR');
    expect(ErrorType.CLIENT_ERROR).toBe('CLIENT_ERROR');
    expect(ErrorType.NETWORK_ERROR).toBe('NETWORK_ERROR');
    expect(ErrorType.INVALID_RESPONSE).toBe('INVALID_RESPONSE');
    expect(ErrorType.AUTH_ERROR).toBe('AUTH_ERROR');
    expect(ErrorType.UNKNOWN).toBe('UNKNOWN');
  });
});
