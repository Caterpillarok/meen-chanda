"use client";

import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import {
  calculateAggression,
  estimateNoiseFloorRms,
  GAME_CONFIG,
  getCalibrationOffsetDb,
  getEffectiveSnrWindow,
  getFinalTitle,
  getVolumeMeterPercent,
  getVolumeSnrDb,
  MAX_SENSITIVITY_OFFSET_DB,
  MIN_SENSITIVITY_OFFSET_DB,
  type AggressionResult,
  type AudioMeasurements,
  type SellerMood,
  settleRound,
} from "@/lib/negotiation";

/** Persisted so a venue only has to be dialled in once. */
const SENSITIVITY_STORAGE_KEY = "meen-chanda:sensitivity-offset-db";

/**
 * The sensitivity setting lives in localStorage, which is external to React, so it
 * is exposed through a small store and read with useSyncExternalStore. That keeps
 * server and client markup consistent on first paint without setting state from an
 * effect, and lets the animation-frame loop read the current value directly.
 */
let sensitivityValue: number | null = null;
const sensitivityListeners = new Set<() => void>();

function boundSensitivity(value: number) {
  if (!Number.isFinite(value)) return 0;
  return Math.min(
    MAX_SENSITIVITY_OFFSET_DB,
    Math.max(MIN_SENSITIVITY_OFFSET_DB, Math.round(value)),
  );
}

function getSensitivity() {
  if (sensitivityValue === null) {
    try {
      const saved = window.localStorage.getItem(SENSITIVITY_STORAGE_KEY);
      sensitivityValue = saved === null ? 0 : boundSensitivity(Number(saved));
    } catch {
      // Private browsing or blocked storage: use the default window.
      sensitivityValue = 0;
    }
  }
  return sensitivityValue;
}

/** The server has no microphone and no storage, so it always renders the default. */
function getServerSensitivity() {
  return 0;
}

function subscribeSensitivity(onChange: () => void) {
  sensitivityListeners.add(onChange);
  return () => sensitivityListeners.delete(onChange);
}

function writeSensitivity(value: number) {
  sensitivityValue = boundSensitivity(value);
  try {
    window.localStorage.setItem(SENSITIVITY_STORAGE_KEY, String(sensitivityValue));
  } catch {
    // Persistence is a convenience; the session still works without it.
  }
  sensitivityListeners.forEach((listener) => listener());
  return sensitivityValue;
}

type SpeechRecognitionAlternativeLike = { transcript: string };
type SpeechRecognitionResultLike = {
  0: SpeechRecognitionAlternativeLike;
  isFinal: boolean;
};
type SpeechRecognitionEventLike = {
  resultIndex: number;
  results: ArrayLike<SpeechRecognitionResultLike>;
};
type SpeechRecognitionLike = {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  onstart: (() => void) | null;
  onresult: ((event: SpeechRecognitionEventLike) => void) | null;
  onerror: ((event: { error: string }) => void) | null;
  onend: (() => void) | null;
  start: () => void;
  stop: () => void;
  abort: () => void;
};
type SpeechRecognitionConstructor = new () => SpeechRecognitionLike;

/**
 * Cheap absolute gate for the autocorrelation pass only — it exists to avoid
 * running an expensive pitch search over digital silence, not to decide what
 * counts as the player's voice. That decision is made at settle time, relative
 * to the measured noise floor, because absolute RMS depends on microphone gain.
 */
const PITCH_DETECTION_MIN_RMS = 0.001;
/**
 * Upper bound on how much time a single analysis frame may contribute to the
 * measured speaking duration. Frames normally arrive every ~16ms; a much larger
 * gap means the tab was throttled rather than that the player spoke for that long.
 */
const MAX_FRAME_DELTA_MS = 100;
/** Below this much voiced audio, pace is treated as unmeasurable. */
const MINIMUM_VOICED_SECONDS_FOR_PACE = 0.4;
/** Bounds memory for a very long round (~60fps, so this is roughly two minutes). */
const MAX_ANALYSIS_FRAMES = 8000;
/**
 * Below this, a frame is treated as a dropout rather than as quiet room noise.
 * The AudioContext emits digital silence while it spins up, and letting those
 * frames into the estimate is what dragged the floor to its clamp and pinned the
 * first round at full loudness. Real rooms sit well above this once a mic is live.
 */
const NEAR_SILENCE_RMS = 0.00001;
/**
 * The background level is estimated as a low percentile of the most recent few
 * seconds of audio. This shape of estimator is deliberate, because the two obvious
 * alternatives each fail in an opposite direction:
 *
 *  - A running MINIMUM is captured permanently by a single low outlier (a startup
 *    ramp or buffer glitch), leaving the floor far below the real background so
 *    that even silence reads as loud.
 *  - A percentile over the WHOLE round drifts upward as speech accumulates, until
 *    the "background" is the player's own voice and the meter decays to nothing.
 *
 * A percentile ignores outliers, and bounding it to a recent window stops it
 * drifting, so it can both rise and fall to follow the room.
 */
const FLOOR_WINDOW_FRAMES = 180;
/** Samples required before any reading is reported (~0.5s at 60fps). */
const MIN_FLOOR_SAMPLES = 30;
/**
 * Where the loudest voice heard so far should land on the meter. The window is
 * auto-ranged so that peak maps here, which makes the meter monotonic in loudness
 * no matter how the room or the microphone behaves: speaking up always reads
 * higher, easing off always reads lower. It also self-corrects a floor estimate
 * that came out too low, which previously saturated the meter at every level.
 */
const AUTO_RANGE_TARGET_DB = 41;
/** Smoothing for the live meter so it tracks speech rather than flickering per frame. */
const LIVE_METER_SMOOTHING = 0.55;
/** Safety cap so a permanently failing recogniser cannot restart in a tight loop. */
const MAX_RECOGNITION_RESTARTS = 10;
/**
 * Recognition errors that are part of normal operation rather than failures.
 * "aborted" fires whenever the app itself stops the recogniser (settling a round
 * or discarding a take) and "no-speech" simply means the player paused.
 */
const BENIGN_RECOGNITION_ERRORS = new Set(["aborted", "no-speech"]);

