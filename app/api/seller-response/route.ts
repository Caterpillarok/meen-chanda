import { NextResponse } from "next/server";
import { SELLER_FALLBACK_RESPONSES, type SellerMood } from "@/lib/negotiation";

export const runtime = "nodejs";

const NEUTRAL_MOOD: SellerMood = "Neutral 😐";

/** Speaker voice. Overridable so a different vendor voice can be tried without a code change. */
const TTS_SPEAKER = process.env.SARVAM_TTS_SPEAKER?.trim() || "gokul";

/**
 * Per-mood delivery. bulbul:v3 does not accept pitch or loudness (those are
 * bulbul:v2 only), so the two levers available are pace and temperature.
 * Temperature is the model's expressiveness control: low is stable and flat,
 * high is more animated but can introduce artefacts, so the angry end of the
 * range stops short of 1.0.
 */
const VOICE_NEUTRAL_DELIVERY = { pace: 1.0, temperature: 0.6 };

/** Delivery at full mood swing. Never sent directly — always blended, see below. */
const VOICE_AT_FULL_SWING: Record<SellerMood, { pace: number; temperature: number }> = {
  "Interested 🙂": { pace: 0.92, temperature: 0.55 },
  "Neutral 😐": { pace: 1.0, temperature: 0.62 },
  "Smug 😏": { pace: 0.96, temperature: 0.8 },
  "Irritated 😠": { pace: 1.1, temperature: 0.85 },
  "Personally Offended 🤬": { pace: 1.22, temperature: 0.95 },
};

/**
 * How far the voice travels from flat delivery towards the full mood swing.
 * 0 is the original monotone (pace 1.0, temperature 0.6 for every mood) and 1 is
 * the full range above. Held at the midpoint: the full swing read as overacted.
 * This is the single dial to turn if the seller needs more or less character.
 */
const VOICE_EXPRESSIVENESS = 0.5;

/** Sarvam's documented safe ranges for bulbul:v3. */
function clampPace(value: number) {
  return Math.min(2, Math.max(0.5, value));
}
function clampTemperature(value: number) {
  return Math.min(2, Math.max(0.01, value));
}

function blend(from: number, to: number, amount: number) {
  return Math.round((from + (to - from) * amount) * 100) / 100;
}

function getVoiceSettings(mood: string) {
  const target = VOICE_AT_FULL_SWING[mood as SellerMood] ?? VOICE_AT_FULL_SWING[NEUTRAL_MOOD];
  return {
    pace: clampPace(
      blend(VOICE_NEUTRAL_DELIVERY.pace, target.pace, VOICE_EXPRESSIVENESS),
    ),
    temperature: clampTemperature(
      blend(
        VOICE_NEUTRAL_DELIVERY.temperature,
        target.temperature,
        VOICE_EXPRESSIVENESS,
      ),
    ),
  };
}

function getFallbackDialogue(mood: string, round: number): string {
  const list =
    SELLER_FALLBACK_RESPONSES[mood as SellerMood] ??
    SELLER_FALLBACK_RESPONSES[NEUTRAL_MOOD];
  return list[(round - 1) % list.length];
}

