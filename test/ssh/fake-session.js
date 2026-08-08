// Test double implementing the SSHSession interface.
// `responses` maps a command substring -> { stdout, stderr, code }.
class FakeSSHSession {
  constructor(responses = {}) {
    this.responses = responses;
    this.onceResponses = {};
    this.execed = [];
    this.written = {};
    this.modes = {};
    this.connected = true;
  }

  // Queue a one-time response for a command substring; consumed in FIFO order
  // before the permanent `responses` map. Lets tests model state that changes
  // between polls (a service coming up, a handshake appearing).
  respondOnce(key, res) {
    (this.onceResponses[key] = this.onceResponses[key] || []).push(res);
    return this;
  }

  _match(command) {
    for (const key of Object.keys(this.onceResponses)) {
      if (command.includes(key) && this.onceResponses[key].length) {
        return { stdout: '', stderr: '', code: 0, ...this.onceResponses[key].shift() };
      }
    }
    for (const key of Object.keys(this.responses)) {
      if (command.includes(key)) {
        return { stdout: '', stderr: '', code: 0, ...this.responses[key] };
      }
    }
    return { stdout: '', stderr: '', code: 0 };
  }

  async exec(command) {
    this.execed.push(command);
    return this._match(command);
  }

  async execStream(command, onData) {
    this.execed.push(command);
    const res = this._match(command);
    if (onData) {
      for (const line of String(res.stdout).split('\n')) {
        if (line) onData(line);
      }
    }
    return res;
  }

  async writeFile(remotePath, content, opts = {}) {
    this.written[remotePath] = content;
    if (opts.mode !== undefined) this.modes[remotePath] = opts.mode;
  }

  async readFile(remotePath) {
    if (remotePath in this.written) return this.written[remotePath];
    throw new Error(`FakeSSHSession: no such file ${remotePath}`);
  }

  async exists(remotePath) {
    return remotePath in this.written;
  }

  isConnected() {
    return this.connected;
  }

  disconnect() {
    this.connected = false;
  }
}

module.exports = { FakeSSHSession };
