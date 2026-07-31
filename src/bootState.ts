/**
 * Boot progress, shared so /healthz and the dashboard can report *why* the
 * service is not working instead of the process dying silently.
 *
 * The service deliberately starts its HTTP listener before touching the
 * database. A crash-on-boot shows up in Railway only as "service unavailable"
 * with no explanation; staying up and serving the real error is far easier to
 * act on.
 */
export interface BootState {
  dbReady: boolean;
  dbError: string | null;
  dbAttempts: number;
  startedAt: Date;
}

export const bootState: BootState = {
  dbReady: false,
  dbError: null,
  dbAttempts: 0,
  startedAt: new Date(),
};

export function describeDbError(): string | null {
  if (bootState.dbReady) return null;
  if (!bootState.dbError) return 'データベースに接続中です…';
  return bootState.dbError;
}