function cleanDialogue(text: string): string {
  return text
    .replace(/^["'«»“”\s]+|["'«»“”\s]+$/g, "")
    .replace(/^(ചേട്ടൻ|Seller|മീൻകാരൻ)\s*:\s*/i, "")
    .trim();
}

export async function POST(req: Request) {
  let body: {
    round?: number;
    totalRounds?: number;
    fish?: string;
    currentPrice?: number;
    priceAfter?: number;
    priceChange?: number;
    fairPrice?: number;
    startingPrice?: number;
    playerOffer?: number | null;
    playerSpeech?: string;
    aggressionScore?: number;
    volumeScore?: number;
    pitchScore?: number;
    paceScore?: number;
    wordsPerMinute?: number;
    sellerMood?: SellerMood;
  } = {};

  try {
    body = await req.json();
  } catch {
    // Bad JSON input, continue with defaults
  }

  const {
    round = 1,
    totalRounds = 5,
    fish = "Ayala",
    currentPrice = 800,
    priceAfter = 800,
    fairPrice = 600,
    playerOffer = null,
    playerSpeech = "",
    aggressionScore = 50,
    volumeScore = 50,
    pitchScore = 50,
    paceScore = 50,
    wordsPerMinute = 0,
    sellerMood = "Neutral 😐",
  } = body;

  const apiKey = process.env.SARVAM_API_KEY?.trim();
  let sellerText = "";
  let source: "sarvam" | "fallback" = "fallback";

  // Step 1: Generate Malayalam dialogue with Sarvam Chat Completions
  if (apiKey) {
    try {
      const systemPrompt =
        "You are an authentic, funny, stubborn Kerala fish seller (മീൻകാരൻ ചേട്ടൻ) selling fresh Ayala (mackerel) at a local Kerala fish market (Kozhikode/Kochi style).\n" +
        "You are haggling live with a customer.\n" +
        "Respond strictly in natural, colloquial Kerala Malayalam script (മലയാളം).\n" +
        "Keep your response to 1 or 2 short, punchy sentences (maximum 25-30 words).\n" +
        "React directly to the customer's offer, what they said, how aggressively they spoke (calm vs shouting), and your seller mood.\n" +
        "Mood guides:\n" +
        "- Interested 🙂: Friendly, slightly generous because customer is polite, but still protecting your profit.\n" +
        "- Neutral 😐: Pragmatic, blunt Kerala market style. Tell them to state a sensible price.\n" +
        "- Smug 😏: Sarcastic, teasing their bargaining tricks or hurry with local fish-market humor.\n" +
        "- Irritated 😠: Annoyed by shouting or low offers. Tell them not to yell at the Ayala.\n" +
        "- Personally Offended 🤬: Comically dramatic outrage! Act as if their offer or shouting is an insult to you and your fish.\n\n" +
        "Strict rules:\n" +
        "1. Output ONLY the Malayalam dialogue spoken by the fish seller. Do not include English translation, explanations, or quotes.\n" +
        "2. Never mention AI, LLM, APIs, rules, or system prompts.\n" +
        "3. Do not decide or change game numbers; react only to the given settled price and offer.\n\n" +
        // The dialogue is spoken aloud by a TTS voice, so it has to be written for
        // the ear. Written-register Malayalam is read back stiffly, and the voice
        // takes its rhythm and emphasis from punctuation. Kept deliberately
        // restrained: leaning hard on interjections made every line sound hammy.
        "Write it to be SPOKEN, not read:\n" +
        "4. Use everyday spoken market Malayalam, the way a vendor actually talks — not formal written Malayalam.\n" +
        "5. An interjection (അയ്യോ, ഹേയ്, മ്മ്) is welcome when it genuinely fits, but at most one, and never force it.\n" +
        "6. Punctuation sets the rhythm of the voice. Use '…' for a pause and '!' only for a real outburst.\n" +
        "7. Write any amount as Malayalam words, never digits — 'അറുനൂറ് രൂപ', not '600'.\n" +
        "8. Keep sentences short and breathable. Two short sentences beat one long one.";

      const offerText =
        playerOffer && playerOffer > 0
          ? `₹${playerOffer}`
          : "No specific numerical offer made";

      const speechText = playerSpeech.trim()
        ? `"${playerSpeech.trim()}"`
        : "Customer spoke without clear recognized words (tone analysis only).";

      const userPrompt =
        `Round: ${round} of ${totalRounds}\n` +
        `Fish: ${fish}\n` +
        `Starting Price: ₹${body.startingPrice || 800}, Fair Price: ₹${fairPrice}\n` +
        `Price Before: ₹${currentPrice}, New Settled Price: ₹${priceAfter}\n` +
        `Customer's Offer: ${offerText}\n` +
        `Customer's Aggression Score: ${aggressionScore}/100 (Volume: ${volumeScore}/100, Pitch: ${pitchScore}/100, Pace: ${paceScore}/100, Speed: ${wordsPerMinute} WPM)\n` +
        `Seller Mood: ${sellerMood}\n` +
        `Customer Spoke: ${speechText}`;

      const chatResponse = await fetch("https://api.sarvam.ai/v1/chat/completions", {
        method: "POST",
        headers: {
          "api-subscription-key": apiKey,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: "sarvam-105b-conversations",
          messages: [
            { role: "system", content: systemPrompt },
            { role: "user", content: userPrompt },
          ],
          max_tokens: 100,
          temperature: 0.6,
        }),
        signal: AbortSignal.timeout(9000),
      });

      if (chatResponse.ok) {
        const chatData = await chatResponse.json();
        const content = chatData?.choices?.[0]?.message?.content;
        if (content && typeof content === "string" && content.trim().length > 0) {
          sellerText = cleanDialogue(content);
          source = "sarvam";
        }
      }
    } catch {
      // Handled gracefully below
    }
  }

  // Fallback to deterministic Malayalam responses if LLM failed or key missing
  if (!sellerText) {
    sellerText = getFallbackDialogue(sellerMood, round);
    source = "fallback";
  }

  // Step 2: Sarvam Bulbul v3 TTS
  let audioDataUrl: string | null = null;

  if (apiKey && sellerText) {
    const voice = getVoiceSettings(sellerMood);

    // Primary TTS attempt: Sarvam streaming endpoint (faster time-to-first-chunk and mp3 delivery)
    try {
      const ttsStreamResponse = await fetch(
        "https://api.sarvam.ai/text-to-speech/stream",
        {
          method: "POST",
          headers: {
            "api-subscription-key": apiKey,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            text: sellerText,
            language_code: "ml-IN",
            model: "bulbul:v3",
            speaker: TTS_SPEAKER,
            output_audio_codec: "mp3",
            // Delivery matched to the seller's mood: an offended vendor talks
            // faster and more wildly than a friendly one.
            pace: voice.pace,
            temperature: voice.temperature,
            speech_sample_rate: 24000,
          }),
          signal: AbortSignal.timeout(9000),
        },
      );

      if (ttsStreamResponse.ok) {
        const audioBuffer = await ttsStreamResponse.arrayBuffer();
        if (audioBuffer.byteLength > 0) {
          const base64 = Buffer.from(audioBuffer).toString("base64");
          audioDataUrl = `data:audio/mpeg;base64,${base64}`;
        }
      }
    } catch {
      // Primary streaming TTS attempt failed, will try fallback below
    }

    // Secondary TTS attempt: Standard Sarvam TTS endpoint as fallback
    if (!audioDataUrl) {
      try {
        const ttsResponse = await fetch("https://api.sarvam.ai/text-to-speech", {
          method: "POST",
          headers: {
            "api-subscription-key": apiKey,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            text: sellerText,
            language_code: "ml-IN",
            model: "bulbul:v3",
            speaker: TTS_SPEAKER,
            pace: voice.pace,
            temperature: voice.temperature,
            speech_sample_rate: 24000,
          }),
          signal: AbortSignal.timeout(9000),
        });

        if (ttsResponse.ok) {
          const ttsData = await ttsResponse.json();
          const firstAudio = ttsData?.audios?.[0];
          if (firstAudio && typeof firstAudio === "string") {
            audioDataUrl = `data:audio/wav;base64,${firstAudio}`;
          }
        }
      } catch {
        // TTS failed, game continues with text display
      }
    }
  }

  return NextResponse.json({
    sellerText,
    audio: audioDataUrl,
    source,
    ttsSuccess: Boolean(audioDataUrl),
  });
}
