/**
 * Subject.gs — subject clean-up and near-match scoring (D9).
 * The same rules are applied in BigQuery by SQL.historyMatch (QueryConfig.gs); keep them in step.
 *
 *   clean:  lower-case → strip leading RE:/FW:/[EXT] prefixes → non-alphanumerics become spaces
 *           → split into words → drop stop words (numbers are kept)
 *   score:  max( word overlap = shared distinct words / all distinct words,
 *                containment = 1.0 if the shorter subject's words appear in order inside the
 *                longer one and the shorter has at least minWords words )
 */
const Subject = {
  normalize(subject) {
    const pattern = new RegExp(QUERY_CONFIG.subjectMatching.prefixPattern);
    return String(subject || '').toLowerCase().replace(pattern, '').replace(/[^a-z0-9]+/g, ' ').trim();
  },

  /** Ordered list of meaningful words. */
  words(subject, stopWords) {
    const stop = {};
    (stopWords || []).forEach((w) => { stop[w] = true; });
    return Subject.normalize(subject).split(' ').filter((w) => w && !stop[w]);
  },

  seq(subject, stopWords) { return Subject.words(subject, stopWords).join(' '); },

  /** Can this subject be used to detect a follow-up? */
  isEligible(subject, stopWords, minWords, ignoreList) {
    const s = Subject.seq(subject, stopWords);
    if (!s || s.split(' ').length < minWords) return false;
    const ignored = (ignoreList || []).some((ig) => {
      const n = Subject.seq(ig, stopWords);
      return n && n === s;
    });
    return !ignored;
  },

  /** Similarity of two cleaned word sequences (strings of space-separated words). */
  score(seqA, seqB, minWords) {
    if (!seqA || !seqB) return 0;
    const a = seqA.split(' '), b = seqB.split(' ');
    const setA = Subject.uniq_(a), setB = Subject.uniq_(b);
    const inter = setA.filter((w) => setB.indexOf(w) !== -1).length;
    if (!inter) return 0;
    const overlap = inter / (setA.length + setB.length - inter);
    const longer = a.length >= b.length ? seqA : seqB;
    const shorter = a.length >= b.length ? seqB : seqA;
    const shorterWc = Math.min(a.length, b.length);
    const contained = shorterWc >= minWords && (' ' + longer + ' ').indexOf(' ' + shorter + ' ') !== -1;
    return Math.max(overlap, contained ? 1 : 0);
  },

  uniq_(arr) {
    const seen = {};
    return arr.filter((w) => (seen[w] ? false : (seen[w] = true)));
  },
};
