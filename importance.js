import { extractHighlights } from "./highlights.js";

export const IMPORTANCE_POLICY = "important-only-v1";
const routine =
  /trading window|newspaper|voting results|scrutini[sz]er|compliance certificate|share certificate|duplicate certificate|demateriali[sz]ation|investor.*(?:meet|call).*schedule|schedule.*(?:investor|analyst)|transcript|board meeting intimation|notice of.*meeting|record date|book closure|auditor.?s reports?|report of auditors?|\budin\b|secretarial compliance|reconciliation of share capital/i;
const scheduled =
  /(?:meeting|board|call).{0,70}(?:scheduled|will be held|to be held|to consider)|(?:consider|considering).{0,50}(?:financial results|dividend|buyback)/i;
const outcomes = [
  [
    "Financial performance",
    /\b(?:revenue|sales|(?:net )?profits?|(?:net )?loss(?:es)?|earnings|ebitda|operating margin)\b.{0,70}\b(?:grew|grows?|rose|rises?|fell|falls?|declines?|declined|increased|decreased|reported|stood|up|down|growth|drops?|surges?|jumps?)\b/i,
  ],
  [
    "Dividend or buyback",
    /\b(?:declar(?:e[ds]?|ation)|approv(?:e[ds]?|al)|recommend(?:ed|s)?|announc(?:ed|es))\b.{0,80}\b(?:dividend|buyback|buy.back)\b|\b(?:dividend|buyback|buy.back)\b.{0,60}\b(?:declared|approved|announced)\b/i,
  ],
  [
    "Acquisition or merger",
    /\b(?:acquires?|acquired|acquisition|merger|demerger|divestment|takeover)\b/i,
  ],
  [
    "Order or contract",
    /\b(?:wins?|won|awarded|secures?|secured|bagged|bags|received|signed|signs|terminated|cancelled)\b.{0,80}\b(?:orders?|contracts?)\b|\b(?:order|contract)\b.{0,60}\b(?:awarded|signed|terminated|cancelled)\b/i,
  ],
  [
    "Leadership change",
    /\b(?:ceo|cfo|chief executive|chief financial|managing director)\b.{0,100}\b(?:resign\w*|appoint\w*|steps? down|replaces?|retires?|retired)\b|\b(?:resign\w*|appoint\w*|replaces?)\b.{0,100}\b(?:ceo|cfo|chief executive|chief financial|managing director)\b/i,
  ],
  [
    "Material risk",
    /\b(?:default(?:ed|s)?|insolvency|bankruptcy|fraud|credit.{0,20}downgrade|downgrad\w*.{0,20}(?:credit|rating)|rating.{0,20}downgrad\w*|regulatory (?:penalty|action|ban)|(?:sebi|rbi|cci).{0,45}(?:fine|penalty|ban|order)|(?:plant|factory).{0,30}(?:fire|shutdown))\b/i,
  ],
  [
    "Guidance change",
    /\b(?:raises?|raised|cuts?|cut|revises?|revised|lowers?|lowered|withdraws?|withdrawn)\b.{0,60}\b(?:guidance|outlook|forecast)\b/i,
  ],
];

// Classification is deliberately based on event statements, not the presence
// of financial keywords somewhere in a long attachment's boilerplate.
export function importance(item) {
  if (item.source === "NSE financials" && item.category === "results")
    return { important: true, reason: "Quarterly financial results" };
  const title = String(item.title || "");
  const news = item.category === "news & research";
  const points = news
    ? []
    : extractHighlights(item.content || "", item.summary || "");
  if (routine.test(title))
    return { important: false, reason: "Routine notice" };
  const brief = String(item.content || "")
    .replace(/\s+/g, " ")
    .trim();
  const statements = [
    title,
    ...points,
    ...(!news && brief.length <= 2000 ? [brief] : []),
  ];
  for (const statement of statements) {
    if (scheduled.test(statement) || routine.test(statement)) continue;
    for (const [reason, pattern] of outcomes)
      if (pattern.test(statement)) return { important: true, reason };
    if (
      /\b(?:quarterly|annual|financial|q[1-4])\s+(?:results|earnings)\b/i.test(
        statement,
      )
    )
      return { important: true, reason: "Financial results" };
    if (
      /\b(?:capacity expansion|capacity addition|new plant|new factory|production capacity)\b/i.test(
        statement,
      ) &&
      /\d/.test(statement)
    )
      return { important: true, reason: "Capacity investment" };
    if (
      /\b(?:launch(?:ed|es)?|partnership)\b/i.test(statement) &&
      /(?:₹|\brs\.?\s*\d|\binr\b|\bcrore\b|\bmillion\b|\bbillion\b|\brevenue\b.{0,30}\d)/i.test(
        statement,
      )
    )
      return { important: true, reason: "Business impact disclosed" };
  }
  // A trusted results classification may describe a short exchange notice.
  // Routine wrappers and scheduled meetings must not pass this fallback.
  if (
    !news &&
    item.category === "results" &&
    !routine.test(title + " " + (item.summary || "")) &&
    !scheduled.test(title + " " + (item.summary || ""))
  )
    return { important: true, reason: "Financial results" };
  return {
    important: false,
    reason: routine.test(title)
      ? "Routine notice"
      : "No supported important event identified",
  };
}
