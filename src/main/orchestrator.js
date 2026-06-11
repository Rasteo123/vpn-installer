// Runs an ordered list of steps against an InstallContext.
// Phases per step: preflight -> execute -> verify. On failure, optionally
// rolls back the failed step then previously-completed steps in reverse.
class Orchestrator {
  constructor(onEvent = () => {}) {
    this.onEvent = onEvent;
  }

  _emit(event) {
    try { this.onEvent(event); } catch { /* never let UI listeners break a run */ }
  }

  async run(steps, ctx, opts = {}) {
    const { preflightAll = false, rollbackOnFailure = false } = opts;
    const total = steps.length;

    if (preflightAll) {
      for (const step of steps) {
        this._emit({ type: 'preflight', stepId: step.id });
        try {
          await step.preflight(ctx);
        } catch (error) {
          this._emit({ type: 'step-fail', stepId: step.id, phase: 'preflight', error: error.message });
          return { ok: false, failedStep: step.id, phase: 'preflight', error };
        }
      }
    }

    const completed = [];
    for (let i = 0; i < steps.length; i++) {
      const step = steps[i];
      this._emit({ type: 'step-start', stepId: step.id, index: i, total });
      try {
        if (!preflightAll) await step.preflight(ctx);
        // Resume support: a step that reports itself already applied is left
        // untouched and counted as done, so a re-run skips finished work.
        if (await step.isApplied(ctx)) {
          completed.push(step);
          this._emit({ type: 'step-skip', stepId: step.id, index: i, total });
          continue;
        }
        await step.execute(ctx);
        await step.verify(ctx);
        completed.push(step);
        this._emit({ type: 'step-done', stepId: step.id, index: i, total });
      } catch (error) {
        this._emit({ type: 'step-fail', stepId: step.id, phase: 'execute', error: error.message });
        if (rollbackOnFailure) {
          await this._rollback([step, ...completed.slice().reverse()], ctx);
        }
        return { ok: false, failedStep: step.id, error };
      }
    }
    return { ok: true, completed: completed.map((s) => s.id) };
  }

  async _rollback(stepsToRollback, ctx) {
    const seen = new Set();
    for (const step of stepsToRollback) {
      if (seen.has(step.id)) continue;
      seen.add(step.id);
      this._emit({ type: 'rollback', stepId: step.id });
      try {
        await step.rollback(ctx);
      } catch (error) {
        this._emit({ type: 'rollback-fail', stepId: step.id, error: error.message });
      }
    }
  }
}

module.exports = { Orchestrator };
