// Split a growing buffer into complete lines plus the incomplete remainder.
function takeLines(buffer) {
  const parts = String(buffer).split('\n');
  const remainder = parts.pop();
  return { lines: parts, remainder };
}

module.exports = { takeLines };
