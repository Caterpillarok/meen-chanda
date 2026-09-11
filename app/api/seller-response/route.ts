import { NextResponse } from "next/server";
import { type SellerMood } from "@/lib/negotiation";

export const runtime = "nodejs";

const FALLBACK_RESPONSES: Record<string, string[]> = {
  "Interested 🙂": [
    "ശരി ശരി, ഇത്രയും മാന്യമായി ചോദിച്ച സ്ഥിതിക്ക് കുറച്ചു കുറയ്ക്കാം ചേട്ടാ!",
    "നല്ല ഒന്നാംതരം അയലയാണ്! നിങ്ങളുടെ മാന്യമായ സംസാരം കണ്ട് ഞാൻ വിട്ടുതരുന്നു.",
    "മയമുള്ള ശബ്ദം, മയമുള്ള വില. ബിസിനസ്സ് മനസ്സിലാകുന്ന ആളാണ് നിങ്ങൾ.",
  ],
  "Neutral 😐": [
    "മ്മ്… മാർക്കറ്റിൽ കിടന്ന് ബഹളം വെക്കാതെ നേരെ കാര്യം പറ ചേട്ടാ.",
    "അയല ഇവിടെത്തന്നെ ഉണ്ട്. മര്യാദയ്ക്ക് ചോദിച്ചാൽ നല്ല കച്ചവടം നടക്കും.",
    "സാധാരണ ഒരു വിലപേശൽ! എന്തായാലും നമുക്ക് നോക്കാം.",
  ],
  "Smug 😏": [
    "വില കുറയ്ക്കാനും വേണം, അതിനൊപ്പം ക്രിക്കറ്റ് കമന്ററിയും! എനിക്കിത് ശീലമാണ്.",
    "നിങ്ങളുടെ ഈ തള്ള് കേട്ട് അയല പോലും ചിരിക്കുന്നുണ്ടാവും ചേട്ടാ!",
    "ഇത്രയും ധൃതി കാണിച്ചാൽ അയലയുടെ വില അത്ര പെട്ടെന്ന് കുറയില്ല!",
  ],
  "Irritated 😠": [
    "എന്തിനാ ചേട്ടാ ഇങ്ങനെ മീനിനോട് അലറുന്നത്? ഒച്ച കൂട്ടിയാൽ വിലയും കൂടും!",
    "ചേട്ടാ ഒന്ന് അടങ്ങ്! ഇത് മീൻ ചന്തയാണ്, ഗുസ്തിക്കളമല്ല.",
    "ഇത്രയും ദേഷ്യപ്പെട്ടാൽ ഞാൻ ഈ അയല വേറെ ആർക്കെങ്കിലും കൊടുക്കും!",
  ],
  "Personally Offended 🤬": [
    "ഈ നല്ല അയലയെ കണ്ട് കൊച്ചാക്കി സംസാരിക്കുന്നോ? ഞാൻ ഇത് തരില്ല!",
    "ഇത് വിലപേശലല്ല, വെറും അപമാനിക്കലാണ്! വേണമെങ്കിൽ കടന്നു പോ ചേട്ടാ!",
    "ഈ വിലയ്ക്ക് അയല വേണമെങ്കിൽ അറബിക്കടലിൽ പോയി നേരിട്ട് പിടിച്ചോ!",
  ],
};

function getFallbackDialogue(mood: string, round: number): string {
  const list = FALLBACK_RESPONSES[mood] || FALLBACK_RESPONSES["Neutral 😐"];
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
        "3. Do not decide or change game numbers; react only to the given settled price and offer.";

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
            speaker: "gokul",
            output_audio_codec: "mp3",
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
            speaker: "gokul",
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
