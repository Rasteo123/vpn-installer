const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const { resolveOlcrtcAssets, parseManifest, loadBinary } = require('../../src/main/config/olcrtc-assets');

test('parseManifest maps binary names to their hashes and ignores comments', () => {
  const m = parseManifest([
    '# source_commit=abc',
    '522ca8a23357f5897da11bb119a89fc0d392e981da641f7ae4976d4f1ff08820  olcrtc-linux-amd64',
    '9b46c24d9bd32d51c7052db54ea28dcaaff60ad3dec2901349d82f67d4575bec  olcrtc-linux-arm64',
  ].join('\n'));
  assert.strictEqual(m.size, 2);
  assert.strictEqual(m.get('olcrtc-linux-amd64'), '522ca8a23357f5897da11bb119a89fc0d392e981da641f7ae4976d4f1ff08820');
});

test('resolveOlcrtcAssets points at the packaged resources root when packaged', () => {
  const a = resolveOlcrtcAssets({ isPackaged: true, resourcesPath: '/res' });
  assert.strictEqual(a.root, path.join('/res', 'olcrtc'));
  assert.strictEqual(a.arm64Gz, path.join('/res', 'olcrtc', 'olcrtc-linux-arm64.gz'));
});

test('resolveOlcrtcAssets falls back to the source tree in development', () => {
  const a = resolveOlcrtcAssets({ isPackaged: false });
  assert.match(a.root, /assets[/\\]olcrtc$/);
});

// The whole point of pinning: bytes whose hash drifts must never reach a host.
test('loadBinary decompresses the shipped binary and its hash matches the manifest', async () => {
  const buf = await loadBinary('arm64');
  assert.ok(buf.length > 20 * 1024 * 1024, `expected a real binary, got ${buf.length} bytes`);
});

test('loadBinary rejects an unknown architecture', async () => {
  await assert.rejects(loadBinary('mips'), /unsupported architecture/);
});

// In a packaged build the binaries live in extraResources, outside the asar,
// so the resolver must not keep pointing at the source tree that no longer
// exists there.
test('resolveOlcrtcAssets detects a packaged layout when the source tree is absent', () => {
  const a = resolveOlcrtcAssets({ sourceRoot: '/definitely/not/here', resourcesPath: '/res' });
  assert.strictEqual(a.root, path.join('/res', 'olcrtc'));
});

test('resolveOlcrtcAssets uses the source tree when the manifest is there', () => {
  const a = resolveOlcrtcAssets({ resourcesPath: '/res' });
  assert.match(a.root, /assets[/\\]olcrtc$/);
});
