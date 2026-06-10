const { Client } = require('ssh2');
const { takeLines } = require('./line-buffer');

class SSHSession {
  constructor() {
    this.conn = null;
    this.connected = false;
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
        reject(new Error(`SSH connection error: ${err.message}`));
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
   * @returns {Promise<{stdout: string, stderr: string, code: number}>}
   */
  async exec(command) {
    if (!this.connected || !this.conn) {
      throw new Error('SSH session is not connected');
    }

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error(`Command timed out after 300 seconds: ${command.substring(0, 80)}`));
      }, 300000);

      this.conn.exec(command, (err, stream) => {
        if (err) {
          clearTimeout(timeout);
          reject(new Error(`Failed to execute command: ${err.message}`));
          return;
        }

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
   * @returns {Promise<{stdout: string, stderr: string, code: number}>}
   */
  async execStream(command, onData) {
    if (!this.connected || !this.conn) {
      throw new Error('SSH session is not connected');
    }

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error(`Command timed out after 300 seconds: ${command.substring(0, 80)}`));
      }, 300000);

      this.conn.exec(command, (err, stream) => {
        if (err) {
          clearTimeout(timeout);
          reject(new Error(`Failed to execute command: ${err.message}`));
          return;
        }

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
   * Write string content to remote file.
   * @param {string} remotePath
   * @param {string} content
   * @returns {Promise<void>}
   */
  async writeFile(remotePath, content) {
    if (!this.connected || !this.conn) {
      throw new Error('SSH session is not connected');
    }

    return new Promise((resolve, reject) => {
      this.conn.sftp((err, sftp) => {
        if (err) {
          reject(new Error(`SFTP session failed: ${err.message}`));
          return;
        }

        const writeStream = sftp.createWriteStream(remotePath);

        writeStream.on('error', (writeErr) => {
          sftp.end();
          reject(new Error(`Failed to write file ${remotePath}: ${writeErr.message}`));
        });

        writeStream.on('close', () => {
          sftp.end();
          resolve();
        });

        writeStream.end(content, 'utf8');
      });
    });
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
