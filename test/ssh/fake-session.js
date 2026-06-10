// Test double implementing the SSHSession interface.
// `responses` maps a command substring -> { stdout, stderr, code }.
class FakeSSHSession {
  constructor(responses = {}) {
    this.responses = responses;
    this.execed = [];
    this.written = {};
    this.connected = true;
  }

  _match(command) {
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

  async writeFile(remotePath, content) {
    this.written[remotePath] = content;
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
