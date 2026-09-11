export const GAME_CONFIG = {
  fish: "Ayala",
  startingPrice: 800,
  fairPrice: 600,
  totalRounds: 5,
  lowestPrice: 540,
  highestPrice: 1250,
  audio: {
    volumeWeight: 0.4,
    pitchWeight: 0.3,
    paceWeight: 0.3,
    quietRms: 0.012,
    loudRms: 0.1,
    lowPitchHz: 130,
    highPitchHz: 280,
    calmPaceWpm: 90,
    fastPaceWpm: 210,
  },
  priceChanges: {
    veryCalm: -90,
    calm: -50,
    neutral: -10,
    aggressive: 45,
    extreme: 95,
    reasonableOffer: -15,
    unrealisticOffer: 20,
    highOffer: 10,
  },
} as const;

export type SellerMood =
  | "Interested 🙂"
  | "Neutral 😐"
  | "Smug 😏"
  | "Irritated 😠"
  | "Personally Offended 🤬";

export type AudioMeasurements = {
  averageVolume: number;
  averagePitch: number;
  wordCount: number;
  durationSeconds: number;
  hadVoice: boolean;
  fallbackMode?: boolean;
};

export type AggressionResult = {
  score: number;
  volumeScore: number;
  pitchScore: number;
  paceScore: number;
  wordsPerMinute: number;
};

export type RoundResult = {
  priceAfter: number;
  priceChange: number;
  sellerMood: SellerMood;
  sellerResponse: string;
};

function clamp(value: number, minimum: number, maximum: number) {
  return Math.min(Math.max(value, minimum), maximum);
}

function scoreBetween(value: number, low: number, high: number) {
  return clamp(((value - low) / (high - low)) * 100, 0, 100);
}

export function calculateAggression(
  measurements: AudioMeasurements,
): AggressionResult {
  if (measurements.fallbackMode) {
    return {
      score: 50,
      volumeScore: 50,
      pitchScore: 50,
      paceScore: 50,
      wordsPerMinute: 0,
    };
  }

  if (!measurements.hadVoice) {
    return {
      score: 12,
      volumeScore: 0,
      pitchScore: 20,
      paceScore: 20,
      wordsPerMinute: 0,
    };
  }

  const volumeScore = scoreBetween(
    measurements.averageVolume,
    GAME_CONFIG.audio.quietRms,
    GAME_CONFIG.audio.loudRms,
  );
  const pitchScore = measurements.averagePitch
    ? scoreBetween(
        measurements.averagePitch,
        GAME_CONFIG.audio.lowPitchHz,
        GAME_CONFIG.audio.highPitchHz,
      )
    : 25;
  const wordsPerMinute =
    measurements.wordCount > 0 && measurements.durationSeconds > 0
      ? (measurements.wordCount / measurements.durationSeconds) * 60
      : 0;
  const paceScore = wordsPerMinute
    ? scoreBetween(
        wordsPerMinute,
        GAME_CONFIG.audio.calmPaceWpm,
        GAME_CONFIG.audio.fastPaceWpm,
      )
    : 20;
  const score = Math.round(
    volumeScore * GAME_CONFIG.audio.volumeWeight +
      pitchScore * GAME_CONFIG.audio.pitchWeight +
      paceScore * GAME_CONFIG.audio.paceWeight,
  );

  return {
    score: clamp(score, 0, 100),
    volumeScore: Math.round(volumeScore),
    pitchScore: Math.round(pitchScore),
    paceScore: Math.round(paceScore),
    wordsPerMinute: Math.round(wordsPerMinute),
  };
}

export function getSellerMood(aggression: number): SellerMood {
  if (aggression <= 24) return "Interested 🙂";
  if (aggression <= 44) return "Neutral 😐";
  if (aggression <= 64) return "Smug 😏";
  if (aggression <= 82) return "Irritated 😠";
  return "Personally Offended 🤬";
}

function getAggressionPriceChange(aggression: number) {
  if (aggression <= 20) return GAME_CONFIG.priceChanges.veryCalm;
  if (aggression <= 40) return GAME_CONFIG.priceChanges.calm;
  if (aggression <= 60) return GAME_CONFIG.priceChanges.neutral;
  if (aggression <= 80) return GAME_CONFIG.priceChanges.aggressive;
  return GAME_CONFIG.priceChanges.extreme;
}

function getOfferAdjustment(currentPrice: number, playerOffer: number | null) {
  if (!playerOffer || playerOffer <= 0) return 0;
  if (playerOffer > currentPrice) return GAME_CONFIG.priceChanges.highOffer;
  if (playerOffer < GAME_CONFIG.fairPrice * 0.75) {
    return GAME_CONFIG.priceChanges.unrealisticOffer;
  }

  const discountRequested = (currentPrice - playerOffer) / currentPrice;
  return discountRequested <= 0.12 ? GAME_CONFIG.priceChanges.reasonableOffer : 0;
}

const responses: Record<SellerMood, string[]> = {
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

export function settleRound({
  currentPrice,
  playerOffer,
  aggression,
  round,
}: {
  currentPrice: number;
  playerOffer: number | null;
  aggression: number;
  round: number;
}): RoundResult {
  const sellerMood = getSellerMood(aggression);
  const rawPrice =
    currentPrice +
    getAggressionPriceChange(aggression) +
    getOfferAdjustment(currentPrice, playerOffer);
  const priceAfter = clamp(
    Math.round(rawPrice / 10) * 10,
    GAME_CONFIG.lowestPrice,
    GAME_CONFIG.highestPrice,
  );
  const reactionOptions = responses[sellerMood];

  return {
    priceAfter,
    priceChange: priceAfter - currentPrice,
    sellerMood,
    sellerResponse:
      reactionOptions[(round + Math.floor(aggression / 10)) % reactionOptions.length],
  };
}

export function getFinalTitle(finalPrice: number, averageAggression: number) {
  if (finalPrice <= GAME_CONFIG.fairPrice + 10 && averageAggression < 35) {
    return "Market Whisperer 🐟";
  }
  if (averageAggression >= 80 || finalPrice >= 900) {
    return "Loudest Loser 📣";
  }
  if (finalPrice < GAME_CONFIG.startingPrice) return "Respectful Bargainer 🙂";
  return "Ayala's Favourite Customer 😏";
}
