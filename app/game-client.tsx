"use client";

import { useEffect, useRef, useState } from "react";
import {
  calculateAggression,
  GAME_CONFIG,
  getFinalTitle,
  type AggressionResult,
  type AudioMeasurements,
  type SellerMood,
  settleRound,
} from "@/lib/negotiation";

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

const MINIMUM_VOICE_RMS = 0.008;

function detectPitch(samples: Float32Array, sampleRate: number) {
  let rms = 0;
  for (const sample of samples) rms += sample * sample;
  rms = Math.sqrt(rms / samples.length);
  if (rms < MINIMUM_VOICE_RMS) return 0;

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
};

type RecognitionStatus =
  | "checking"
  | "ready"
  | "listening"
  | "ended"
  | "unavailable"
  | "error";

export default function GameClient() {
  const [round, setRound] = useState(1);
  const [currentPrice, setCurrentPrice] = useState<number>(GAME_CONFIG.startingPrice);
  const [offer, setOffer] = useState("");
  const [recognisedTranscript, setRecognisedTranscript] = useState("");
  const [interimTranscript, setInterimTranscript] = useState("");
  const [typedTranscript, setTypedTranscript] = useState("");
  const [isListening, setIsListening] = useState(false);
  const [microphoneMessage, setMicrophoneMessage] = useState(
    "Press the microphone and bargain out loud.",
  );
  const [recognitionMessage, setRecognitionMessage] = useState("");
  const [recognitionStatus, setRecognitionStatus] =
    useState<RecognitionStatus>("checking");
  const [liveVolume, setLiveVolume] = useState(0);
  const [livePitch, setLivePitch] = useState(0);
  const [aggression, setAggression] = useState(initialAggression);
  const [sellerMood, setSellerMood] = useState<SellerMood>("Neutral 😐");
  const [sellerResponse, setSellerResponse] = useState(
    "Fresh Ayala! Speak nicely and we can talk price.",
  );
  const [priceChange, setPriceChange] = useState(0);
  const [history, setHistory] = useState<HistoryItem[]>([]);

  const streamRef = useRef<MediaStream | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const animationFrameRef = useRef<number | null>(null);
  const recognitionRef = useRef<SpeechRecognitionLike | null>(null);
  const isStoppingRecognitionRef = useRef(false);
  const recognitionFailedRef = useRef(false);
  const startedAtRef = useRef(0);
  const analysisRef = useRef({
    volumeTotal: 0,
    voiceFrames: 0,
    pitchTotal: 0,
    pitchFrames: 0,
    lastUiUpdate: 0,
  });

  useEffect(() => {
    return () => {
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

  async function startListening() {
    setMicrophoneMessage("Requesting microphone access…");
    setRecognitionMessage("");
    setRecognisedTranscript("");
    setInterimTranscript("");
    setTypedTranscript("");
    setLiveVolume(0);
    setLivePitch(0);
    isStoppingRecognitionRef.current = false;
    recognitionFailedRef.current = false;
    analysisRef.current = {
      volumeTotal: 0,
      voiceFrames: 0,
      pitchTotal: 0,
      pitchFrames: 0,
      lastUiUpdate: 0,
    };

    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const audioContext = new AudioContext();
      const source = audioContext.createMediaStreamSource(stream);
      const analyser = audioContext.createAnalyser();
      analyser.fftSize = 2048;
      source.connect(analyser);
      await audioContext.resume();
      streamRef.current = stream;
      audioContextRef.current = audioContext;
      startedAtRef.current = Date.now();
      setIsListening(true);
      setMicrophoneMessage("Listening… speak normally, then settle this round.");

      const timeDomainData = new Float32Array(analyser.fftSize);
      const readAudio = () => {
        analyser.getFloatTimeDomainData(timeDomainData);
        let squareSum = 0;
        for (const sample of timeDomainData) squareSum += sample * sample;
        const rms = Math.sqrt(squareSum / timeDomainData.length);
        const pitch = detectPitch(timeDomainData, audioContext.sampleRate);

        if (rms >= MINIMUM_VOICE_RMS) {
          analysisRef.current.volumeTotal += rms;
          analysisRef.current.voiceFrames += 1;
          if (pitch > 0) {
            analysisRef.current.pitchTotal += pitch;
            analysisRef.current.pitchFrames += 1;
          }
        }

        if (Date.now() - analysisRef.current.lastUiUpdate > 120) {
          setLiveVolume(Math.min(100, Math.round((rms / GAME_CONFIG.audio.loudRms) * 100)));
          setLivePitch(Math.round(pitch));
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
        setRecognisedTranscript(finalText.trim());
        setInterimTranscript(interimText.trim());
      };
      recognition.onerror = (event) => {
        recognitionFailedRef.current = true;
        setRecognitionStatus("error");
        setInterimTranscript("");
        setRecognitionMessage(
          `Malayalam recognition could not continue (${event.error}). Audio analysis is still listening; type your bargain if needed.`,
        );
      };
      recognition.onend = () => {
        recognitionRef.current = null;
        if (!isStoppingRecognitionRef.current && !recognitionFailedRef.current) {
          setRecognitionStatus("ended");
          setInterimTranscript("");
          setRecognitionMessage(
            "Malayalam recognition stopped. Audio analysis is still listening; type your bargain or settle the round.",
          );
        }
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

  function settleCurrentRound(fallbackMode = false) {
    const durationSeconds = startedAtRef.current
      ? (Date.now() - startedAtRef.current) / 1000
      : 0;
    const capturedSpeech = recognisedTranscript.trim() || interimTranscript.trim();
    const playerSpeech = capturedSpeech || typedTranscript.trim() || "No words recognised — voice analysis only.";
    const audio: AudioMeasurements = {
      averageVolume:
        analysisRef.current.voiceFrames > 0
          ? analysisRef.current.volumeTotal / analysisRef.current.voiceFrames
          : 0,
      averagePitch:
        analysisRef.current.pitchFrames > 0
          ? analysisRef.current.pitchTotal / analysisRef.current.pitchFrames
          : 0,
      wordCount: capturedSpeech ? capturedSpeech.split(/\s+/).length : 0,
      durationSeconds,
      hadVoice: analysisRef.current.voiceFrames > 0,
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
    setAggression(roundAggression);
    setCurrentPrice(result.priceAfter);
    setPriceChange(result.priceChange);
    setSellerMood(result.sellerMood);
    setSellerResponse(result.sellerResponse);
    setHistory((previous) => [
      ...previous,
      {
        playerSpeech,
        aggression: roundAggression.score,
        priceBefore: currentPrice,
        priceAfter: result.priceAfter,
        sellerMood: result.sellerMood,
        sellerResponse: result.sellerResponse,
      },
    ]);
    setOffer("");
    setRecognisedTranscript("");
    setInterimTranscript("");
    setTypedTranscript("");
    startedAtRef.current = 0;

    if (round < GAME_CONFIG.totalRounds) {
      setRound((previous) => previous + 1);
      setMicrophoneMessage("Round settled. Bargain again when you are ready.");
    } else {
      setMicrophoneMessage("The market has spoken. Your final price is locked.");
    }
  }

  function restartGame() {
    stopCapture();
    setRound(1);
    setCurrentPrice(GAME_CONFIG.startingPrice);
    setOffer("");
    setRecognisedTranscript("");
    setInterimTranscript("");
    setTypedTranscript("");
    setAggression(initialAggression);
    setSellerMood("Neutral 😐");
    setSellerResponse("Fresh Ayala! Speak nicely and we can talk price.");
    setPriceChange(0);
    setHistory([]);
    setLiveVolume(0);
    setLivePitch(0);
    setMicrophoneMessage("Press the microphone and bargain out loud.");
    setRecognitionMessage("");
    setRecognitionStatus(getRecognitionConstructor() ? "ready" : "unavailable");
  }

  const isFinished = history.length === GAME_CONFIG.totalRounds;
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
          <div className="round-badge">ROUND {round} / {GAME_CONFIG.totalRounds}</div>
        </header>
        <div className="joke-banner"><span>🎙️</span> YOUR VOICE AFFECTS THE PRICE</div>

        <section className="seller-area">
          <div className="seller-avatar" aria-label="A smiling fish seller">🧔🏽‍♂️</div>
          <div className="seller-speech">
            <p className="mood-label">SELLER IS {sellerMood}</p>
            <p>&ldquo;{sellerResponse}&rdquo;</p>
          </div>
          <div className="fish-label"><span>🐟</span><strong>{GAME_CONFIG.fish}</strong><small>Fresh catch</small></div>
        </section>

        <section className="price-panel" aria-live="polite">
          <div><span>Current price</span><strong>₹{currentPrice}</strong></div>
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
              <button className="microphone-button" onClick={startListening}><span>🎙️</span> Start listening</button>
            ) : (
              <button className="microphone-button listening" onClick={() => settleCurrentRound()}><span className="pulse-dot" /> Settle this round</button>
            )}
            <p className="status-message">{microphoneMessage}</p>
          </div>
          <div className="live-analysis">
            <div><span>Live volume</span><div className="mini-meter"><i style={{ width: `${liveVolume}%` }} /></div><strong>{liveVolume}%</strong></div>
            <div><span>Live pitch</span><strong>{livePitch ? `${livePitch} Hz` : "—"}</strong></div>
            <div><span>Malayalam recognition</span><strong>{recognitionStatus === "listening" ? "Listening · ml-IN" : recognitionStatus === "ready" ? "Ready · ml-IN" : recognitionStatus === "checking" ? "Checking…" : "Fallback ready"}</strong></div>
          </div>
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
          <label className="transcript-field">
            <span>Typed fallback <em>used only when recognition is unavailable or fails</em></span>
            <textarea value={typedTranscript} onChange={(event) => setTypedTranscript(event.target.value)} placeholder="ചേട്ടാ, 500 രൂപയ്ക്ക് തരുമോ?" rows={2} />
          </label>
          {recognitionMessage && <p className="fallback-message" role="status">{recognitionMessage}</p>}
          {!isListening && <button className="fallback-button" onClick={() => settleCurrentRound(true)}>Use typed fallback for this round</button>}
        </section>

        <section className="aggression-panel" aria-live="polite">
          <div className="aggression-title"><div><p>LAST ROUND</p><h2>Aggression score</h2></div><strong>{aggression.score}<small>/100</small></strong></div>
          <div className="aggression-meter"><i style={{ width: `${aggression.score}%` }} /></div>
          <div className="metric-row"><span>Volume {aggression.volumeScore}</span><span>Pitch {aggression.pitchScore}</span><span>Pace {aggression.paceScore}{aggression.wordsPerMinute ? ` · ${aggression.wordsPerMinute} WPM` : ""}</span></div>
          <p>Quiet and steady lowers the price. A shouting match makes Ayala costlier.</p>
        </section>
      </section>
    </main>
  );
}
