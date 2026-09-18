export type LoginMethod = 'password' | 'microsoft' | 'phone' | 'custom-token' | 'email-link';

// A separate transport keeps expected login failures out of Error Monitor.
export function createLoginAttempt(
  send: (data: Record<string, unknown>) => Promise<unknown>,
  method: LoginMethod,
  identifier = '',
  site = '',
) {
  let accessReported = false;
  let authenticated = false;
  let authenticationReported = false;
  let pendingAccess: { outcome: string; errorCode: string } | null = null;
  const report = (stage: string, outcome: string, errorCode = '', resolvedIdentifier = identifier) => {
    try {
      void send({ method, attemptedIdentifier: resolvedIdentifier, site, stage, outcome, errorCode })
        .catch(() => {});
    } catch { /* Audit availability must not affect login. */ }
  };
  return {
    authentication(outcome: 'success' | 'failed', errorCode = '', resolvedIdentifier = identifier) {
      if (authenticationReported) return;
      authenticationReported = true;
      authenticated = outcome === 'success';
      identifier = resolvedIdentifier;
      report('authentication', outcome, errorCode);
      if (authenticated && pendingAccess) report('application-access', pendingAccess.outcome, pendingAccess.errorCode);
    },
    access(outcome: 'success' | 'failed', errorCode = '') {
      if (accessReported) return;
      accessReported = true;
      if (authenticated) report('application-access', outcome, errorCode);
      else pendingAccess = { outcome, errorCode };
    },
  };
}
