const fs = require('fs');
const path = require('path');

// Collapse insignificant whitespace so structural drift is what fails a diff.
function normalize(s) {
  return String(s)
    .split('\n')
    .map((line) => line.replace(/\s+$/, ''))
    .join('\n')
    .trim();
}

function readReference(relPath) {
  return fs.readFileSync(path.join(__dirname, '..', '..', 'reference', relPath), 'utf8');
}

// True only when a captured reference snapshot is present (it's device-specific
// and gitignored, so snapshot-dependent tests skip in a fresh clone).
function referenceExists() {
  return fs.existsSync(path.join(__dirname, '..', '..', 'reference', 'vps'));
}

module.exports = { normalize, readReference, referenceExists };