type AnalysisFrame = { rms: number; pitch: number; deltaMs: number };

function detectPitch(samples: Float32Array, sampleRate: number) {
  let rms = 0;
  for (const sample of samples) rms += sample * sample;
  rms = Math.sqrt(rms / samples.length);
  if (rms < PITCH_DETECTION_MIN_RMS) return 0;

  const minLag = Math.floor(sampleRate / 350);
  const maxLag = Math.floor(sampleRate / 85);
  let bestCorrelation = 0;
  let bestLag = 0;

  for (let lag = minLag; lag <= maxLag; lag += 1) {
    let correlation = 0;
    let firstEnergy = 0;
    let secondEnergy = 0;
    for (let index = 0; index < samples.length - lag; index += 1) {
      const firstSample = samples[index];
      const secondSample = samples[index + lag];
      correlation += firstSample * secondSample;
      firstEnergy += firstSample * firstSample;
      secondEnergy += secondSample * secondSample;
    }
    const normalizedCorrelation = correlation / Math.sqrt(firstEnergy * secondEnergy);
    if (normalizedCorrelation > bestCorrelation) {
      bestCorrelation = normalizedCorrelation;
      bestLag = lag;
    }
  }

  return bestLag ? sampleRate / bestLag : 0;
}

function getRecognitionConstructor() {
  const speechWindow = window as Window & {
    SpeechRecognition?: SpeechRecognitionConstructor;
    webkitSpeechRecognition?: SpeechRecognitionConstructor;
  };
  return speechWindow.SpeechRecognition ?? speechWindow.webkitSpeechRecognition;
}

type HistoryItem = {
  playerSpeech: string;
  aggression: number;
  priceBefore: number;
  priceAfter: number;
  sellerMood: SellerMood;
  sellerResponse: string;
};

const initialAggression: AggressionResult = {
  score: 0,
  volumeScore: 0,
  pitchScore: 0,
  paceScore: 0,
  wordsPerMinute: 0,
  volumeSnrDb: 0,
  noiseFloorRms: 0,
};

type RecognitionStatus =
  | "checking"
  | "ready"
  | "listening"
  | "ended"
  | "unavailable"
  | "error";

/**
 * Plain-language reading of the live meter. The whole point of the game is that
 * players instinctively get louder to bargain harder, so the tone is named and
 * its price consequence spelled out while they are still speaking.
 */
const TONE_BANDS = [
  { limit: 25, label: "Calm", hint: "Seller is warming up — price falling", tone: "is-calm" },
  { limit: 55, label: "Measured", hint: "Steady. Soften further to push the price down", tone: "is-measured" },
  { limit: 80, label: "Raised", hint: "Seller is bristling — price about to climb", tone: "is-raised" },
  { limit: Infinity, label: "Shouting", hint: "Ayala is getting expensive!", tone: "is-shouting" },
] as const;

function getToneBand(meterPercent: number) {
  return TONE_BANDS.find((band) => meterPercent < band.limit) ?? TONE_BANDS[3];
}

