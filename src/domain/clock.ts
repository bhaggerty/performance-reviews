/** Injected clock so tests control "now" instead of depending on the real wall clock. */
export interface Clock {
  now(): Date;
}

export const systemClock: Clock = {
  now: () => new Date(),
};

export function isoNow(clock: Clock = systemClock): string {
  return clock.now().toISOString();
}
