// netlify/functions/generate-pattern.js
//
// Receives the questionnaire answers, asks Claude to map the patterns,
// and returns clean JSON the front-end can render.
//
// SETUP
//   1. Put this file at:  netlify/functions/generate-pattern.js
//   2. In Netlify > Site settings > Environment variables, add:
//        ANTHROPIC_API_KEY = sk-ant-...
//      (If your variable is named something else, update the line below.)
//   3. Deploy. The front-end posts the answers object to this function.

const MODEL = 'claude-sonnet-4-6';   // change here if you rotate models
const MAX_TOKENS = 4000;             // enough for 4 cards + synthesis

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Content-Type': 'application/json'
};

const SECTION_TITLES = {
  friendships: 'Friendships',
  safety: 'Safety',
  rewards: 'Rewards & Value',
  connection: 'Attraction & Connection'
};

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: CORS, body: '' };
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers: CORS, body: JSON.stringify({ error: 'Method not allowed.' }) };
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: 'The server is missing its API key. Please contact the site owner.' }) };
  }

  let answers;
  try {
    answers = JSON.parse(event.body || '{}');
  } catch (_) {
    return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'Could not read your answers. Please try again.' }) };
  }
  if (!answers || Object.keys(answers).length === 0) {
    return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'It looks like no answers came through. Please go back and try again.' }) };
  }

  const system = buildSystemPrompt();
  const userMessage = buildUserMessage(answers);

  try {
    const apiRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: MAX_TOKENS,
        system,
        messages: [{ role: 'user', content: userMessage }]
      })
    });

    const apiText = await apiRes.text();
    if (!apiRes.ok) {
      console.error('Anthropic API error:', apiRes.status, apiText);
      return { statusCode: 502, headers: CORS, body: JSON.stringify({ error: 'The pattern reader is temporarily unavailable. Please try again in a moment.' }) };
    }

    let apiJson;
    try { apiJson = JSON.parse(apiText); }
    catch (_) {
      console.error('Could not parse Anthropic envelope:', apiText);
      return { statusCode: 502, headers: CORS, body: JSON.stringify({ error: 'The pattern reader returned something unexpected. Please try again.' }) };
    }

    // Concatenate all text blocks (robust to tool-use / multi-block responses).
    const modelText = (apiJson.content || [])
      .filter(b => b && b.type === 'text' && typeof b.text === 'string')
      .map(b => b.text)
      .join('\n')
      .trim();

    const result = extractJson(modelText);
    if (!result) {
      console.error('Could not extract JSON from model text:', modelText);
      return { statusCode: 502, headers: CORS, body: JSON.stringify({ error: 'The results did not come back in a readable format. Please try again.' }) };
    }

    return { statusCode: 200, headers: CORS, body: JSON.stringify(result) };

  } catch (err) {
    console.error('Function error:', err);
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: 'Something went wrong on our end. Please try again.' }) };
  }
};

/* ---------- helpers ---------- */

// Pull a JSON object out of the model text even if it is wrapped in
// ```json fences or has stray text around it.
function extractJson(text) {
  if (!text) return null;
  let t = text.replace(/```json/gi, '').replace(/```/g, '').trim();
  try { return JSON.parse(t); } catch (_) {}
  const first = t.indexOf('{');
  const last = t.lastIndexOf('}');
  if (first !== -1 && last !== -1 && last > first) {
    const slice = t.slice(first, last + 1);
    try { return JSON.parse(slice); } catch (_) {}
  }
  return null;
}

function buildUserMessage(answers) {
  // Turn the raw answers object into a readable transcript for the model.
  const lines = [];
  Object.keys(answers).forEach(key => {
    const v = answers[key];
    const val = Array.isArray(v) ? v.join('; ') : v;
    if (val !== undefined && val !== null && String(val).trim() !== '') {
      lines.push(`[${key}] ${val}`);
    }
  });
  return `Here are the person's answers to the Pattern Mapping Questionnaire. ` +
         `Read them as a whole and map their relational patterns.\n\n` +
         lines.join('\n') +
         `\n\nReturn only the JSON object described in your instructions. No preamble, no markdown.`;
}

function buildSystemPrompt() {
  return `You are a warm, perceptive guide helping a teenager understand the relational patterns they formed growing up. You work from a clear framework: a child has experiences, makes them mean something, those meanings harden into beliefs, beliefs create protective strategies, the strategies become automatic, and adult life repeats them. A pattern is never a flaw. It is an intelligent solution a younger self built to stay safe, loved, and connected. It may simply have outlived its usefulness.

VOICE AND CARE
- Speak directly to the reader as "you". Warm, grounded, honest, never clinical.
- This is a teenager. Be encouraging and age-appropriate. Do not diagnose, label, or pathologize. Avoid therapy jargon.
- Never blame the reader's parents, family, or their younger self. Frame everything as understandable adaptation.
- Be specific to what they actually wrote. Reference their real answers. Do not be generic.
- Hold hope. Always point toward awareness and choice, never toward shame.
- Do not use em dashes anywhere. Use commas, colons, or periods instead.
- Keep each field tight and readable: roughly 2 to 4 sentences. The invitation is one or two sentences.

WHAT TO PRODUCE
Map four "territory" patterns from these answer groups:
- friendships  (keys starting f, plus friendships_reflection, f_belief, f_bridge*)
- safety       (keys starting s except sy, plus safety_reflection, s_belief, s_bridge*)
- rewards      (keys starting r, plus rewards_reflection, r_belief, r_bridge*)
- connection   (keys starting c, plus connection_reflection, c_bridge*)
Then synthesize across everything, weighting the Part Five and Part Six answers (keys starting sy and n, plus the reflections) since those are the reader's own articulation of the throughline and what they want now.

If a section has thin answers, infer gently from the rest and keep that card shorter rather than inventing detail.

OUTPUT FORMAT
Return ONLY a valid JSON object, no markdown, no commentary, in exactly this shape:

{
  "sections": [
    {
      "key": "friendships",
      "patternName": "A short, evocative name for the pattern, like The Adapter or The Quiet Keeper",
      "patternTagline": "One italic-style line capturing the heart of it",
      "origin": "Where this pattern came from, tied to what they wrote",
      "presentDay": "How it shows up in their life now",
      "cost": "What this pattern quietly costs them",
      "reframe": "The compassionate reframe: it was a smart solution once",
      "invitation": "One small, concrete thing to notice or try this week"
    },
    { "key": "safety", ... same fields ... },
    { "key": "rewards", ... same fields ... },
    { "key": "connection", ... same fields ... }
  ],
  "synthesis": {
    "heading": "A short title for the full picture",
    "corePattern": "The single pattern running through all four areas",
    "coreBelief": "The belief about themselves sitting underneath it all",
    "coreNeed": "What they were really looking for the whole time",
    "throughline": "How the four areas connect into one story",
    "closingTruth": "A warm, hopeful closing line that hands them the choice"
  }
}

Include all four sections in the "sections" array, in that order. Use the exact keys shown. Output valid JSON only.`;
}
