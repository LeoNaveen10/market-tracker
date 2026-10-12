// Extract complete, source-backed statements. Never infer missing figures.
const sentences = new Intl.Segmenter("en", { granularity: "sentence" });
const business =
  /\b(revenue|sales|profit|loss|margin|earnings|dividend|buyback|acquisition|acquire[ds]?|merger|order|contract|investment|capacity|production|launch(?:ed)?|appoint(?:ed|ment)?|resign(?:ed|ation)?|approval|approved|penalty|litigation|rating|downgrade|upgrade|default|guidance|growth|grew|declined|increased|decreased|record date|quarter|results)\b/i;
const admin =
  /^(?:to\s+(?:all|the)|bse limited|national stock exchange|new york stock exchange|dear\b|yours\b|thank(?:s|ing| you)\b|for your information|this is for your information|kindly take|please (?:find|take)|encl\b|registered office|corporate office|cin\s*:|tel\s*:|fax\s*:|www\.|https?:|page\s+\d|digitally signed)/i;
export function extractHighlights(text, fallback = "") {
  const clean = String(text || "")
    .replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;|&#160;/g, " ")
    .replace(/&amp;/g, "&");
  const lines = clean
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter((s) => s && !admin.test(s));
  const joined = lines.join(" ").replace(/\s+/g, " ").trim();
  const candidates = [...sentences.segment(joined)].map((s) =>
    s.segment.trim(),
  );
  const ranked = [];
  const seen = new Set();
  for (let index = 0; index < candidates.length; index++) {
    let sentence = candidates[index]
      .replace(/^(?:sub(?:ject)?\s*:\s*)/i, "")
      .trim();
    if (
      sentence.length < 20 ||
      sentence.length > 260 ||
      admin.test(sentence) ||
      !business.test(sentence)
    )
      continue;
    if (
      /has (?:informed|submitted to) the exchange|pursuant to regulation|listing obligations|forward.looking|safe harbor|auditor.s report|unique document identification/i.test(
        sentence,
      )
    )
      continue;
    const key = sentence.toLowerCase().replace(/[^a-z0-9]/g, "");
    if (seen.has(key)) continue;
    seen.add(key);
    const score =
      (/\d/.test(sentence) ? 3 : 0) +
      (/revenue|sales|profit|margin|dividend|guidance/i.test(sentence)
        ? 3
        : 0) +
      (/approved|acquired|awarded|resigned|appointed|launched|grew|declined/i.test(
        sentence,
      )
        ? 2
        : 0);
    ranked.push({ sentence, index, score });
  }
  const selected = ranked
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .slice(0, 3)
    .sort((a, b) => a.index - b.index)
    .map((s) => s.sentence);
  if (selected.length) return selected;
  if (fallback && fallback !== text) return extractHighlights(fallback);
  return [];
}
export function presentItem(record) {
  const { content, ...item } = record;
  if (item.source === "NSE") {
    const highlights = extractHighlights(content, item.title);
    item.highlights = highlights.length
      ? highlights
      : [
          "Key details could not be reliably extracted. Open the original filing.",
        ];
    item.summary = item.highlights.join(" ");
  }
  return item;
}
