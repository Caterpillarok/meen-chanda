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
    // Volume is scored as signal-to-noise ratio in dB above the player's own
    // measured noise floor, NOT as an absolute RMS value. Microphone gain varies
    // by 10-40x across devices and OS input settings, so any fixed RMS ceiling is
    // unreachable on a quiet mic and trivially saturated on a hot one. Gain
    // multiplies the voice and the noise floor equally, so their ratio survives it.
    quietSnrDb: 20,
    loudSnrDb: 42,
    // Clamps on the measured noise floor, guarding against a pathological
    // near-zero frame turning into an enormous SNR.
    minNoiseFloorRms: 0.00002,
    maxNoiseFloorRms: 0.02,
    /** A frame counts as voiced at this ratio above the noise floor (~10 dB). */
    voiceGateRatio: 3.2,
    /** Absolute backstop so digital silence is never treated as voice. */
    silenceRms: 0.00025,
    lowPitchHz: 95,
    highPitchHz: 250,
    calmPaceWpm: 90,
    fastPaceWpm: 210,
  },
  priceChanges: {
    veryCalm: -70,
    calm: -45,
    measured: -20,
    // A genuinely average round must hold the price. This was -10, so the price
    // drifted down even when the player did nothing persuasive.
    neutral: 0,
    aggressive: 45,
    extreme: 90,
    // Offer adjustments are multiples of 10 so they survive the
    // round-to-nearest-10 applied to the settled price. Smaller values were
    // silently quantised away and had no observable effect.
    reasonableOffer: -20,
    moderateOffer: -10,
    steepOffer: 10,
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
  /** Quietest RMS seen while the microphone was open, used as the SNR reference. */
  noiseFloorRms: number;
  /**
   * Shifts the loudness window to suit the room and microphone. Positive values
   * mean "this setup reads hot, expect more dB before calling it shouting".
   */
  sensitivityOffsetDb?: number;
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
  /** Measured dB above the noise floor. Surfaced so the score can be calibrated. */
  volumeSnrDb: number;
  noiseFloorRms: number;
};

export type RoundResult = {
  priceAfter: number;
  priceChange: number;
  sellerMood: SellerMood;
  sellerResponse: string;
};

/** Neutral pace score used when no transcribed words are available to time. */
const UNMEASURABLE_PACE_SCORE = 50;
/**
 * Neutral score used when pitch could not be detected. This was 25, which handed
 * out a discount every time pitch tracking failed — the same bug already fixed
 * for pace. An unmeasured signal must never be cheaper than a measured one.
 */
const UNMEASURABLE_PITCH_SCORE = 50;

function clamp(value: number, minimum: number, maximum: number) {
  return Math.min(Math.max(value, minimum), maximum);
}

function scoreBetween(value: number, low: number, high: number) {
  return clamp(((value - low) / (high - low)) * 100, 0, 100);
}

/**
 * Percentile of observed frame loudness treated as the background noise floor.
 * A plain minimum is unusable here: one near-silent frame (the AudioContext
 * always produces some while it spins up) would drop the floor to the clamp and
 * inflate every SNR reading to the ceiling. A low percentile lands inside the
 * gaps between words while ignoring outliers.
 */
const NOISE_FLOOR_PERCENTILE = 0.1;

/**
 * Estimates the background noise floor from raw per-frame RMS values. Shared by
 * the live meter and the end-of-round scoring so the number the player watches is
 * the same one the seller reacts to.
 */
export function estimateNoiseFloorRms(rmsValues: readonly number[]) {
  const positive = rmsValues.filter((value) => value > 0).sort((a, b) => a - b);
  if (!positive.length) return GAME_CONFIG.audio.minNoiseFloorRms;
  const index = Math.min(
    positive.length - 1,
    Math.floor(positive.length * NOISE_FLOOR_PERCENTILE),
  );
  return clamp(
    positive[index],
    GAME_CONFIG.audio.minNoiseFloorRms,
    GAME_CONFIG.audio.maxNoiseFloorRms,
  );
}

/**
 * Bounds for the user-facing sensitivity control, in dB. Wide enough that a very
 * quiet room (where a normal voice can measure 60+ dB above its noise floor) is
 * still reachable; ±30 clamped out before calibration could finish the job.
 */
export const MIN_SENSITIVITY_OFFSET_DB = -45;
export const MAX_SENSITIVITY_OFFSET_DB = 45;
/**
 * Where a normal speaking voice should sit inside the loudness window. Calibration
 * shifts the window so the player's measured normal voice lands here, leaving
 * headroom above for a raised voice and shouting.
 */
const CALIBRATION_TARGET_FRACTION = 0.4;

/**
 * The loudness window actually in force, after the sensitivity offset. Every part
 * of the app reads the window from here so the meter and the score cannot diverge.
 */
export function getEffectiveSnrWindow(offsetDb = 0) {
  return {
    quiet: GAME_CONFIG.audio.quietSnrDb + offsetDb,
    loud: GAME_CONFIG.audio.loudSnrDb + offsetDb,
  };
}

/** Meter fill for a given loudness, 0-100. */
export function getVolumeMeterPercent(snrDb: number, offsetDb = 0) {
  const { quiet, loud } = getEffectiveSnrWindow(offsetDb);
  return Math.round(scoreBetween(snrDb, quiet, loud));
}

/**
 * Offset that places the supplied "this is my normal voice" reading at the target
 * position in the window. Lets a player calibrate to their own room and hardware
 * instead of relying on thresholds guessed in advance.
 */
