const { Client } = require('ssh2');
const { takeLines } = require('./line-buffer');
const crypto = require('crypto');
const { KnownHosts, verifyHostKey } = require('./known-hosts');

const DEFAULT_EXEC_TIMEOUT_MS = 300000;

class SSHSession {
  constructor(opts = {}) {
    this.conn = null;
    this.connected = false;
    this.knownHosts = opts.knownHosts || new KnownHosts();
    this._hostKeyError = null;
  }

  // ssh2 hostVerifier with trust-on-first-use semantics: the first key for
  // host:port is remembered; a changed key is refused and the reason is kept
  // so connect() can surface it instead of ssh2's generic handshake error.
  _makeHostVerifier(host, port) {
    this._hostKeyError = null;
    return (keyBlob) => {
      const res = verifyHostKey(this.knownHosts, host, port, keyBlob);
      if (!res.ok) {
        this._hostKeyError = new Error(
          `Host key for ${host}:${port} CHANGED: expected ${res.expected}, got ${res.fingerprint}. ` +
          `This may be a man-in-the-middle attack. If the server was genuinely reinstalled, ` +
          `delete its entry from ${this.knownHosts.filePath} and connect again.`
        );
      }
      return res.ok;
    };
  }

  /**
   * Connect to remote host.
   * @param {Object} config
   * @param {string} config.host
   * @param {number} [config.port=22]
   * @param {string} [config.username='root']
   * @param {string} [config.password]
   * @param {string} [config.privateKey]
   * @returns {Promise<void>}
   */
  async connect(config) {
    if (this.connected) {
      this.disconnect();
    }

    return new Promise((resolve, reject) => {
      const conn = new Client();
      const timeout = setTimeout(() => {
        conn.end();
        reject(new Error('SSH connection timed out after 30 seconds'));
      }, 30000);

      conn.on('ready', () => {
        clearTimeout(timeout);
        this.conn = conn;
        this.connected = true;
        resolve();
      });

      conn.on('error', (err) => {
        clearTimeout(timeout);
        this.connected = false;
        this.conn = null;
        // A host-key mismatch surfaces as a generic handshake error in ssh2;
        // report the real reason instead.
        reject(this._hostKeyError || new Error(`SSH connection error: ${err.message}`));
      });

      conn.on('end', () => {
        this.connected = false;
        this.conn = null;
      });

      conn.on('close', () => {
        this.connected = false;
        this.conn = null;
      });

      const sshConfig = {
        host: config.host,
        port: config.port || 22,
        username: config.username || 'root',
        readyTimeout: 30000,
        keepaliveInterval: 10000,
        keepaliveCountMax: 3,
        hostVerifier: this._makeHostVerifier(config.host, config.port || 22),
      };

      if (config.privateKey) {
        sshConfig.privateKey = config.privateKey;
        if (config.password) {
          sshConfig.passphrase = config.password;
        }
      } else if (config.password) {
        sshConfig.password = config.password;
      }

      try {
        conn.connect(sshConfig);
      } catch (err) {
        clearTimeout(timeout);
        reject(new Error(`SSH connect failed: ${err.message}`));
      }
    });
  }

  /**
   * Execute single command, return { stdout, stderr, code }.
   * @param {string} command
   * @param {Object} [opts]
   * @param {number} [opts.timeoutMs=300000] - For long installs pass a bigger value.
   * @returns {Promise<{stdout: string, stderr: string, code: number}>}
   */
  async exec(command, opts = {}) {
    if (!this.connected || !this.conn) {
      throw new Error('SSH session is not connected');
    }

    const timeoutMs = opts.timeoutMs || DEFAULT_EXEC_TIMEOUT_MS;
    return new Promise((resolve, reject) => {
      let streamRef = null;
      const timeout = setTimeout(() => {
        if (streamRef) { try { streamRef.close(); } catch { /* channel may be gone */ } }
        reject(new Error(`Command timed out after ${Math.round(timeoutMs / 1000)} seconds: ${command.substring(0, 80)}`));
      }, timeoutMs);

      this.conn.exec(command, (err, stream) => {
        if (err) {
          clearTimeout(timeout);
          reject(new Error(`Failed to execute command: ${err.message}`));
          return;
        }
        streamRef = stream;

        let stdout = '';
        let stderr = '';

        stream.on('close', (code) => {
          clearTimeout(timeout);
          resolve({ stdout, stderr, code: code || 0 });
        });

        stream.on('data', (data) => {
          stdout += data.toString();
        });

        stream.stderr.on('data', (data) => {
          stderr += data.toString();
        });

        stream.on('error', (streamErr) => {
          clearTimeout(timeout);
          reject(new Error(`Stream error: ${streamErr.message}`));
        });
      });
    });
  }