export default function GameClient() {
  const [round, setRound] = useState(1);
  const [currentPrice, setCurrentPrice] = useState<number>(GAME_CONFIG.startingPrice);
  const [offer, setOffer] = useState("");
  const [recognisedTranscript, setRecognisedTranscript] = useState("");
  const [interimTranscript, setInterimTranscript] = useState("");
  const [typedTranscript, setTypedTranscript] = useState("");
  const [isListening, setIsListening] = useState(false);
  const [isPlaying, setIsPlaying] = useState(false);
  const [isGeneratingResponse, setIsGeneratingResponse] = useState(false);
  const [audioStatus, setAudioStatus] = useState<{
    type: "playing" | "missing" | "generating";
    message: string;
  } | null>(null);
  const [microphoneMessage, setMicrophoneMessage] = useState(
    "Press the microphone and bargain out loud.",
  );
  const [recognitionMessage, setRecognitionMessage] = useState("");
  const [recognitionStatus, setRecognitionStatus] =
    useState<RecognitionStatus>("checking");
  // The typed input is a fallback, not a primary control, so it stays hidden
  // until recognition actually fails or the player asks for it.
  const [showTypedFallback, setShowTypedFallback] = useState(false);
  /**
   * Shifts the loudness window to match the room and microphone. Absolute dB
   * thresholds cannot be right for every setup, so this is adjustable at runtime
   * and persisted, which means a venue can be dialled in once before a demo.
   */
  const sensitivityOffsetDb = useSyncExternalStore(
    subscribeSensitivity,
    getSensitivity,
    getServerSensitivity,
  );
  const [calibrationMessage, setCalibrationMessage] = useState("");
  const [liveVolume, setLiveVolume] = useState(0);
  const [liveSnrDb, setLiveSnrDb] = useState(0);
  const [liveNoiseFloor, setLiveNoiseFloor] = useState(0);
  const [livePitch, setLivePitch] = useState(0);
  const [aggression, setAggression] = useState(initialAggression);
  const [sellerMood, setSellerMood] = useState<SellerMood>("Neutral 😐");
  const [sellerResponse, setSellerResponse] = useState(
    "കട്ട ഫ്രഷ് അയല! മാന്യമായി സംസാരിച്ചാൽ വില കുറച്ചു തരാം.",
  );
  const [priceChange, setPriceChange] = useState(0);
  const [history, setHistory] = useState<HistoryItem[]>([]);
  // Held as state, not a ref: the Replay buttons derive their disabled state
  // from it during render, so a change must trigger a re-render.
  const [currentAudioUrl, setCurrentAudioUrl] = useState<string | null>(null);

  const streamRef = useRef<MediaStream | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const animationFrameRef = useRef<number | null>(null);
  const recognitionRef = useRef<SpeechRecognitionLike | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const isStoppingRecognitionRef = useRef(false);
  const recognitionFailedRef = useRef(false);
  /**
   * Chrome ends a continuous recognition session on its own after a pause, so the
   * session is restarted transparently. Transcript text is carried across those
   * restarts because each new session reports results from index 0.
   */
  const recognitionRestartsRef = useRef(0);
  const committedTranscriptRef = useRef("");
  const sessionFinalTranscriptRef = useRef("");
  const isSettlingRef = useRef(false);
  /**
   * Loudest voice heard so far this game, in dB above the background. Persists
   * across rounds so the meter's range keeps widening rather than resetting.
   */
  const peakDbRef = useRef(0);

  /**
   * Sensitivity actually applied: the player's own setting plus however much the
   * window must shift so their loudest voice reaches the top of the meter. Used
   * for both the live meter and the round score so the two always agree.
   */
  function getEffectiveOffsetDb() {
    return getSensitivity() + Math.max(0, peakDbRef.current - AUTO_RANGE_TARGET_DB);
  }
  const analysisRef = useRef<{
    frames: AnalysisFrame[];
    lastUiUpdate: number;
    lastFrameAt: number;
    captureStartedAt: number;
    /** Recent frame loudness, newest last, capped to FLOOR_WINDOW_FRAMES. */
    recentRms: number[];
    /** Live estimate of the background level, or null until enough samples exist. */
    noiseFloor: number | null;
    /** Quietest background level seen all round; the value the round is scored on. */
    scoringFloor: number | null;
    smoothedRms: number;
  }>({
    frames: [],
    lastUiUpdate: 0,
    lastFrameAt: 0,
    captureStartedAt: 0,
    recentRms: [],
    noiseFloor: null,
    scoringFloor: null,
    smoothedRms: 0,
  });

  function applySensitivity(offsetDb: number, message = "") {
    writeSensitivity(offsetDb);
    setCalibrationMessage(message);
  }

  /**
   * Anchors the loudness window to the voice being used right now. The player
   * speaks normally, presses this, and their current level becomes "measured".
   */
  function calibrateToCurrentVoice() {
    if (!liveSnrDb) {
      setCalibrationMessage("Speak first, then calibrate — no loudness measured yet.");
      return;
    }
    const offset = getCalibrationOffsetDb(liveSnrDb);
    applySensitivity(
      offset,
      `Calibrated: ${liveSnrDb} dB is now your normal speaking voice.`,
    );
  }

  function stopAudio() {
    if (audioRef.current) {
      audioRef.current.pause();
      audioRef.current.currentTime = 0;
      audioRef.current.onplay = null;
      audioRef.current.onended = null;
      audioRef.current.onerror = null;
    }
    setIsPlaying(false);
  }

  function playAudioUrl(url: string, statusMessage = "Playing Sarvam Malayalam voice") {
    stopAudio();

    if (typeof window === "undefined" || !url) return;

    try {
      const audio = new Audio(url);
      audioRef.current = audio;

      audio.onplay = () => {
        setIsPlaying(true);
        setAudioStatus({
          type: "playing",
          message: statusMessage,
        });
      };

      audio.onended = () => {
        setIsPlaying(false);
        setAudioStatus(null);
      };

      audio.onerror = () => {
        setIsPlaying(false);
        setAudioStatus({
          type: "missing",
          message: "Sarvam audio playback encountered an issue.",
        });
      };

      const playPromise = audio.play();
      if (playPromise !== undefined) {
        playPromise.catch((error: unknown) => {
          setIsPlaying(false);
          if (error instanceof DOMException && error.name === "AbortError") {
            return;
          }
          // The reply is fetched before it can be played, which breaks the user
          // gesture chain, so some browsers refuse to start playback. Say so and
          // point at Replay, which runs inside a fresh click.
          if (error instanceof DOMException && error.name === "NotAllowedError") {
            setAudioStatus({
              type: "missing",
              message: "Browser blocked autoplay — press Replay to hear the seller.",
            });
            return;
          }
          setAudioStatus(null);
        });
      }
    } catch {
      setIsPlaying(false);
      setAudioStatus(null);
    }
  }

  function replayCurrentAudio() {
    if (currentAudioUrl) {
      playAudioUrl(currentAudioUrl, "Playing Sarvam Malayalam voice");
    }
  }

  useEffect(() => {
    return () => {
      stopAudio();
      if (animationFrameRef.current) cancelAnimationFrame(animationFrameRef.current);
      recognitionRef.current?.abort();
      streamRef.current?.getTracks().forEach((track) => track.stop());
      void audioContextRef.current?.close();
    };
  }, []);

  function stopCapture() {
    if (animationFrameRef.current) cancelAnimationFrame(animationFrameRef.current);
    animationFrameRef.current = null;
    isStoppingRecognitionRef.current = true;
    recognitionRef.current?.abort();
    recognitionRef.current = null;
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
    if (audioContextRef.current) void audioContextRef.current.close();
    audioContextRef.current = null;
    setIsListening(false);
    if (getRecognitionConstructor()) setRecognitionStatus("ready");
  }

  /**
   * Abandons the current recording without scoring it. Previously the only way
   * out of listening mode was to settle, so a misfired start or a coughing fit
   * had to be committed to the price.
   */
  function cancelListening() {
    stopCapture();
    setRecognisedTranscript("");
    setInterimTranscript("");
    setLiveVolume(0);
    setLiveSnrDb(0);
    setLiveNoiseFloor(0);
    setLivePitch(0);
    setRecognitionMessage("");
    setMicrophoneMessage("Recording discarded. Start again when you are ready.");
  }

  async function startListening() {
    stopAudio();
    setMicrophoneMessage("Requesting microphone access…");
    setRecognitionMessage("");
    setRecognisedTranscript("");
    setInterimTranscript("");
    setTypedTranscript("");
    setLiveVolume(0);
    setLiveSnrDb(0);
    setLiveNoiseFloor(0);
    setLivePitch(0);
    isStoppingRecognitionRef.current = false;
    recognitionFailedRef.current = false;
    recognitionRestartsRef.current = 0;
    committedTranscriptRef.current = "";
    sessionFinalTranscriptRef.current = "";
    analysisRef.current = {
      frames: [],
      lastUiUpdate: 0,
      lastFrameAt: 0,
      // Set properly once the stream is live. Timing spin-up from here would be
      // wrong: the microphone permission prompt alone outlasts the skip window.
      captureStartedAt: 0,
      recentRms: [],
      noiseFloor: null,
      scoringFloor: null,
      smoothedRms: 0,
    };

    try {
      // autoGainControl must be off: it normalises the input level, so shouting
      // and speaking softly would arrive at the analyser at nearly the same RMS.
      // noiseSuppression must also be off: it gates near-silence down towards
      // zero, which would destroy the noise floor that the SNR measurement is
      // taken against. echoCancellation stays on so the seller's own TTS reply
      // playing through the speakers is not measured as the player's voice.
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          autoGainControl: false,
          noiseSuppression: false,
          echoCancellation: true,
        },
      });
      const audioContext = new AudioContext();
      const source = audioContext.createMediaStreamSource(stream);
      const analyser = audioContext.createAnalyser();
      analyser.fftSize = 2048;
      source.connect(analyser);
      await audioContext.resume();
      streamRef.current = stream;
      audioContextRef.current = audioContext;
      // Spin-up is measured from the moment audio can actually flow. On the first
      // round the permission prompt can take seconds, and timing from the button
      // press meant the skip window expired before a single frame arrived — so the
      // AudioContext's startup silence was counted as room noise, collapsing the
      // noise floor and pinning the first round at full loudness.
      analysisRef.current.captureStartedAt = Date.now();
      setIsListening(true);
      setMicrophoneMessage("Listening… speak normally, then settle this round.");

      const timeDomainData = new Float32Array(analyser.fftSize);
      const readAudio = () => {
        analyser.getFloatTimeDomainData(timeDomainData);
        let squareSum = 0;
        for (const sample of timeDomainData) squareSum += sample * sample;
        const rms = Math.sqrt(squareSum / timeDomainData.length);
        const pitch = detectPitch(timeDomainData, audioContext.sampleRate);

        // Measure elapsed time per frame so pace reflects actual speaking time,
        // not the wall-clock time since the microphone was opened.
        const now = Date.now();
        const previousFrameAt = analysisRef.current.lastFrameAt;
        analysisRef.current.lastFrameAt = now;
        // Clamp the delta so a backgrounded tab or a stalled frame cannot
        // inflate the measured speaking duration.
        const frameDeltaMs = previousFrameAt
          ? Math.min(now - previousFrameAt, MAX_FRAME_DELTA_MS)
          : 0;

        if (analysisRef.current.frames.length < MAX_ANALYSIS_FRAMES) {
          analysisRef.current.frames.push({ rms, pitch, deltaMs: frameDeltaMs });
        }

        // Feed the sliding window used to estimate the background level. Digital
        // silence is a dropout, not room noise, so it never enters the sample.
        const analysis = analysisRef.current;
        if (rms > NEAR_SILENCE_RMS) {
          analysis.recentRms.push(rms);
          if (analysis.recentRms.length > FLOOR_WINDOW_FRAMES) {
            analysis.recentRms.shift();
          }
        }

        analysisRef.current.smoothedRms =
          analysisRef.current.smoothedRms * LIVE_METER_SMOOTHING +
          rms * (1 - LIVE_METER_SMOOTHING);

        if (Date.now() - analysisRef.current.lastUiUpdate > 120) {
          // Recompute the background level from the recent window. estimateNoiseFloorRms
          // is the same percentile helper the round is scored with, so the meter and
          // the score can never disagree about what the room sounds like.
          if (analysis.recentRms.length >= MIN_FLOOR_SAMPLES) {
            analysis.noiseFloor = estimateNoiseFloorRms(analysis.recentRms);
            if (
              analysis.scoringFloor === null ||
              analysis.noiseFloor < analysis.scoringFloor
            ) {
              analysis.scoringFloor = analysis.noiseFloor;
            }
          }
          const establishedFloor = analysis.noiseFloor;
          const liveSnrDb =
            establishedFloor === null
              ? 0
              : getVolumeSnrDb(analysisRef.current.smoothedRms, establishedFloor);
          // Widen the range to the loudest voice heard so far, so the meter always
          // spans this player's actual range instead of a guessed dB window.
          if (liveSnrDb > peakDbRef.current) peakDbRef.current = liveSnrDb;
          setLiveVolume(
            establishedFloor === null
              ? 0
              : getVolumeMeterPercent(liveSnrDb, getEffectiveOffsetDb()),
          );
          setLivePitch(Math.round(pitch));
          setLiveSnrDb(Math.round(liveSnrDb));
          setLiveNoiseFloor(establishedFloor ?? 0);
          analysisRef.current.lastUiUpdate = Date.now();
        }
        animationFrameRef.current = requestAnimationFrame(readAudio);
      };
      readAudio();

      const Recognition = getRecognitionConstructor();
      if (!Recognition) {
        setRecognitionStatus("unavailable");
        setRecognitionMessage(
          "Malayalam speech recognition is unavailable here. Type your bargain below; microphone analysis still works.",
        );
        return;
      }

      const beginRecognition = () => {
        const recognition = new Recognition();
        recognition.lang = "ml-IN";
        recognition.continuous = true;
        recognition.interimResults = true;
        recognition.onstart = () => {
          setRecognitionStatus("listening");
          setRecognitionMessage("Listening for Malayalam speech (ml-IN)…");
        };
        recognition.onresult = (event) => {
          let finalText = "";
          let interimText = "";
          for (let index = 0; index < event.results.length; index += 1) {
            const result = event.results[index];
            if (result.isFinal) {
              finalText += `${result[0].transcript} `;
            } else {
              interimText += `${result[0].transcript} `;
            }
          }
          // Each recognition session numbers its results from zero, so the text
          // finalised by earlier sessions is kept separately and prepended.
          sessionFinalTranscriptRef.current = finalText.trim();
          setRecognisedTranscript(
            [committedTranscriptRef.current, sessionFinalTranscriptRef.current]
              .filter(Boolean)
              .join(" "),
          );
          setInterimTranscript(interimText.trim());
        };
        recognition.onerror = (event) => {
          // Do not surface an error for events that are part of normal operation.
          // Reporting "aborted" as a failure was especially misleading, because the
          // app aborts the recogniser itself every time a round is settled or a
          // take is discarded.
          if (BENIGN_RECOGNITION_ERRORS.has(event.error)) {
            if (event.error === "no-speech") {
              setRecognitionMessage(
                "No Malayalam words picked up yet — keep bargaining, your tone is still being measured.",
              );
            }
            return;
          }
          recognitionFailedRef.current = true;
          setRecognitionStatus("error");
          setInterimTranscript("");
          setRecognitionMessage(
            `Malayalam recognition could not continue (${event.error}). Audio analysis is still listening; type your bargain if needed.`,
          );
        };
        recognition.onend = () => {
          recognitionRef.current = null;
          if (isStoppingRecognitionRef.current || recognitionFailedRef.current) return;

          // Carry finalised text forward, then transparently resume. Chrome stops a
          // continuous session by itself after a pause, which previously ended
          // recognition for the rest of the round.
          committedTranscriptRef.current = [
            committedTranscriptRef.current,
            sessionFinalTranscriptRef.current,
          ]
            .filter(Boolean)
            .join(" ");
          sessionFinalTranscriptRef.current = "";

          if (recognitionRestartsRef.current >= MAX_RECOGNITION_RESTARTS) {
            setRecognitionStatus("ended");
            setInterimTranscript("");
            setRecognitionMessage(
              "Malayalam recognition stopped. Audio analysis is still listening; type your bargain or settle the round.",
            );
            return;
          }
          recognitionRestartsRef.current += 1;
          beginRecognition();
        };
        recognitionRef.current = recognition;
        try {
          recognition.start();
        } catch {
          recognitionFailedRef.current = true;
          setRecognitionStatus("error");
          setRecognitionMessage(
            "Malayalam recognition could not start. Audio analysis is still listening; type your bargain instead.",
          );
        }
      };

      beginRecognition();
    } catch (error) {
      const message =
        error instanceof DOMException && error.name === "NotAllowedError"
          ? "Microphone permission was denied. You can still play with the typed fallback."
          : "A microphone is not available in this browser. You can still play with the typed fallback.";
      setMicrophoneMessage(message);
      setRecognitionStatus("error");
      setRecognitionMessage("Voice analysis needs a microphone, but typed bargaining remains available.");
      stopCapture();
    }
  }

  async function settleCurrentRound(fallbackMode = false) {
    // Guard against a second settle being kicked off while one is already in
    // flight, which would score the same round twice against a stale price.
    if (isSettlingRef.current) return;
    isSettlingRef.current = true;

    // The noise floor is only knowable once the round is over, so every frame was
    // recorded raw and is reduced here. Deciding what counted as "voice" relative
    // to that floor is what makes the score independent of microphone gain.
    const frames = analysisRef.current.frames;
    // Prefer the quietest background the adaptive detector settled on. The
    // percentile is only a fallback for a round too short to seed the estimate.
    const noiseFloorRms =
      analysisRef.current.scoringFloor ??
      estimateNoiseFloorRms(frames.map((frame) => frame.rms));
    const voiceGate = Math.max(
      noiseFloorRms * GAME_CONFIG.audio.voiceGateRatio,
      GAME_CONFIG.audio.silenceRms,
    );
    const voicedFrames = frames.filter((frame) => frame.rms >= voiceGate);
    const pitchedFrames = voicedFrames.filter((frame) => frame.pitch > 0);
    const voicedMs = voicedFrames.reduce((total, frame) => total + frame.deltaMs, 0);

    // Only count time where the player was actually voicing, so a long silent
    // pause before settling cannot make fast speech look calm.
    const voicedSeconds = voicedMs / 1000;
    const durationSeconds =
      voicedSeconds >= MINIMUM_VOICED_SECONDS_FOR_PACE ? voicedSeconds : 0;
    const capturedSpeech = recognisedTranscript.trim() || interimTranscript.trim();
    const playerSpeech = capturedSpeech || typedTranscript.trim() || "No words recognised — voice analysis only.";
    const audio: AudioMeasurements = {
      averageVolume: voicedFrames.length
        ? voicedFrames.reduce((total, frame) => total + frame.rms, 0) /
          voicedFrames.length
        : 0,
      noiseFloorRms,
      sensitivityOffsetDb: getEffectiveOffsetDb(),
      averagePitch: pitchedFrames.length
        ? pitchedFrames.reduce((total, frame) => total + frame.pitch, 0) /
          pitchedFrames.length
        : 0,
      wordCount: capturedSpeech ? capturedSpeech.split(/\s+/).length : 0,
      durationSeconds,
      hadVoice: voicedFrames.length > 0,
      fallbackMode,
    };
    const roundAggression = calculateAggression(audio);
    const playerOffer = Number(offer) > 0 ? Number(offer) : null;
    const result = settleRound({
      currentPrice,
      playerOffer,
      aggression: roundAggression.score,
      round,
    });
    stopCapture();
    stopAudio();
    setAggression(roundAggression);
    setCurrentPrice(result.priceAfter);
    setPriceChange(result.priceChange);
    setSellerMood(result.sellerMood);

    setIsGeneratingResponse(true);
    setSellerResponse("മീൻകാരൻ ചേട്ടൻ ആലോചിക്കുന്നു…");
    setAudioStatus({
      type: "generating",
      message: "Sarvam AI is generating seller response…",
    });

    const roundNumber = round;
    const priceBeforeRound = currentPrice;
    const defaultFallbackText = result.sellerResponse;

    setOffer("");
    setRecognisedTranscript("");
    setInterimTranscript("");
    setTypedTranscript("");

    try {
      const response = await fetch("/api/seller-response", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          round: roundNumber,
          totalRounds: GAME_CONFIG.totalRounds,
          fish: GAME_CONFIG.fish,
          currentPrice: priceBeforeRound,
          priceAfter: result.priceAfter,
          priceChange: result.priceChange,
          fairPrice: GAME_CONFIG.fairPrice,
          startingPrice: GAME_CONFIG.startingPrice,
          playerOffer,
          playerSpeech,
          aggressionScore: roundAggression.score,
          volumeScore: roundAggression.volumeScore,
          pitchScore: roundAggression.pitchScore,
          paceScore: roundAggression.paceScore,
          wordsPerMinute: roundAggression.wordsPerMinute,
          sellerMood: result.sellerMood,
        }),
      });

      const data = await response.json();
      const dialogueText = data?.sellerText || defaultFallbackText;
      setIsGeneratingResponse(false);
      setSellerResponse(dialogueText);

      setHistory((previous) => [
        ...previous,
        {
          playerSpeech,
          aggression: roundAggression.score,
          priceBefore: priceBeforeRound,
          priceAfter: result.priceAfter,
          sellerMood: result.sellerMood,
          sellerResponse: dialogueText,
        },
      ]);

      if (data?.audio) {
        setCurrentAudioUrl(data.audio);
        playAudioUrl(data.audio, "Sarvam Bulbul v3 (ml-IN)");
      } else {
        // Text arrived but speech synthesis did not. Say so explicitly rather
        // than leaving a silently disabled replay button next to a fresh quote.
        setCurrentAudioUrl(null);
        setAudioStatus({
          type: "missing",
          message: "Voice unavailable for this reply — showing text only.",
        });
      }
    } catch {
      setIsGeneratingResponse(false);
      setSellerResponse(defaultFallbackText);
      setCurrentAudioUrl(null);
      setAudioStatus({
        type: "missing",
        message: "Could not reach the seller's voice — showing text only.",
      });
      setHistory((previous) => [
        ...previous,
        {
          playerSpeech,
          aggression: roundAggression.score,
          priceBefore: priceBeforeRound,
          priceAfter: result.priceAfter,
          sellerMood: result.sellerMood,
          sellerResponse: defaultFallbackText,
        },
      ]);
    }

    if (roundNumber < GAME_CONFIG.totalRounds) {
      setRound((previous) => previous + 1);
      setMicrophoneMessage("Round settled. Bargain again when you are ready.");
    } else {
      setMicrophoneMessage("The market has spoken. Your final price is locked.");
    }

    isSettlingRef.current = false;
  }

  function restartGame() {
    stopAudio();
    setCurrentAudioUrl(null);
    isSettlingRef.current = false;
    setIsGeneratingResponse(false);
    setAudioStatus(null);
    stopCapture();
    setRound(1);
    setCurrentPrice(GAME_CONFIG.startingPrice);
    setOffer("");
    setRecognisedTranscript("");
    setInterimTranscript("");
    setTypedTranscript("");
    setShowTypedFallback(false);
    peakDbRef.current = 0;
    setAggression(initialAggression);
    setSellerMood("Neutral 😐");
    setSellerResponse("കട്ട ഫ്രഷ് അയല! മാന്യമായി സംസാരിച്ചാൽ വില കുറച്ചു തരാം.");
    setPriceChange(0);
    setHistory([]);
    setLiveVolume(0);
    setLiveSnrDb(0);
    setLiveNoiseFloor(0);
    setLivePitch(0);
    setMicrophoneMessage("Press the microphone and bargain out loud.");
    setRecognitionMessage("");
    setRecognitionStatus(getRecognitionConstructor() ? "ready" : "unavailable");
  }

  const isFinished = history.length === GAME_CONFIG.totalRounds;
  const toneBand = getToneBand(liveVolume);
  const isRoomMeasured = liveNoiseFloor > 0;
  const effectiveWindow = getEffectiveSnrWindow(sensitivityOffsetDb);
  // Reveal the typed input automatically the moment speech recognition cannot
  // carry the round, so the player is never left without a way to answer.
  const typedFallbackVisible =
    showTypedFallback ||
    recognitionStatus === "unavailable" ||
    recognitionStatus === "error" ||
    recognitionStatus === "ended";
  const averageAggression = history.length
    ? Math.round(history.reduce((total, item) => total + item.aggression, 0) / history.length)
    : 0;
  const savingsFromStart = GAME_CONFIG.startingPrice - currentPrice;
  const fairPriceDifference = currentPrice - GAME_CONFIG.fairPrice;

  if (isFinished) {
    return (
      <main className="market-shell">
        <section className="result-card" aria-live="polite">
          <p className="eyebrow">THE MARKET HAS DECIDED</p>
          <div className="fish-icon" aria-hidden="true">🐟</div>
          <h1>{getFinalTitle(currentPrice, averageAggression)}</h1>
          <p className="result-quote">&ldquo;{sellerResponse}&rdquo;</p>
          <div className="result-speech-controls">
            <button
              type="button"
              className="replay-button"
              onClick={replayCurrentAudio}
              aria-label="Replay final seller response"
              disabled={!currentAudioUrl || isGeneratingResponse}
            >
              <span>🔊</span> Replay response
            </button>
            {isGeneratingResponse && (
              <span className="speaking-indicator" style={{ background: "#8c5b1b" }}>
                ⏳ ആലോചിക്കുന്നു…
              </span>
            )}
            {isPlaying && (
              <span className="speaking-indicator" aria-live="polite">
                <span className="sound-bars" aria-hidden="true">
                  <span />
                  <span />
                  <span />
                </span>
                Speaking…
              </span>
            )}
          </div>
          {audioStatus && (
            <p
              className={`status-message ${audioStatus.type === "missing" ? "fallback-message" : ""}`}
              role="status"
              style={{ textAlign: "center", margin: "-6px 0 14px" }}
            >
              {audioStatus.type === "missing" ? "⚠️ " : "🔊 "}
              {audioStatus.message}
            </p>
          )}
          <div className="final-price">₹{currentPrice}</div>
          <div className="results-grid">
            <div><span>Starting price</span><strong>₹{GAME_CONFIG.startingPrice}</strong></div>
            <div><span>Fair price</span><strong>₹{GAME_CONFIG.fairPrice}</strong></div>
            <div><span>{savingsFromStart >= 0 ? "You saved" : "You lost"}</span><strong>₹{Math.abs(savingsFromStart)}</strong></div>
            <div><span>Vs fair price</span><strong>{fairPriceDifference > 0 ? `+₹${fairPriceDifference}` : `₹${Math.abs(fairPriceDifference)} below`}</strong></div>
            <div><span>Average aggression</span><strong>{averageAggression}/100</strong></div>
          </div>
          <div className="round-recap">
            {history.map((item, index) => (
              <div key={`${item.priceAfter}-${index}`}>
                <span>R{index + 1}</span><strong>{item.aggression}/100</strong><span>₹{item.priceAfter}</span>
              </div>
            ))}
          </div>
          <button className="primary-button restart-button" onClick={restartGame}>Bargain again ↻</button>
        </section>
      </main>
    );
  }

  return (
    <main className="market-shell">
      <section className="game-card">
        <header className="game-header">
          <div>
            <p className="eyebrow">MEEN CHANDA</p>
            <h1>Fish Market Haggling Simulator</h1>
          </div>
          <div className="round-tracker">
            <div className="round-badge">ROUND {round} / {GAME_CONFIG.totalRounds}</div>
            <ol
              className="round-dots"
              aria-label={`Round ${round} of ${GAME_CONFIG.totalRounds}`}
            >
              {Array.from({ length: GAME_CONFIG.totalRounds }, (_, index) => {
                const roundNumber = index + 1;
                const state =
                  roundNumber < round
                    ? "is-done"
                    : roundNumber === round
                      ? "is-current"
                      : "is-upcoming";
                return (
                  <li key={roundNumber} className={state}>
                    <span className="sr-only">
                      Round {roundNumber}{" "}
                      {state === "is-done"
                        ? "settled"
                        : state === "is-current"
                          ? "in progress"
                          : "not started"}
                    </span>
                  </li>
                );
              })}
            </ol>
          </div>
        </header>
        <div className="joke-banner"><span>🎙️</span> YOUR VOICE AFFECTS THE PRICE</div>

        <section className="seller-area">
          <div
            className={`seller-avatar ${isPlaying ? "is-speaking" : ""}`}
            aria-label="A smiling fish seller"
          >
            🧔🏽‍♂️
          </div>
          <div className="seller-speech">
            <div className="seller-speech-header">
              <p className="mood-label">SELLER IS {sellerMood}</p>
              {isGeneratingResponse && (
                <span className="speaking-indicator" style={{ background: "#8c5b1b" }}>
                  ⏳ ആലോചിക്കുന്നു…
                </span>
              )}
              {isPlaying && (
                <span className="speaking-indicator" aria-live="polite">
                  <span className="sound-bars" aria-hidden="true">
                    <span />
                    <span />
                    <span />
                  </span>
                  Speaking…
                </span>
              )}
            </div>
            <p className="seller-quote">&ldquo;{sellerResponse}&rdquo;</p>
            <div className="seller-speech-footer">
              <button
                type="button"
                className="replay-button"
                onClick={replayCurrentAudio}
                aria-label="Replay seller response"
                title="Hear seller response again"
                disabled={!currentAudioUrl || isGeneratingResponse}
              >
                <span>🔊</span> Replay
              </button>
              {audioStatus && (
                <span
                  className={`audio-status ${audioStatus.type === "missing" ? "is-missing" : "is-playing"}`}
                  role="status"
                  title={audioStatus.message}
                >
                  {audioStatus.type === "missing" ? "⚠️ " : "🔊 "}
                  {audioStatus.message}
                </span>
              )}
            </div>
          </div>
          <div className="fish-label"><span>🐟</span><strong>{GAME_CONFIG.fish}</strong><small>Fresh catch</small></div>
        </section>

        <section className="price-panel" aria-live="polite">
          <div>
            <span>Current price</span>
            {/* Keyed on the price so the highlight animation replays on every change. */}
            <strong key={currentPrice} className="price-current">₹{currentPrice}</strong>
          </div>
          <div><span>Fair price</span><strong>₹{GAME_CONFIG.fairPrice}</strong></div>
          <div className={priceChange > 0 ? "price-up" : priceChange < 0 ? "price-down" : "price-still"}>
            <span>Last change</span><strong>{priceChange === 0 ? "—" : `${priceChange > 0 ? "↑" : "↓"} ₹${Math.abs(priceChange)}`}</strong>
          </div>
        </section>

        <section className="bargain-area">
          <div className="section-heading"><span>1</span><div><h2>Make your offer</h2><p>Optional, but reasonable offers help.</p></div></div>
          <label className="offer-input"><span>₹</span><input inputMode="numeric" type="number" min="1" value={offer} onChange={(event) => setOffer(event.target.value)} placeholder="e.g. 650" aria-label="Your offer in rupees" /></label>
          <div className="section-heading voice-heading"><span>2</span><div><h2>Bargain out loud</h2><p>Calm, measured speech makes the seller friendlier.</p></div></div>
          <div className="voice-controls">
            {!isListening ? (
              <button
                className="microphone-button"
                onClick={startListening}
                disabled={isGeneratingResponse}
              >
                <span>🎙️</span> Start listening
              </button>
            ) : (
              <div className="voice-button-row">
                <button
                  className="microphone-button listening"
                  onClick={() => void settleCurrentRound()}
                  disabled={isGeneratingResponse}
                >
                  <span className="pulse-dot" /> Settle this round
                </button>
                <button
                  type="button"
                  className="ghost-button"
                  onClick={cancelListening}
                  disabled={isGeneratingResponse}
                >
                  Discard
                </button>
              </div>
            )}
            <p className="status-message">{microphoneMessage}</p>
          </div>
          <div className="live-analysis">
            <div className={`tone-card ${toneBand.tone} ${isListening ? "is-live" : ""}`}>
              <span>Your tone</span>
              <div
                className="mini-meter"
                role="progressbar"
                aria-valuenow={liveVolume}
                aria-valuemin={0}
                aria-valuemax={100}
                aria-label="Live speaking loudness"
              >
                <i style={{ width: `${liveVolume}%` }} />
              </div>
              <strong>
                {!isListening
                  ? "—"
                  : isRoomMeasured
                    ? `${toneBand.label} · ${liveSnrDb} dB`
                    : "Tuning in…"}
              </strong>
              <small>
                {!isListening
                  ? "Press start to measure your voice"
                  : isRoomMeasured
                    ? toneBand.hint
                    : "Finding the background level — start talking whenever"}
              </small>
            </div>
            <div><span>Live pitch</span><strong>{livePitch ? `${livePitch} Hz` : "—"}</strong></div>
            <div><span>Malayalam recognition</span><strong>{recognitionStatus === "listening" ? "Listening · ml-IN" : recognitionStatus === "ready" ? "Ready · ml-IN" : recognitionStatus === "checking" ? "Checking…" : "Fallback ready"}</strong></div>
          </div>
          <details className="diagnostics">
            <summary>Mic setup &amp; diagnostics</summary>
            <div className="diagnostics-grid">
              <div><span>Loudness</span><strong>{liveSnrDb} dB</strong></div>
              <div>
                <span>Noise floor</span>
                <strong>{liveNoiseFloor ? liveNoiseFloor.toExponential(1) : "measuring…"}</strong>
              </div>
              <div>
                <span>Active window</span>
                <strong>
                  {effectiveWindow.quiet}–{effectiveWindow.loud} dB
                </strong>
              </div>
            </div>
            <div className="sensitivity-control">
              <label htmlFor="sensitivity">
                Mic sensitivity
                <em>
                  {sensitivityOffsetDb > 0 ? `+${sensitivityOffsetDb}` : sensitivityOffsetDb} dB
                </em>
              </label>
              <input
                id="sensitivity"
                type="range"
                min={MIN_SENSITIVITY_OFFSET_DB}
                max={MAX_SENSITIVITY_OFFSET_DB}
                step={1}
                value={sensitivityOffsetDb}
                onChange={(event) => applySensitivity(Number(event.target.value))}
                aria-describedby="sensitivity-help"
              />
              <div className="sensitivity-scale" aria-hidden="true">
                <span>Reads loud → drag right</span>
                <span>Reads quiet → drag left</span>
              </div>
              <div className="sensitivity-actions">
                <button
                  type="button"
                  className="ghost-button is-small"
                  onClick={calibrateToCurrentVoice}
                  disabled={!isListening}
                  title={
                    isListening
                      ? "Speak at your normal volume, then press"
                      : "Start listening first"
                  }
                >
                  🎚️ Calibrate to my voice
                </button>
                <button
                  type="button"
                  className="ghost-button is-small"
                  onClick={() => applySensitivity(0, "Sensitivity reset to default.")}
                  disabled={sensitivityOffsetDb === 0}
                >
                  Reset
                </button>
              </div>
              <p id="sensitivity-help" className="sensitivity-help" role="status">
                {calibrationMessage ||
                  "While listening, speak normally and press Calibrate. Everything louder than that reads as raised or shouting."}
              </p>
            </div>
          </details>
          <section className="speech-transcript" aria-live="polite">
            <div className="speech-transcript-header">
              <span>YOUR SPEECH</span>
              <strong>{recognitionStatus === "listening" ? "● LISTENING FOR MALAYALAM" : recognitionStatus === "ready" ? "ml-IN READY" : recognitionStatus === "ended" ? "RECOGNITION STOPPED" : recognitionStatus === "unavailable" ? "RECOGNITION UNAVAILABLE" : recognitionStatus === "error" ? "RECOGNITION ERROR" : "CHECKING SUPPORT"}</strong>
            </div>
            <p className={recognisedTranscript ? "is-final" : interimTranscript ? "is-interim" : "is-empty"}>
              {recognisedTranscript || interimTranscript || "Your actual recognised Malayalam speech will appear here."}
            </p>
            {recognitionStatus === "listening" && !recognisedTranscript && !interimTranscript && <small>Speak now — waiting for recognised words.</small>}
          </section>
          {typedFallbackVisible ? (
            <>
              <label className="transcript-field">
                <span>Typed fallback <em>used only when recognition is unavailable or fails</em></span>
                <textarea value={typedTranscript} onChange={(event) => setTypedTranscript(event.target.value)} placeholder="ചേട്ടാ, 500 രൂപയ്ക്ക് തരുമോ?" rows={2} />
              </label>
              {recognitionMessage && <p className="fallback-message" role="status">{recognitionMessage}</p>}
              {!isListening && (
                <button
                  className="fallback-button"
                  onClick={() => void settleCurrentRound(true)}
                  disabled={isGeneratingResponse}
                >
                  Settle round with typed text
                </button>
              )}
            </>
          ) : (
            <button
              type="button"
              className="fallback-button"
              onClick={() => setShowTypedFallback(true)}
            >
              Rather type than speak?
            </button>
          )}
        </section>

        <section className="aggression-panel" aria-live="polite">
          <div className="aggression-title"><div><p>LAST ROUND</p><h2>Aggression score</h2></div><strong>{aggression.score}<small>/100</small></strong></div>
          <div
            className="aggression-meter"
            role="progressbar"
            aria-valuenow={aggression.score}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-label="Last round aggression score"
          >
            <i style={{ width: `${aggression.score}%` }} />
          </div>
          <div className="metric-row"><span>Volume {aggression.volumeScore}</span><span>Pitch {aggression.pitchScore}</span><span>Pace {aggression.paceScore}{aggression.wordsPerMinute ? ` · ${aggression.wordsPerMinute} WPM` : ""}</span><span>{aggression.volumeSnrDb} dB</span></div>
          <ol className="mood-scale" aria-label="How aggression maps to the price">
            <li className={aggression.score <= 18 ? "is-active" : ""}><strong>Calm</strong><span>−₹70</span></li>
            <li className={aggression.score > 18 && aggression.score <= 32 ? "is-active" : ""}><strong>Polite</strong><span>−₹45</span></li>
            <li className={aggression.score > 32 && aggression.score <= 46 ? "is-active" : ""}><strong>Measured</strong><span>−₹20</span></li>
            <li className={aggression.score > 46 && aggression.score <= 58 ? "is-active" : ""}><strong>Neutral</strong><span>hold</span></li>
            <li className={aggression.score > 58 && aggression.score <= 75 ? "is-active" : ""}><strong>Loud</strong><span>+₹45</span></li>
            <li className={aggression.score > 75 ? "is-active" : ""}><strong>Shouting</strong><span>+₹90</span></li>
          </ol>
          <p>Quiet and steady lowers the price. A shouting match makes Ayala costlier.</p>
        </section>
      </section>
    </main>
  );
}