export function getCalibrationOffsetDb(measuredNormalSnrDb: number) {
  const span = GAME_CONFIG.audio.loudSnrDb - GAME_CONFIG.audio.quietSnrDb;
  const target = GAME_CONFIG.audio.quietSnrDb + span * CALIBRATION_TARGET_FRACTION;
  return Math.round(
    clamp(
      measuredNormalSnrDb - target,
      MIN_SENSITIVITY_OFFSET_DB,
      MAX_SENSITIVITY_OFFSET_DB,
    ),
  );
}

/**
 * Loudness relative to the player's own noise floor, in dB. Returns 0 when there
 * is nothing to measure.
 */
export function getVolumeSnrDb(averageVolume: number, noiseFloorRms: number) {
  if (averageVolume <= 0) return 0;
  const floor = clamp(
    noiseFloorRms > 0 ? noiseFloorRms : GAME_CONFIG.audio.minNoiseFloorRms,
    GAME_CONFIG.audio.minNoiseFloorRms,
    GAME_CONFIG.audio.maxNoiseFloorRms,
  );
  return Math.max(0, 20 * Math.log10(averageVolume / floor));
}

export function calculateAggression(
  measurements: AudioMeasurements,
): AggressionResult {
  const volumeSnrDb = getVolumeSnrDb(
    measurements.averageVolume,
    measurements.noiseFloorRms,
  );

  // In fallback (typed) mode with no captured audio there is nothing to measure,
  // so score the round neutrally. If the microphone did pick up voice we still
  // use it below rather than discarding real signal.
  if (measurements.fallbackMode && !measurements.hadVoice) {
    return {
      score: 50,
      volumeScore: 50,
      pitchScore: 50,
      paceScore: 50,
      wordsPerMinute: 0,
      volumeSnrDb: 0,
      noiseFloorRms: measurements.noiseFloorRms,
    };
  }

  // Nothing was voiced at all. Saying nothing is not skilled bargaining, so it
  // scores neutral and lands in the hold band. Previously this returned 12,
  // which made "open the microphone and stay silent" the single most effective
  // strategy in the game.
  if (!measurements.hadVoice) {
    return {
      score: 50,
      volumeScore: 0,
      pitchScore: 0,
      paceScore: UNMEASURABLE_PACE_SCORE,
      wordsPerMinute: 0,
      volumeSnrDb,
      noiseFloorRms: measurements.noiseFloorRms,
    };
  }

  const { quiet, loud } = getEffectiveSnrWindow(measurements.sensitivityOffsetDb ?? 0);
  const volumeScore = scoreBetween(volumeSnrDb, quiet, loud);
  const pitchScore = measurements.averagePitch
    ? scoreBetween(
        measurements.averagePitch,
        GAME_CONFIG.audio.lowPitchHz,
        GAME_CONFIG.audio.highPitchHz,
      )
    : UNMEASURABLE_PITCH_SCORE;
  const wordsPerMinute =
    measurements.wordCount > 0 && measurements.durationSeconds > 0
      ? (measurements.wordCount / measurements.durationSeconds) * 60
      : 0;
  // When no words were transcribed, pace cannot be measured. Score it neutrally
  // instead of assuming calm speech, otherwise failing recognition (or the typed
  // fallback) would hand out a discount for free.
  const paceScore = wordsPerMinute
    ? scoreBetween(
        wordsPerMinute,
        GAME_CONFIG.audio.calmPaceWpm,
        GAME_CONFIG.audio.fastPaceWpm,
      )
    : UNMEASURABLE_PACE_SCORE;
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
    volumeSnrDb: Math.round(volumeSnrDb),
    noiseFloorRms: measurements.noiseFloorRms,
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
  if (aggression <= 18) return GAME_CONFIG.priceChanges.veryCalm;
  if (aggression <= 32) return GAME_CONFIG.priceChanges.calm;
  if (aggression <= 46) return GAME_CONFIG.priceChanges.measured;
  // Hold band. Deliberately spans the neutral score of 50 that an unmeasurable
  // round produces, so silence and the typed fallback move the price by nothing.
  if (aggression <= 58) return GAME_CONFIG.priceChanges.neutral;
  if (aggression <= 75) return GAME_CONFIG.priceChanges.aggressive;
  return GAME_CONFIG.priceChanges.extreme;
}

function getOfferAdjustment(currentPrice: number, playerOffer: number | null) {
  if (!playerOffer || playerOffer <= 0) return 0;
  if (playerOffer > currentPrice) return GAME_CONFIG.priceChanges.highOffer;
  if (playerOffer < GAME_CONFIG.fairPrice * 0.75) {
    return GAME_CONFIG.priceChanges.unrealisticOffer;
  }

  // Every in-range offer now moves the price. Previously offers between the
  // "unrealistic" floor and a 12% discount produced no adjustment at all,
  // which made the offer input feel inert.
  const discountRequested = (currentPrice - playerOffer) / currentPrice;
  if (discountRequested <= 0.12) return GAME_CONFIG.priceChanges.reasonableOffer;
  if (discountRequested <= 0.3) return GAME_CONFIG.priceChanges.moderateOffer;
  return GAME_CONFIG.priceChanges.steepOffer;
}

/**
 * Deterministic Malayalam seller lines, used both as the offline round result and
 * as the API route's fallback when Sarvam dialogue generation is unavailable.
 */
export const SELLER_FALLBACK_RESPONSES: Record<SellerMood, string[]> = {
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
  const reactionOptions = SELLER_FALLBACK_RESPONSES[sellerMood];

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
