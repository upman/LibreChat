import { CircuitBreaker } from './circuitBreaker';
import { isTransientKmsError } from './service';

describe('CircuitBreaker', () => {
  it('starts in closed state and allows calls', () => {
    const cb = new CircuitBreaker();
    expect(cb.getState()).toBe('closed');
    expect(cb.canProceed()).toBe(true);
  });

  it('opens after threshold failures within the window', () => {
    const cb = new CircuitBreaker(3, 30_000, 60_000);
    cb.recordFailure();
    cb.recordFailure();
    expect(cb.getState()).toBe('closed');
    expect(cb.canProceed()).toBe(true);

    cb.recordFailure(); // 3rd failure → opens
    expect(cb.getState()).toBe('open');
    expect(cb.canProceed()).toBe(false);
  });

  it('closes on success', () => {
    const cb = new CircuitBreaker(2, 30_000, 60_000);
    cb.recordFailure();
    cb.recordFailure();
    expect(cb.getState()).toBe('open');

    // Simulate resetMs elapsed
    cb._setLastFailureTime(Date.now() - 61_000);
    expect(cb.getState()).toBe('half-open');
    expect(cb.canProceed()).toBe(true);

    cb.recordSuccess();
    expect(cb.getState()).toBe('closed');
    expect(cb.canProceed()).toBe(true);
  });

  it('re-opens on probe failure in half-open state', () => {
    const cb = new CircuitBreaker(2, 30_000, 60_000);
    cb.recordFailure();
    cb.recordFailure();
    // Force half-open
    cb._setLastFailureTime(Date.now() - 61_000);
    expect(cb.getState()).toBe('half-open');

    cb.recordFailure();
    expect(cb.getState()).toBe('open');
    expect(cb.canProceed()).toBe(false);
  });

  it('resets failure counter when failures are outside the window', () => {
    const cb = new CircuitBreaker(3, 1_000, 60_000);
    cb.recordFailure();
    cb.recordFailure();
    // Simulate the window expiring
    cb._setLastFailureTime(Date.now() - 2_000);

    cb.recordFailure(); // counter resets, only 1 failure now
    expect(cb.getState()).toBe('closed');
  });

  it('does not reset failure counter on success in closed state', () => {
    const cb = new CircuitBreaker(3, 30_000, 60_000);
    cb.recordFailure();
    cb.recordFailure();
    expect(cb.getState()).toBe('closed');

    // A success during normal operation should NOT wipe accumulated failures
    cb.recordSuccess();
    expect(cb.getState()).toBe('closed');

    // Third failure should open — failures were not reset
    cb.recordFailure();
    expect(cb.getState()).toBe('open');
  });

  it('allows only one concurrent probe in half-open state', () => {
    const cb = new CircuitBreaker(2, 30_000, 60_000);
    cb.recordFailure();
    cb.recordFailure();
    cb._setLastFailureTime(Date.now() - 61_000);

    // First caller gets the probe
    expect(cb.canProceed()).toBe(true);
    // Second concurrent caller is rejected while probe is in-flight
    expect(cb.canProceed()).toBe(false);
    expect(cb.canProceed()).toBe(false);

    // Probe succeeds → circuit closes → all callers allowed again
    cb.recordSuccess();
    expect(cb.canProceed()).toBe(true);
    expect(cb.canProceed()).toBe(true);
  });

  it('recovers from non-transient error during half-open probe (no lockout)', () => {
    const cb = new CircuitBreaker(2, 30_000, 60_000);
    cb.recordFailure();
    cb.recordFailure();
    expect(cb.getState()).toBe('open');

    // Advance past reset window
    cb._setLastFailureTime(Date.now() - 61_000);
    expect(cb.getState()).toBe('half-open');

    // Take the probe slot
    expect(cb.canProceed()).toBe(true);

    // Non-transient error: KMS responded with a deterministic error.
    // The service layer calls recordSuccess() to release the probe
    // (KMS is reachable — the error is not availability-related).
    cb.recordSuccess();
    expect(cb.getState()).toBe('closed');

    // Circuit is functional — not locked
    expect(cb.canProceed()).toBe(true);
    expect(cb.canProceed()).toBe(true);
  });
});

describe('isTransientKmsError', () => {
  it('classifies null/undefined as transient', () => {
    expect(isTransientKmsError(null)).toBe(true);
    expect(isTransientKmsError(undefined)).toBe(true);
  });

  it('classifies non-object throws as transient', () => {
    expect(isTransientKmsError('network timeout')).toBe(true);
    expect(isTransientKmsError(42)).toBe(true);
  });

  it('classifies "key not found" as non-transient', () => {
    expect(isTransientKmsError(new Error('key not found for keyAltName'))).toBe(false);
    expect(isTransientKmsError(new Error('No key matching the given criteria'))).toBe(false);
  });

  it('classifies duplicate key error (11000) as non-transient', () => {
    const err = new Error('E11000 duplicate key error');
    (err as unknown as { code: number }).code = 11000;
    expect(isTransientKmsError(err)).toBe(false);
  });

  it('classifies network/KMS errors as transient', () => {
    expect(isTransientKmsError(new Error('KMS request failed'))).toBe(true);
    expect(isTransientKmsError(new Error('ECONNREFUSED'))).toBe(true);
    expect(isTransientKmsError(new Error('socket hang up'))).toBe(true);
  });

  it('classifies shredded-tenant error as transient (caught before circuit breaker)', () => {
    // assertNotShredded throws before try/catch, so this never reaches isTransientKmsError
    // in production. But if it did, it would be classified as transient (generic Error).
    // This is acceptable — assertNotShredded runs before canProceed().
    expect(isTransientKmsError(new Error('has been shredded'))).toBe(true);
  });
});
