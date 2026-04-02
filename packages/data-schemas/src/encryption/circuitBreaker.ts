/**
 * Simple circuit breaker for KMS calls.
 *
 * States:
 *  - closed:    normal operation, all calls proceed
 *  - open:      too many recent failures, all calls rejected immediately
 *  - half-open: cooldown elapsed, exactly one probe call allowed
 *
 * Transitions:
 *  closed → open:      after `threshold` failures within `windowMs`
 *  open → half-open:   after `resetMs` since last failure
 *  half-open → closed: on probe success
 *  half-open → open:   on probe failure
 */
export class CircuitBreaker {
  private failures = 0;
  private lastFailureTime = 0;
  private state: 'closed' | 'open' | 'half-open' = 'closed';
  private probeInFlight = false;

  constructor(
    /** Number of failures before opening the circuit */
    private readonly threshold = 5,
    /** Time window (ms) — failures outside this window are forgotten */
    private readonly windowMs = 30_000,
    /** How long (ms) to stay open before allowing a probe */
    private readonly resetMs = 60_000,
  ) {}

  /** Returns true if the call should proceed; false if rejected. */
  canProceed(): boolean {
    this.refreshState();

    if (this.state === 'closed') {
      return true;
    }

    if (this.state === 'open') {
      return false;
    }

    // half-open: allow exactly one concurrent probe
    if (this.probeInFlight) {
      return false;
    }
    this.probeInFlight = true;
    return true;
  }

  recordSuccess(): void {
    this.probeInFlight = false;
    if (this.state === 'half-open') {
      this.failures = 0;
    }
    this.state = 'closed';
  }

  recordFailure(): void {
    this.probeInFlight = false;
    const now = Date.now();

    // Reset counter if the previous failure was outside the window
    if (now - this.lastFailureTime > this.windowMs) {
      this.failures = 0;
    }

    this.failures++;
    this.lastFailureTime = now;

    if (this.failures >= this.threshold || this.state === 'half-open') {
      this.state = 'open';
    }
  }

  getState(): 'closed' | 'open' | 'half-open' {
    this.refreshState();
    return this.state;
  }

  /** Transition open → half-open if the reset cooldown has elapsed. */
  private refreshState(): void {
    if (this.state === 'open' && Date.now() - this.lastFailureTime >= this.resetMs) {
      this.state = 'half-open';
    }
  }

  /** Exposed for testing only — override the last failure timestamp. */
  _setLastFailureTime(time: number): void {
    this.lastFailureTime = time;
  }
}
