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
    "Chetta, that peaceful voice is making me generous.",
    "Ayala likes polite customers. I can move a little.",
    "Soft voice, soft price. You understand business.",
  ],
  "Neutral 😐": [
    "Hmm. Say your price without making a scene.",
    "The fish is listening. Keep it civil.",
    "A normal bargain. What a refreshing surprise.",
  ],
  "Smug 😏": [
    "You want a discount and you sound like a cricket commentator?",
    "The Ayala is not impressed, but I am entertained.",
    "Chetta, your bargaining has extra seasoning today.",
  ],
  "Irritated 😠": [
    "Why are you shouting at the Ayala?",
    "Louder voice, higher price. Market rule.",
    "Chetta, calm down. It is only a fish.",
  ],
  "Personally Offended 🤬": [
    "At this rate, the fish is becoming more expensive than you.",
    "You called the fish small? Now you have offended me.",
    "This is not bargaining. This is a weather warning!",
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
