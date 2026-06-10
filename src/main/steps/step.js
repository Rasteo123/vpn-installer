const NOOP = async () => {};

// Normalize a step definition: execute is required, everything else defaults.
function makeStep(def) {
  if (typeof def.execute !== 'function') {
    throw new Error(`step ${def.id}: execute is required`);
  }
  return {
    id: def.id,
    title: def.title || def.id,
    target: def.target,
    isApplied: def.isApplied || (async () => false),
    preflight: def.preflight || NOOP,
    execute: def.execute,
    verify: def.verify || NOOP,
    rollback: def.rollback || NOOP,
  };
}

module.exports = { makeStep };
