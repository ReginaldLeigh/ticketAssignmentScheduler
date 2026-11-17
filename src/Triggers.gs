/**
 * Triggers.gs — automatic runs for each team at its own RUN_TIMES on its RUN_DAYS (Team settings;
 * default 06:00 and 13:00, Mon–Fri).
 *
 * Apps Script's daily triggers only promise to fire somewhere within the chosen hour, so a small
 * "ticker" runs every 10 minutes instead, and starts a run when a time slot is due and has not
 * run yet. Runs therefore start within ~10 minutes of the target time. If a run is in progress
 * when a slot comes due, the ticker tries again on its next tick.
 *
 * Setup (developer, once): run installTriggers() from the Apps Script editor, or click
 * "Install schedule" on the Settings page.
 */
const TICKER_HANDLER = 'tick';
const CONTINUE_HANDLER = 'continueAssignmentRun';
const LAST_SLOT_KEY = 'last_run_slot';
const CONTINUATION_KEY = 'continuation';
const ISO_DAY_CODES = { 1: 'MON', 2: 'TUE', 3: 'WED', 4: 'THU', 5: 'FRI', 6: 'SAT', 7: 'SUN' };

/** Time-driven handler (every 10 minutes). */
function tick() { return Triggers.tick(new Date()); }

/** Time-driven handler for a run that hit the time limit and continues. */
function continueAssignmentRun() { return Triggers.continueRun(); }

/** Developer/admin: install the 10-minute ticker (replaces any existing one). */
function installTriggers() { return Triggers.install(); }

/** Developer/admin: remove the ticker (stops automatic runs). */
function uninstallTriggers() { return Triggers.uninstall(); }

const Triggers = {
  /** The slot that should run now ('yyyy-MM-dd HH:mm'), or null. Pure function (tested). */
  dueSlot(now, settings, lastSlot, tz) {
    const dayCode = ISO_DAY_CODES[Number(Utilities.formatDate(now, tz, 'u'))];
    const days = String(settings.RUN_DAYS || '').split(',').map((d) => d.trim().toUpperCase());
    if (days.indexOf(dayCode) === -1) return null;
    const date = Utilities.formatDate(now, tz, 'yyyy-MM-dd');
    const hm = Utilities.formatDate(now, tz, 'HH:mm');
    const due = String(settings.RUN_TIMES || '').split(',').map((t) => t.trim()).filter((t) => t && t <= hm).sort();
    if (!due.length) return null;
    const slot = date + ' ' + due[due.length - 1];
    if (lastSlot && lastSlot >= slot) return null;
    return slot;
  },

  /** Runs every team whose slot is due, one after another. Returns { status, runs: [summary] }. */
  tick(now) {
    const props = PropertiesService.getScriptProperties();
    const runs = [];
    for (let i = 0; i < TEAMS.length; i++) {
      const team = TEAMS[i];
      let settings;
      try { settings = Config.settings(team.id); } catch (e) {
        settings = {}; Object.keys(TEAM_SETTING_DEFS).forEach((k) => { settings[k] = TEAM_SETTING_DEFS[k].value; });
      }
      const key = LAST_SLOT_KEY + ':' + team.id;
      const slot = Triggers.dueSlot(now || new Date(), settings, props.getProperty(key), Store.tz_());
      if (!slot) continue;
      const res = Pipeline.run({ teamId: team.id, trigger: 'scheduled', triggeredBy: 'system', runSlot: slot });
      if (res.status !== 'busy') props.setProperty(key, slot);
      runs.push(res);
      if (res.status === 'busy' || res.status === 'continued') break;   // try the rest on the next tick
    }
    return { status: runs.length ? 'ran' : 'idle', runs: runs };
  },

  scheduleContinuation(runId, opts) {
    PropertiesService.getScriptProperties().setProperty(CONTINUATION_KEY, JSON.stringify({
      continuationOf: runId, teamId: opts.teamId, triggeredBy: opts.triggeredBy || 'system', dryRun: !!opts.dryRun, runSlot: opts.runSlot || null }));
    ScriptApp.newTrigger(CONTINUE_HANDLER).timeBased().after(60 * 1000).create();
  },

  continueRun() {
    ScriptApp.getProjectTriggers().forEach((t) => { if (t.getHandlerFunction() === CONTINUE_HANDLER) ScriptApp.deleteTrigger(t); });
    const props = PropertiesService.getScriptProperties();
    const raw = props.getProperty(CONTINUATION_KEY);
    props.deleteProperty(CONTINUATION_KEY);
    if (!raw) return { status: 'idle' };
    const c = JSON.parse(raw);
    return Pipeline.run({ teamId: c.teamId, trigger: 'continuation', triggeredBy: c.triggeredBy, dryRun: c.dryRun, runSlot: c.runSlot, continuationOf: c.continuationOf });
  },

  install() {
    Triggers.uninstall();
    ScriptApp.newTrigger(TICKER_HANDLER).timeBased().everyMinutes(10).create();
    return Triggers.status();
  },

  uninstall() {
    ScriptApp.getProjectTriggers().forEach((t) => { if (t.getHandlerFunction() === TICKER_HANDLER) ScriptApp.deleteTrigger(t); });
    return Triggers.status();
  },

  status() {
    const handlers = ScriptApp.getProjectTriggers().map((t) => t.getHandlerFunction());
    return { tickerInstalled: handlers.indexOf(TICKER_HANDLER) !== -1 };
  },
};
