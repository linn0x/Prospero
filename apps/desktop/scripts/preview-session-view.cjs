// Synthetic sessions have one immutable output frame. Once consumed, the
// preview must return no update rather than an invalid delta without baseSeq.
module.exports = function previewSessionView(session, outputAfterSeq) {
  if (session?.kind !== 'pty') return { mode: 'snapshot', events: [], evSeq: 0 };
  if (outputAfterSeq !== null && Number(outputAfterSeq) === 1) return null;
  return { kind: 'pty', mode: 'snapshot', ansi: 'Prospero isolated terminal preview\r\n$ ', seq: 1, cols: 120, rows: 40, caughtUp: true };
};
