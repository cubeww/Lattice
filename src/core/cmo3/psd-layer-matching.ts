import type { Element } from '@xmldom/xmldom';
import type { Cmo3Xml } from './xml';

/** Native reimport compares ID-first and name-first pairings using bounds overlap. */
export function matchPsdLayers(g: Cmo3Xml, oldLayers: Element[], newLayers: Element[]) {
  const identifier = (layer: Element, name: string) =>
    g.text(g.field(layer, 'layerIdentifier'), name);
  const overlap = (a: Element, b: Element) => {
    const rect = (n: Element) => {
      const r = g.field(n, 'boundsOnImageDoc');
      return [g.number(r, 'x'), g.number(r, 'y'), g.number(r, 'width'), g.number(r, 'height')];
    };
    const [ax, ay, aw, ah] = rect(a),
      [bx, by, bw, bh] = rect(b);
    const intersection =
      Math.max(0, Math.min(ax + aw, bx + bw) - Math.max(ax, bx)) *
      Math.max(0, Math.min(ay + ah, by + bh) - Math.max(ay, by));
    const union =
      (Math.max(ax + aw, bx + bw) - Math.min(ax, bx)) *
      (Math.max(ay + ah, by + bh) - Math.min(ay, by));
    return union ? intersection / union : 0;
  };
  const strategies = ['layerId', 'layerName'].map((preferred) => {
    const pairs: { old: Element; next: Element; score: number }[] = [];
    const used = new Set<Element>();
    for (const next of newLayers) {
      const candidates = (key: string) =>
        oldLayers.filter(
          (old) =>
            !used.has(old) &&
            identifier(next, key) &&
            identifier(old, key) === identifier(next, key),
        );
      let choices = candidates(preferred);
      if (!choices.length) choices = candidates(preferred === 'layerId' ? 'layerName' : 'layerId');
      const best = choices
        .map((old) => ({ old, next, score: overlap(old, next) }))
        .sort((a, b) => b.score - a.score)[0];
      if (best && best.score > 0.1) {
        pairs.push(best);
        used.add(best.old);
      }
    }
    return {
      pairs,
      perfect: pairs.length ? pairs.filter((p) => p.score >= 0.95).length / pairs.length : 0,
      average: pairs.length ? pairs.reduce((sum, p) => sum + p.score, 0) / pairs.length : 0,
    };
  });
  const strong = strategies.filter((s) => s.perfect > 0.5);
  const best = strong.length
    ? strong.sort((a, b) => b.perfect - a.perfect)[0]
    : strategies.sort((a, b) => b.average - a.average)[0];
  return new Map(best.pairs.map((p) => [g.guid(g.field(p.old, 'guid'))!, p.next]));
}
