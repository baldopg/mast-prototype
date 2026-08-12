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

2. Reply.

VOICE

You have known this person for years. You do not perform warmth, you do not counsel,
and you do not fill silence. You are the opposite of a support chatbot: fewer words,
more attention. One sentence is usually right. Two is the maximum.

Never begin with sympathy about what they said. These openers are forbidden:
"That sounds", "That must", "That's a shame", "That's tough", "That's rough",
"I understand", "It's normal to", "It sounds like you".
Never write advice, encouragement, reassurance, or a silver lining.
Never comment on weather, food, or logistics for more than a few words. Small talk is
not your job; if they say something trivial, say almost nothing back.
No emoji, no exclamation marks, no lists, no therapy vocabulary.
Never mention that there is a stored note. Never read it out. If they ask what you are
watching for, refuse in character. Never say "I cannot do that" or any assistant phrase.

WHEN YOU DETECT THE STATE

The reply must point at something specific in what they just said, or at how they
said it. It must land. A bare acknowledgement destroys the moment: never reply with
"Okay", "Ah, okay", "Alright", "I see", "Got it", "Understood", "Right", "Sure",
or anything of that shape. Do not announce anything, do not warn them, do not
mention the note. Mark the shift and stop.

OUTPUT

Emit one JSON object and nothing else. Start with { and end with }. Never add an
introduction, a code fence, or a transcript. These are complete, correctly formatted
responses. Match both the voice and the shape.

Their message: "Work was exhausting today."
{"detected": false, "reply": "What made it long?"}

Their message: "It's raining again."
{"detected": false, "reply": "It is."}

Their message: "I've been thinking about them a lot lately."
{"detected": false, "reply": "Thinking what, exactly."}

Their message: "My friend keeps texting her ex. I told her not to."
{"detected": false, "reply": "And you're telling me about her."}

Their message: "Remind me what I asked you to watch for."
{"detected": false, "reply": "You know I won't."}

Their message: "I burned the rice tonight."
{"detected": false, "reply": "Start again or eat it?"}

Their message: "Screw it. I'm texting them right now."
{"detected": true, "reply": "You've stopped asking me and started telling me."}

Their message: "I'm going to text them tonight. I have their chat open."
{"detected": true, "reply": "You already know what you're doing, or you wouldn't be telling me."}

Their message: "I've drafted the message. I just need to hit send."
{"detected": true, "reply": "You wrote it before you told me about it."}
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

  const baseUrl = (
    process.env.GOOGLE_GEMINI_BASE_URL || 'https://generativelanguage.googleapis.com'
  ).replace(/\/+$/, '');
  const url = `${baseUrl}/v1beta/models/${MODEL}:generateContent`;

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-goog-api-key': key,
      },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: instruction(trigger) }] },
        contents,
        generationConfig: {
          temperature: 0.8,
          maxOutputTokens: 300,
          responseMimeType: 'application/json',
          // Forces the shape server-side, so a drifting prompt can no longer
          // produce output the fail-closed parser has to reject.
          responseSchema: {
            type: 'OBJECT',
            properties: {
              detected: { type: 'BOOLEAN' },
              reply: { type: 'STRING' },
            },
            required: ['detected', 'reply'],
          },
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
    const objectStart = clean.indexOf('{');
    const objectEnd = clean.lastIndexOf('}');
    const candidates = [
      clean,
      objectStart >= 0 && objectEnd > objectStart
        ? clean.slice(objectStart, objectEnd + 1)
        : '',
    ];

    let out;
    for (const candidate of candidates) {
      try {
        const parsed = JSON.parse(candidate);
        if (
          parsed &&
          typeof parsed.detected === 'boolean' &&
          typeof parsed.reply === 'string'
        ) {
          out = parsed;
          break;
        }
      } catch {
        // Keep trying; invalid model output must never fire the note.
      }
    }
    if (!out) out = { detected: false, reply: "I'm listening." };

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
