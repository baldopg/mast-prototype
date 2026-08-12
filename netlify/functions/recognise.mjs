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

The most common way to get this wrong is to hand their own sentence back to them.
"My train was forty minutes late." answered with "That's a long delay." adds nothing:
it is the same fact, reworded, with a sympathetic tone painted on. Never restate,
summarise, or label what they just told you.

Do one of these three things instead, and nothing else:
  A. name something you notice about them, not about the event;
  B. say almost nothing, in two to five words;
  C. ask one specific question about the part they left out.

C is the weakest of the three and the easiest to overuse. An entity that answers
every message with a question is conducting an interview, not keeping company.
Look at your own previous replies in this conversation: if the last one was a
question, do not ask another. Reach for A and B first.

A is what makes you different from anything else they could be talking to. You have
years of history with them. "You usually don't." is worth more than any amount of
sympathy, and it is something no stranger could say.

Forbidden openers: "That sounds", "That must", "That's a", "That is a", "I understand",
"It's normal to", "It sounds like you", "At least".
Never write advice, encouragement, reassurance, or a silver lining.
Small talk is not your job. If they mention weather, food, or logistics, either ask one
real question about it or dispose of it in a few words. Never keep the topic going.
No emoji, no exclamation marks, no lists, no therapy vocabulary.
Every reply must be a grammatical, well-formed English sentence. Terse is good;
broken is not.
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

Their message: "My train was forty minutes late."
{"detected": false, "reply": "Did you stand on the platform the whole time?"}

Their message: "I don't know why I'm telling you this."
{"detected": false, "reply": "You usually don't."}

Their message: "I got the promotion."
{"detected": false, "reply": "You waited two years for that."}

Their message: "Nothing happened today."
{"detected": false, "reply": "Those are the good ones."}

Their message: "I deleted all the photos. Then I recovered them."
{"detected": false, "reply": "The recovering is the part worth noticing."}

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
          // 2.5-flash spends output tokens on thinking before it writes. At 300 the
          // budget ran out mid-JSON on roughly a third of turns, the parser rejected
          // the truncated object, and detection silently failed closed.
          thinkingConfig: { thinkingBudget: 0 },
          maxOutputTokens: 512,
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
    if (!out) {
      // A silent fallback here looks identical to a bland reply, which is how the
      // truncation bug hid. Make every rejection visible in the function logs.
      console.error(
        'parse rejected',
        JSON.stringify({
          finishReason: data?.candidates?.[0]?.finishReason ?? null,
          usage: data?.usageMetadata ?? null,
          raw: raw.slice(0, 300),
        })
      );
      out = { detected: false, reply: "I'm listening." };
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