  /**
   * Execute command with streaming output via callback.
   * @param {string} command
   * @param {function(string): void} onData - Called for each line of output
   * @param {Object} [opts]
   * @param {number} [opts.timeoutMs=300000] - For long installs pass a bigger value.
   * @returns {Promise<{stdout: string, stderr: string, code: number}>}
   */
  async execStream(command, onData, opts = {}) {
    if (!this.connected || !this.conn) {
      throw new Error('SSH session is not connected');
    }

    const timeoutMs = opts.timeoutMs || DEFAULT_EXEC_TIMEOUT_MS;
    return new Promise((resolve, reject) => {
      let streamRef = null;
      const timeout = setTimeout(() => {
        if (streamRef) { try { streamRef.close(); } catch { /* channel may be gone */ } }
        reject(new Error(`Command timed out after ${Math.round(timeoutMs / 1000)} seconds: ${command.substring(0, 80)}`));
      }, timeoutMs);

      this.conn.exec(command, (err, stream) => {
        if (err) {
          clearTimeout(timeout);
          reject(new Error(`Failed to execute command: ${err.message}`));
          return;
        }
        streamRef = stream;

        let stdout = '';
        let stderr = '';
        let stdoutBuffer = '';
        let stderrBuffer = '';

        stream.on('close', (code) => {
          clearTimeout(timeout);
          // Flush remaining buffer content
          if (stdoutBuffer) {
            if (onData) onData(stdoutBuffer);
          }
          if (stderrBuffer) {
            if (onData) onData(stderrBuffer);
          }
          resolve({ stdout, stderr, code: code || 0 });
        });

        stream.on('data', (data) => {
          const text = data.toString();
          stdout += text;
          stdoutBuffer += text;
          const { lines, remainder } = takeLines(stdoutBuffer);
          stdoutBuffer = remainder;
          for (const line of lines) {
            if (onData) onData(line);
          }
        });

        stream.stderr.on('data', (data) => {
          const text = data.toString();
          stderr += text;
          stderrBuffer += text;
          const { lines, remainder } = takeLines(stderrBuffer);
          stderrBuffer = remainder;
          for (const line of lines) {
            if (onData) onData(line);
          }
        });

        stream.on('error', (streamErr) => {
          clearTimeout(timeout);
          reject(new Error(`Stream error: ${streamErr.message}`));
        });
      });
    });
  }

  /**
   * Write a remote file, preferring SFTP and falling back to exec.
   *
   * OpenWrt's Dropbear has no SFTP subsystem, so the fallback is the only
   * path that works on the router. Base64 is safe to embed in single quotes
   * (its alphabet is A-Za-z0-9+/=), so the chunks need no escaping.
   *
   * @param {string} remotePath
   * @param {string|Buffer} content
   * @param {Object} [opts]
   * @param {number} [opts.mode] - File mode (e.g. 0o600).
   * @returns {Promise<void>}
   */
  async writeFile(remotePath, content, opts = {}) {
    if (!this.connected || !this.conn) {
      throw new Error('SSH session is not connected');
    }

    const buf = Buffer.isBuffer(content) ? content : Buffer.from(String(content), 'utf8');

    if (!this._sftpUnavailable) {
      try {
        await this._writeFileViaSftp(remotePath, buf, opts);
        return;
      } catch (error) {
        // One probe per session: once SFTP is known missing, stop paying for it.
        this._sftpUnavailable = true;
      }
    }

    await this._writeFileViaExec(remotePath, buf, opts);
  }

  _writeFileViaSftp(remotePath, buf, opts) {
    return new Promise((resolve, reject) => {
      this.conn.sftp((err, sftp) => {
        if (err) {
          reject(new Error(`SFTP session failed: ${err.message}`));
          return;
        }

        const streamOpts = opts.mode !== undefined ? { mode: opts.mode } : {};
        const writeStream = sftp.createWriteStream(remotePath, streamOpts);

        writeStream.on('error', (writeErr) => {
          sftp.end();
          reject(new Error(`Failed to write file ${remotePath}: ${writeErr.message}`));
        });

        writeStream.on('close', () => {
          sftp.end();
          resolve();
        });

        writeStream.end(buf);
      });
    });
  }

