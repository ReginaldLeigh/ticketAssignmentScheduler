/**
 * Lease.gs — one assignment run at a time (§6.6).
 *
 * LockService has a single lock per script, and holding it for a multi-minute run would block
 * every admin save. Runs instead take a LEASE stored in Script Properties. Taking, renewing and
 * releasing the lease happen inside the short Store lock, so two Run now clicks can't both win.
 * A crashed run's lease expires after LEASE_TTL_MS, so the app never stays "in progress".
 */
const LEASE_KEY = 'run_lease';
const LEASE_TTL_MS = 10 * 60 * 1000;
const LAST_FINISHED_KEY = 'last_run_finished_at';

const Lease = {
  current() {
    const raw = PropertiesService.getScriptProperties().getProperty(LEASE_KEY);
    if (!raw) return null;
    try {
      const l = JSON.parse(raw);
      return Date.parse(l.expiresAt) > Date.now() ? l : null;
    } catch (e) { return null; }
  },

  /**
   * info: { runId, startedBy, trigger, takeOverRunId }. A continuation passes the earlier run's id
   * in takeOverRunId to inherit its lease. Returns { acquired, lease } or { acquired: false, current }.
   */
  acquire(info) {
    return Store.withLock(() => {
      const cur = Lease.current();
      if (cur && cur.runId !== info.runId && (!info.takeOverRunId || cur.runId !== info.takeOverRunId)) {
        return { acquired: false, current: cur };
      }
      const lease = {
        runId: info.runId, startedBy: info.startedBy, trigger: info.trigger,
        startedAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + LEASE_TTL_MS).toISOString(),
      };
      PropertiesService.getScriptProperties().setProperty(LEASE_KEY, JSON.stringify(lease));
      return { acquired: true, lease: lease };
    });
  },

  renew(runId) {
    return Store.withLock(() => {
      const cur = Lease.current();
      if (!cur || cur.runId !== runId) return false;
      cur.expiresAt = new Date(Date.now() + LEASE_TTL_MS).toISOString();
      PropertiesService.getScriptProperties().setProperty(LEASE_KEY, JSON.stringify(cur));
      return true;
    });
  },

  release(runId, finished) {
    return Store.withLock(() => {
      const props = PropertiesService.getScriptProperties();
      const cur = Lease.current();
      if (cur && cur.runId === runId) props.deleteProperty(LEASE_KEY);
      if (finished) props.setProperty(LAST_FINISHED_KEY, new Date().toISOString());
    });
  },

  lastFinishedAt() {
    return PropertiesService.getScriptProperties().getProperty(LAST_FINISHED_KEY);
  },

  /** Minutes left in the Run now cooldown (0 = can run). */
  cooldownRemainingMin(cooldownMin) {
    const last = Lease.lastFinishedAt();
    if (!last || !cooldownMin) return 0;
    const left = Date.parse(last) + cooldownMin * 60000 - Date.now();
    return left > 0 ? Math.ceil(left / 60000) : 0;
  },
};
