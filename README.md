<img width="1280" height="640" alt="git (1)" src="https://github.com/user-attachments/assets/8920b256-2ba8-4988-b824-5351134eb4bd" />

# Meen Chanda — Fish Market Haggling Simulator 🐟🎯

## Basic Details
### Team Name: [BYTE BAZAAR]

### Team Members
- Team Lead: Abhinav - [College of Engineering,Chengannur]
- Member 2: Shaheem Ali - [College of Engineering,Chengannur]

### Project Description
A voice-driven Kerala fish market bargaining game. You haggle out loud with a stubborn
മീൻകാരൻ ചേട്ടൻ for a single Ayala (mackerel), and **how** you speak sets the price —
your live volume, pitch and speaking pace are measured in the browser and turned into
gameplay. Calm, measured speech drags the price down. Shouting makes the fish expensive.

### The Problem (that doesn't exist)
Every negotiation simulator on the internet reduces haggling to a text box and a number.
You type "₹500 final offer", the machine says yes or no, and nobody learns anything.
Meanwhile, in an actual Kerala fish market, the entire negotiation is decided by *tone* —
and there is no software anywhere that will tell you that you are being unacceptably loud
at a mackerel. A generation is growing up unable to bargain politely. Nobody asked us to
fix this. We fixed it anyway.

### The Solution (that nobody asked for)
We put a fish seller in your browser and gave him feelings, measured in decibels.

Your microphone is analysed in real time and blended into a single **Haggle Aggression
Score (0–100)**. That score moves the seller through five moods, from `Interested 🙂` to
`Personally Offended 🤬`, and a deterministic price engine adjusts the price accordingly.
The twist is that the obvious strategy is deliberately wrong: everyone instinctively gets
louder to bargain harder, and getting louder is exactly what makes the Ayala cost more.
Whisper politely and you walk away with a bargain. Shout and you will pay ₹1250 for one
mackerel while being insulted in Malayalam.

An LLM writes the seller's dialogue and a TTS model speaks it — but the language model
**never touches the price**. Only your voice does.

## Technical Details
### Technologies/Components Used
For Software:
- **Languages:** TypeScript, CSS
- **Frameworks:** Next.js 16.3.4 (App Router, Turbopack dev), React 19.2.8
- **Libraries:** Tailwind CSS v4 — and deliberately nothing else. All audio DSP
  (RMS metering, autocorrelation pitch detection, sliding-window noise-floor
  estimation) is hand-written with zero audio dependencies.
- **Browser APIs:** Web Audio API (`AnalyserNode`, `getFloatTimeDomainData`),
  Web Speech API (`SpeechRecognition`, `ml-IN`), `localStorage`
- **AI / Voice:** Sarvam AI — `sarvam-105b-conversations` for Malayalam dialogue,
  `bulbul:v3` for Malayalam TTS (speaker `gokul`, mood-driven `pace` + `temperature`)
- **Tools:** Node.js, npm, ESLint 9, TypeScript 5

For Hardware:
- No custom hardware. One (1) laptop microphone and one (1) willingness to shout at
  your own screen in public.

### Implementation
For Software:

# Installation
```bash
npm install
```

Create `.env.local` with a Sarvam AI key:

```bash
SARVAM_API_KEY=your_key_here
```

Optionally pick a different seller voice:

```bash
SARVAM_TTS_SPEAKER=gokul
```

Without a key the game still plays end-to-end, falling back to built-in Malayalam
seller lines (text only, no speech).

# Run
```bash
npm run dev
```

Open http://localhost:3000 and start bargaining.

Other scripts: `npm run build`, `npm run start`, `npm run lint`.

> **Browser note:** Malayalam speech recognition needs a Chromium-based browser
> (Chrome). Firefox does not ship `SpeechRecognition`, so there the game falls back to a
> typed input while microphone tone analysis — the part that actually sets the price —
> keeps working normally.

### Project Documentation
For Software:

# Screenshots 
![Screenshot1](Initial page)
*<img width="1920" height="1080" alt="image" src="https://github.com/user-attachments/assets/d5918240-93ba-48ce-b9bc-76192852787c" />


![Screenshot2](Haggle meter)
<img width="1920" height="1080" alt="image" src="https://github.com/user-attachments/assets/c8f76984-3488-404b-98ec-b94a94d90f75" />

![Screenshot3](score)
<img width="1920" height="1080" alt="image" src="https://github.com/user-attachments/assets/01422b8e-50b9-496f-9e58-9de47aedf5ad" />


# Diagrams
![Workflow](Add your workflow/architecture diagram here)
*Architecture. The important detail is the split: the price is decided entirely by a pure,
deterministic function of your voice, and the LLM is only allowed to write dialogue.*

```
┌──────────────────────── BROWSER (app/game-client.tsx) ────────────────────────┐
│                                                                               │
│   🎙️ getUserMedia ──► AnalyserNode ──► requestAnimationFrame loop            │
│      (autoGainControl: false — otherwise shouting and whispering              │
│       arrive at the same level and the whole game stops working)              │
│                              │                                               │
│         ┌────────────────────┼────────────────────┐                          │
│         ▼                    ▼                    ▼                          │
│   RMS volume        autocorrelation pitch    Web Speech API (ml-IN)          │
│   vs sliding-window   (85–350 Hz)              → words + pace (WPM)          │
│   noise floor (SNR dB)                                                        │
│         └────────────────────┼────────────────────┘                          │
│                              ▼                                               │
│              Haggle Aggression Score  0–100                                  │
│              (volume 0.4 · pitch 0.3 · pace 0.3)                             │
└──────────────────────────────┼───────────────────────────────────────────────┘
                               ▼
              ┌────────── lib/negotiation.ts (PURE) ──────────┐
              │  score ──► seller mood (5 levels)             │
              │  score + your offer ──► price delta           │
              │  ₹800 start · ₹600 fair · clamped ₹540–₹1250  │
              │  ◀── the LLM cannot reach into this box ──►   │
              └───────────────────┼───────────────────────────┘
                                  ▼  (settled price, read-only)
              ┌──── app/api/seller-response/route.ts ────┐
              │  Sarvam chat  → Malayalam dialogue       │
              │  Sarvam bulbul:v3 → speech               │
              │  pace + temperature driven by mood       │
              │  fallback: built-in Malayalam lines      │
              └───────────────────┼──────────────────────┘
                                  ▼
                    🔊 ചേട്ടൻ answers back, 5 rounds, price locks
```

For Hardware:

# Schematic & Circuit
Not applicable — this is a browser-only project.

# Build Photos
Not applicable — no hardware build.

### Project Demo
# Video
[Add your demo video link here]
*Suggested run of show: play one round speaking softly and politely and watch the price
fall, then play the next round shouting the same offer and watch the seller flip to
`Personally Offended 🤬` and the price climb past the starting price. That contrast is the
whole project in 30 seconds.*

# Additional Demos
- Try it with `SARVAM_API_KEY` removed to see the offline Malayalam fallback lines.
- Open **Mic setup & diagnostics** in-game to see the live loudness in dB, the measured
  room noise floor, and the auto-ranged meter window.

## Team Contributions
- Abhinav M: [Backend and frontend]
- Shaheem Ali: [Documentation and frontend]

---
Made with ❤️ at TinkerHub Useless Projects

![Static Badge](https://img.shields.io/badge/TinkerHub-24?color=%23000000&link=https%3A%2F%2Fwww.tinkerhub.org%2F)
![Static Badge](https://img.shields.io/badge/UselessProjects--26-26?link=https%3A%2F%2Ftinkerhub.org%2Fevents%2F1M8ORET9A1%2Fuseless-projects-3.0)
