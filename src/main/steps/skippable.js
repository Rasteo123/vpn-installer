// Thrown by a step's preflight when the step cannot apply here but the install
// should carry on regardless — an unsupported router architecture, a missing
// kernel feature. Only preflight may throw it: by the time execute runs, the
// step owns partial state and skipping would hide it.
class SkippableError extends Error {
  constructor(reason) {
    super(reason);
    this.name = 'SkippableError';
  }
}

module.exports = { SkippableError };
