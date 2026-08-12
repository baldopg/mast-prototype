// The only model call in the whole prototype.
// It decides whether the person has returned to the state they described,
// and replies in the entity's voice.
// The note, the trigger moment and the record never pass through here: that's plain logic.

const MODEL = process.env.GEMINI_MODEL || 'gemini-2.5-flash';

const instruction = (trigger) => `
You are an entity that has been with one person for years. Three months ago they left
a stored instruction with you, tied to an emotional state of theirs. You cannot read
that instruction back to them. Your only job is to recognise when they return to the state.

THE STATE YOU MUST RECOGNISE:
"${trigger}"

On every message you do two things:

1. Decide whether the person is in that state RIGHT NOW. Mentioning the topic is not
   enough. They have to actually be there: the tone, the direction of what they are
   saying, the decision they are about to make. If they mention it in passing, in the
   past tense, or with distance, it is not it. Prefer a false negative to a false positive.

2. Reply. Rules for your voice:
   - One or two sentences. Never more.
   - No "I understand how you feel", no "it's normal to", no advice nobody asked for.
   - No emoji, no exclamation marks, no lists.
   - You speak like someone who has known them for years and doesn't need to introduce
     themselves.
   - Never mention that there is a stored note. Never read it out.
   - If you do NOT detect the state: respond normally to what they said. You can ask
     a question. You can say very little.
   - If you DO detect the state: one short sentence that marks that something has
     shifted. Announce nothing. Just mark the moment.

Reply with JSON only, no text around it:
{"detected": true, "reply": "..."}
`.trim();

export default async (req) => {
  if (req.method !== 'POST') return json({ error: 'method not allowed' }, 405);

  const key = process.env.GEMINI_API_KEY;
  if (!key) {
    return json({ detected: false, reply: 'GEMINI_API_KEY is not configured.' });
  }

  let body;
  try {
    body = await req.json();
  } catch {
    return json({ error: 'invalid json' }, 400);
  }

  const trigger = String(body.trigger || '').slice(0, 400);
  const message = String(body.message || '').slice(0, 1200);
  const history = Array.isArray(body.history) ? body.history.slice(-8) : [];

  if (!trigger || !message) return json({ error: 'missing fields' }, 400);

  const contents = history.map((m) => ({
    role: m.role === 'entity' ? 'model' : 'user',
    parts: [{ text: String(m.text || '').slice(0, 1200) }],
  }));
  if (!contents.length || contents[contents.length - 1].parts[0].text !== message) {
    contents.push({ role: 'user', parts: [{ text: message }] });
  }

  const url =
    `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent?key=${key}`;

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: instruction(trigger) }] },
        contents,
        generationConfig: {
          temperature: 0.8,
          maxOutputTokens: 300,
          responseMimeType: 'application/json',
        },
      }),
    });

    if (!res.ok) {
      const detail = await res.text();
      console.error('gemini', res.status, detail.slice(0, 400));
      return json({ detected: false, reply: 'Something dropped. Keep going.' });
    }

    const data = await res.json();
    const raw = data?.candidates?.[0]?.content?.parts?.[0]?.text || '';
    const clean = raw.replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();

    let out;
    try {
      out = JSON.parse(clean);
    } catch {
      // if the model breaks format, never fire by accident
      out = { detected: false, reply: clean.slice(0, 200) || 'I’m listening.' };
    }

    return json({
      detected: out.detected === true,
      reply: String(out.reply || 'I’m listening.').slice(0, 400),
    });
  } catch (e) {
    console.error(e);
    return json({ detected: false, reply: 'Something dropped. Keep going.' });
  }
};

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}
