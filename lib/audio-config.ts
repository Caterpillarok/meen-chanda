import { type SellerMood } from "./negotiation";

export type AudioCategory =
  | "calm"
  | "irritated"
  | "angry"
  | "low-offer"
  | "great-deal";

export type SellerAudioClip = {
  id: string;
  category: AudioCategory;
  filename: string;
  path: string;
  text: string;
};

/**
 * Expected recordings in public/audio/
 * Add, remove, or edit filenames and their corresponding subtitles/text here.
 */
export const SELLER_AUDIO_RECORDINGS: Record<AudioCategory, SellerAudioClip[]> = {
  calm: [
    {
      id: "calm_1",
      category: "calm",
      filename: "calm_1.mp3",
      path: "/audio/calm/calm_1.mp3",
      text: "Chetta, that peaceful voice is making me generous.",
    },
    {
      id: "calm_2",
      category: "calm",
      filename: "calm_2.mp3",
      path: "/audio/calm/calm_2.mp3",
      text: "Ayala likes polite customers. I can move a little.",
    },
    {
      id: "calm_3",
      category: "calm",
      filename: "calm_3.mp3",
      path: "/audio/calm/calm_3.mp3",
      text: "Soft voice, soft price. You understand business.",
    },
  ],
  irritated: [
    {
      id: "irritated_1",
      category: "irritated",
      filename: "irritated_1.mp3",
      path: "/audio/irritated/irritated_1.mp3",
      text: "You want a discount and you sound like a cricket commentator?",
    },
    {
      id: "irritated_2",
      category: "irritated",
      filename: "irritated_2.mp3",
      path: "/audio/irritated/irritated_2.mp3",
      text: "Why are you shouting at the Ayala?",
    },
    {
      id: "irritated_3",
      category: "irritated",
      filename: "irritated_3.mp3",
      path: "/audio/irritated/irritated_3.mp3",
      text: "Chetta, calm down. It is only a fish.",
    },
  ],
  angry: [
    {
      id: "angry_1",
      category: "angry",
      filename: "angry_1.mp3",
      path: "/audio/angry/angry_1.mp3",
      text: "At this rate, the fish is becoming more expensive than you.",
    },
    {
      id: "angry_2",
      category: "angry",
      filename: "angry_2.mp3",
      path: "/audio/angry/angry_2.mp3",
      text: "You called the fish small? Now you have offended me.",
    },
    {
      id: "angry_3",
      category: "angry",
      filename: "angry_3.mp3",
      path: "/audio/angry/angry_3.mp3",
      text: "This is not bargaining. This is a weather warning!",
    },
  ],
  "low-offer": [
    {
      id: "low_offer_1",
      category: "low-offer",
      filename: "low_offer_1.mp3",
      path: "/audio/low-offer/low_offer_1.mp3",
      text: "At that price, go catch it yourself from the Arabian Sea!",
    },
    {
      id: "low_offer_2",
      category: "low-offer",
      filename: "low_offer_2.mp3",
      path: "/audio/low-offer/low_offer_2.mp3",
      text: "What is this robbery? Even the cat pays more than that!",
    },
    {
      id: "low_offer_3",
      category: "low-offer",
      filename: "low_offer_3.mp3",
      path: "/audio/low-offer/low_offer_3.mp3",
      text: "Chetta, are you asking for fresh Ayala or asking for charity?",
    },
  ],
  "great-deal": [
    {
      id: "great_deal_1",
      category: "great-deal",
      filename: "great_deal_1.mp3",
      path: "/audio/great-deal/great_deal_1.mp3",
      text: "Take it, chetta! Fresh Ayala is yours today.",
    },
    {
      id: "great_deal_2",
      category: "great-deal",
      filename: "great_deal_2.mp3",
      path: "/audio/great-deal/great_deal_2.mp3",
      text: "Done deal! You bargained like a true Kozhikode local.",
    },
    {
      id: "great_deal_3",
      category: "great-deal",
      filename: "great_deal_3.mp3",
      path: "/audio/great-deal/great_deal_3.mp3",
      text: "Packed and ready! Come back tomorrow for fresh catch.",
    },
  ],
};

/**
 * Categorizes the negotiation situation based on the settled round results.
 * This runs after the deterministic price engine has finished.
 */
export function determineSituation({
  sellerMood,
  playerOffer,
  priceAfter,
  fairPrice,
}: {
  sellerMood: SellerMood;
  playerOffer: number | null;
  priceAfter: number;
  fairPrice: number;
}): AudioCategory {
  // Low-offer detection: player offered an unrealistic price (<75% fair price)
  if (playerOffer !== null && playerOffer > 0 && playerOffer < fairPrice * 0.75) {
    return "low-offer";
  }

  // Great-deal detection: price reached or dropped below fair price with interested/neutral seller
  if (
    priceAfter <= fairPrice &&
    (sellerMood === "Interested 🙂" || sellerMood === "Neutral 😐")
  ) {
    return "great-deal";
  }

  // Mood-based mappings
  if (sellerMood === "Personally Offended 🤬") {
    return "angry";
  }

  if (sellerMood === "Irritated 😠" || sellerMood === "Smug 😏") {
    return "irritated";
  }

  return "calm";
}

/**
 * Selects a random audio clip from the chosen category.
 * Prevents immediate back-to-back repetitions when more than 1 clip exists.
 */
export function selectRandomClip(
  category: AudioCategory,
  previousClipId?: string,
): SellerAudioClip {
  const clips = SELLER_AUDIO_RECORDINGS[category];
  if (!clips || clips.length === 0) {
    return {
      id: `${category}_fallback`,
      category,
      filename: `${category}_1.mp3`,
      path: `/audio/${category}/${category}_1.mp3`,
      text: "Fresh Ayala! Bargain respectfully and we can talk price.",
    };
  }

  if (clips.length === 1) return clips[0];

  const pool = previousClipId
    ? clips.filter((clip) => clip.id !== previousClipId)
    : clips;
  const selectionPool = pool.length > 0 ? pool : clips;
  const randomIndex = Math.floor(Math.random() * selectionPool.length);
  return selectionPool[randomIndex];
}
