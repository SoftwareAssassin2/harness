// Engine keys the harness no longer reads (ASS-450). The ticket health check
// (its runs sampled from state changes, check-ticket-health and
// check-ticket-health-grouped) is removed; an engine that still declares its
// keys — a project's own under data/projects/<project>/engines, kept on the
// operator's disk — loads and runs as before, the keys ignored: dropped where
// engines are read (control's state.js readEngines, the dashboard's
// load.js, validate.js), so no step list of them is ever run or validated,
// and control says so once per engine (tick.js).
export const OBSOLETE_ENGINE_KEYS = ['check-ticket-health-sample-every', 'check-ticket-health-steps'];

// obsoleteKeysOf(engine) — the obsolete keys the engine declares, in OBSOLETE_ENGINE_KEYS's order.
export const obsoleteKeysOf = engine => (engine && typeof engine === 'object' ? OBSOLETE_ENGINE_KEYS.filter(key => Object.hasOwn(engine, key)) : []);

// withoutObsolete(engine) — the engine without its obsolete keys: itself when it declares none.
export function withoutObsolete(engine) {
  if (!obsoleteKeysOf(engine).length) return engine;
  const kept = { ...engine };
  for (const key of OBSOLETE_ENGINE_KEYS) delete kept[key];
  return kept;
}