  // Streams the payload straight into the command's stdin. Encoding it was
  // tried first and failed on real hardware: this firmware's busybox ships no
  // `base64` applet, so the decode step exited 127 and left an empty file.
  // Raw bytes need no remote tool at all, and one round trip beats hundreds.
  _execWithInput(command, input, opts = {}) {
    const timeoutMs = opts.timeoutMs || DEFAULT_EXEC_TIMEOUT_MS;
    return new Promise((resolve, reject) => {
      this.conn.exec(command, (err, stream) => {
        if (err) {
          reject(new Error(`SSH exec failed: ${err.message}`));
          return;
        }

        const timeout = setTimeout(() => {
          stream.close();
          reject(new Error(`SSH write timed out after ${timeoutMs}ms: ${command}`));
        }, timeoutMs);

        let stdout = '';
        let stderr = '';
        // Measured against a real router: ssh2 keeps the channel paused until
        // stdout has a consumer, so without this listener 'close' never fires
        // and the write hangs forever.
        stream.on('data', (d) => { stdout += d.toString(); });
        stream.stderr.on('data', (d) => { stderr += d.toString(); });
        stream.on('error', (e) => {
          clearTimeout(timeout);
          reject(new Error(`SSH stream error: ${e.message}`));
        });
        stream.on('close', (code) => {
          clearTimeout(timeout);
          resolve({ code: code === undefined ? 0 : code, stdout, stderr });
        });

        stream.end(input);
      });
    });
  }

  async _writeFileViaExec(remotePath, buf, opts) {
    const q = (v) => `'${String(v).replace(/'/g, `'\\''`)}'`;
    const target = q(remotePath);

    const res = await this._execWithInput(`cat > ${target}`, buf, { timeoutMs: opts.timeoutMs });
    if (res.code !== 0) {
      throw new Error(
        `Failed to write file ${remotePath}: exit ${res.code}${res.stderr ? ` — ${res.stderr.trim()}` : ''}`,
      );
    }

    const size = parseInt((await this.exec(`wc -c < ${target}`)).stdout.trim(), 10);
    if (size !== buf.length) {
      throw new Error(`Failed to write file ${remotePath}: size mismatch (${size} != ${buf.length})`);
    }

    const expected = crypto.createHash('sha256').update(buf).digest('hex');
    const actual = (await this.exec(`sha256sum ${target} | cut -d' ' -f1`)).stdout.trim();
    if (actual !== expected) {
      throw new Error(`Failed to write file ${remotePath}: checksum mismatch`);
    }

    if (opts.mode !== undefined) {
      await this.exec(`chmod ${opts.mode.toString(8).padStart(3, '0')} ${target}`);
    }
  }

  /**
   * Read remote file as string.
   * @param {string} remotePath
   * @returns {Promise<string>}
   */
  async readFile(remotePath) {
    if (!this.connected || !this.conn) {
      throw new Error('SSH session is not connected');
    }

    return new Promise((resolve, reject) => {
      this.conn.sftp((err, sftp) => {
        if (err) {
          reject(new Error(`SFTP session failed: ${err.message}`));
          return;
        }

        let data = '';
        const readStream = sftp.createReadStream(remotePath, { encoding: 'utf8' });

        readStream.on('data', (chunk) => {
          data += chunk;
        });

        readStream.on('error', (readErr) => {
          sftp.end();
          reject(new Error(`Failed to read file ${remotePath}: ${readErr.message}`));
        });

        readStream.on('end', () => {
          sftp.end();
          resolve(data);
        });
      });
    });
  }

  /**
   * Check if file/path exists on remote.
   * @param {string} remotePath
   * @returns {Promise<boolean>}
   */
  async exists(remotePath) {
    if (!this.connected || !this.conn) {
      throw new Error('SSH session is not connected');
    }

    return new Promise((resolve, reject) => {
      this.conn.sftp((err, sftp) => {
        if (err) {
          reject(new Error(`SFTP session failed: ${err.message}`));
          return;
        }

        sftp.stat(remotePath, (statErr) => {
          sftp.end();
          if (statErr) {
            resolve(false);
          } else {
            resolve(true);
          }
        });
      });
    });
  }

  /**
   * Disconnect from remote host.
   */
  disconnect() {
    if (this.conn) {
      try {
        this.conn.end();
      } catch {
        // Ignore errors during disconnect
      }
      this.conn = null;
      this.connected = false;
    }
  }

  /**
   * Check connection status.
   * @returns {boolean}
   */
  isConnected() {
    return this.connected;
  }
}

module.exports = SSHSession;
