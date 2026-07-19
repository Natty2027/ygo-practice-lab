import { useState, useEffect, useMemo, useRef, useCallback } from "react";

/*  YGO PRACTICE LAB — standalone goldfishing / deck-testing tool
    Data + art: YGOPRODeck API v7 (https://ygoprodeck.com/api-guide/)
    No AI calls. Card art is loaded from the YGOPRODeck CDN at runtime; for a
    local/production build, download the image set locally per their API guide
    (they ask you to cache data and not hotlink).                             */

const API = "https://db.ygoprodeck.com/api/v7/cardinfo.php";
const IMG = (id, small) =>
  `https://images.ygoprodeck.com/images/cards${small ? "_small" : ""}/${id}.jpg`;
const IMG_CROP = (id) =>
  `https://images.ygoprodeck.com/images/cards_cropped/${id}.jpg`;
/* cached, CORS-friendly image proxy — used as a fallback when the YGOPRODeck
   CDN throttles direct hotlinks (it rate-limits and asks you not to hotlink) */
const imgProxy = (u) => `https://images.weserv.nl/?url=${encodeURIComponent(u.replace(/^https?:\/\//, ""))}`;

const REDUCED = typeof window !== "undefined" &&
  window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;

/* darken / lighten a hex colour */
function shade(hex, amt) {
  const n = parseInt(hex.slice(1), 16);
  const cl = (v) => Math.max(0, Math.min(255, v));
  const r = cl((n >> 16) + amt), g = cl(((n >> 8) & 255) + amt), b = cl((n & 255) + amt);
  return `#${((r << 16) | (g << 8) | b).toString(16).padStart(6, "0")}`;
}
/* hex → rgba string with alpha */
function hexA(hex, a) {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${n >> 16},${(n >> 8) & 255},${n & 255},${a})`;
}
/* Master Duel-ish zone tones */
const ZONE = { mon: "#d8a13a", st: "#2fa6a0", emz: "#8a6bff", field: "#3fa96a", extra: "#8a6bff", pile: "#5a6a86" };

/* ---- self-contained Web Audio engine: procedural SFX + ambient music ----
   nothing to host or license — everything is synthesised at runtime. */
const Sound = {
  ctx: null, master: null, sfxOn: true, musicOn: false, musicTimer: null, step: 0,
  init() {
    if (this.ctx) return;
    try {
      const AC = window.AudioContext || window.webkitAudioContext;
      this.ctx = new AC();
      this.master = this.ctx.createGain();
      this.master.gain.value = 0.5;
      this.master.connect(this.ctx.destination);
    } catch { /* no audio */ }
  },
  resume() { try { this.ctx?.resume?.(); } catch {} },
  tone(freq, dur = 0.12, type = "sine", vol = 0.3, when = 0, dest = null) {
    if (!this.ctx) return;
    const t = this.ctx.currentTime + when;
    const o = this.ctx.createOscillator(), g = this.ctx.createGain();
    o.type = type; o.frequency.setValueAtTime(freq, t);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(vol, t + 0.012);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g); g.connect(dest || this.master); o.start(t); o.stop(t + dur + 0.03);
  },
  noise(dur = 0.2, vol = 0.3) {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    const buf = this.ctx.createBuffer(1, Math.max(1, this.ctx.sampleRate * dur), this.ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / d.length, 2);
    const src = this.ctx.createBufferSource(); src.buffer = buf;
    const g = this.ctx.createGain(); g.gain.value = vol;
    src.connect(g); g.connect(this.master); src.start(t); src.stop(t + dur);
  },
  sfx(kind) {
    if (!this.ctx || !this.sfxOn) return;
    this.resume();
    switch (kind) {
      case "click": this.tone(430, 0.05, "triangle", 0.14); break;
      case "draw": this.tone(620, 0.07, "sine", 0.18); this.tone(880, 0.08, "sine", 0.13, 0.05); break;
      case "summon": this.tone(300, 0.14, "sawtooth", 0.2); this.tone(460, 0.16, "sawtooth", 0.16, 0.06); this.tone(620, 0.2, "triangle", 0.14, 0.12); break;
      case "attack": this.tone(220, 0.13, "sawtooth", 0.24); this.noise(0.12, 0.22); break;
      case "damage": this.noise(0.24, 0.34); this.tone(110, 0.26, "square", 0.22); break;
      case "phase": this.tone(540, 0.1, "sine", 0.14); this.tone(720, 0.12, "sine", 0.12, 0.08); break;
      case "win": [523, 659, 784, 1047].forEach((f, i) => this.tone(f, 0.32, "triangle", 0.22, i * 0.12)); break;
      default: break;
    }
  },
  /* ---- background music -------------------------------------------------
     Real audio files play if you drop them in the app's ./audio/ folder.
     Nothing is bundled (Konami OSTs are copyrighted); if a file is absent we
     fall back to a soft synth ambience so music always "works". Filenames are
     defined in `tracks` — add your own .mp3/.ogg with these exact names.       */
  tracks: {
    "Duel (Master Duel style)": "./audio/duel.mp3",
    "Duelist of Roses": "./audio/duelist_of_roses.mp3",
  },
  trackKey: "Duel (Master Duel style)",
  audioEl: null, musicVol: 0.5,
  setTrack(key) {
    if (!(key in this.tracks)) return;
    this.trackKey = key;
    if (this.musicOn) { this.stopMusic(); this.startMusic(); }
  },
  startMusic() {
    if (!this.musicOn) return;
    const src = this.tracks[this.trackKey];
    if (src) {
      try {
        if (!this.audioEl) { this.audioEl = new Audio(); this.audioEl.loop = true; }
        this.audioEl.volume = this.musicVol;
        if (!this.audioEl.src || this.audioEl.src.indexOf(src.replace("./", "")) < 0) this.audioEl.src = src;
        const p = this.audioEl.play();
        if (p && p.then) p.then(() => { this._synthStop(); }).catch(() => { this._synthStart(); });
        return;
      } catch { /* fall through to synth */ }
    }
    this._synthStart();
  },
  stopMusic() { try { this.audioEl?.pause?.(); } catch {} this._synthStop(); },
  // soft synth ambience fallback (used only when no audio file loads)
  _synthStart() {
    if (!this.ctx || this.musicTimer) return;
    const scale = [220, 262, 294, 330, 392, 440, 523, 587];
    this.musicTimer = setInterval(() => {
      if (!this.musicOn) return;
      const f = scale[this.step % scale.length]; this.step++;
      this.tone(f, 1.5, "triangle", 0.05);
      if (this.step % 4 === 0) this.tone(f / 2, 2.2, "sine", 0.05);
      if (this.step % 8 === 0) this.tone(f * 1.5, 1.2, "triangle", 0.03, 0.25);
    }, 540);
  },
  _synthStop() { if (this.musicTimer) { clearInterval(this.musicTimer); this.musicTimer = null; } },
};

/* ---- design tokens ---------------------------------------------------- */
const C = {
  bg: "#0d1016",
  panel: "#161b24",
  panel2: "#1d2430",
  line: "#2b3342",
  gold: "#e8b84b",
  goldDim: "#9c7f30",
  text: "#ece6d6",
  mute: "#828b9e",
  good: "#4fbf7b",
  bad: "#e0576a",
};
/* real YGO card-frame colours — the UI's semantic language */
const FRAME = {
  normal:  { bg: "#b8935a", fg: "#1a1206" },
  effect:  { bg: "#a85a30", fg: "#fbeee2" },
  ritual:  { bg: "#3f66a8", fg: "#eef3fb" },
  fusion:  { bg: "#7a4f96", fg: "#f4ecfa" },
  synchro: { bg: "#dad4c6", fg: "#1a1a1a" },
  xyz:     { bg: "#20242b", fg: "#e6e6e6" },
  link:    { bg: "#2a5f86", fg: "#e8f2fb" },
  spell:   { bg: "#1a8f6c", fg: "#effaf5" },
  trap:    { bg: "#a83f74", fg: "#fbeaf3" },
  token:   { bg: "#5a6070", fg: "#eee" },
  skill:   { bg: "#3d5a80", fg: "#eee" },
};
const frameKey = (ft = "") => {
  ft = ft.toLowerCase();
  if (ft.includes("link")) return "link";
  if (ft.includes("xyz")) return "xyz";
  if (ft.includes("synchro")) return "synchro";
  if (ft.includes("fusion")) return "fusion";
  if (ft.includes("ritual")) return "ritual";
  if (ft.includes("spell")) return "spell";
  if (ft.includes("trap")) return "trap";
  if (ft.includes("normal")) return "normal";
  if (ft.includes("token")) return "token";
  if (ft.includes("skill")) return "skill";
  return "effect";
};
const isExtra = (ft = "") =>
  /fusion|synchro|xyz|link/.test(ft.toLowerCase());

/* ---- sample deck (by name) so the app is useful on first load --------- */
/* stubs carry a best-effort passcode + frame so the UI populates even
   offline; on mount we hydrate real ids/art/stats via ONE batched query. */
const SAMPLE = [
  ["Blue-Eyes White Dragon", 89631139, "normal", 3],
  ["Blue-Eyes Alternative White Dragon", 38517737, "effect", 3],
  ["Sage with Eyes of Blue", 79852326, "effect", 3],
  ["Maiden with Eyes of Blue", 88241506, "effect", 2],
  ["Master with Eyes of Blue", 45644898, "effect", 1],
  ["Ash Blossom & Joyous Spring", 14558127, "effect", 3],
  ["Maxx \"C\"", 23434538, "effect", 3],
  ["Effect Veiler", 97268402, "effect", 2],
  ["Nibiru, the Primal Being", 27204311, "effect", 1],
  ["Dragon Shrine", 81275020, "spell", 2],
  ["The Melody of Awakening Dragon", 48800175, "spell", 2],
  ["Trade-In", 38120068, "spell", 3],
  ["Pot of Extravagance", 49238328, "spell", 2],
  ["Called by the Grave", 24224830, "spell", 2],
  ["Monster Reborn", 83764718, "spell", 1],
  ["Harpie's Feather Duster", 18144506, "spell", 1],
  ["Return of the Dragon Lords", 6853254, "spell", 2],
  ["Infinite Impermanence", 10045474, "trap", 3],
  ["Solemn Judgment", 41420027, "trap", 1],
  // extra
  ["Blue-Eyes Twin Burst Dragon", 20721928, "fusion", 2],
  ["Blue-Eyes Spirit Dragon", 59822133, "synchro", 2],
  ["Azure-Eyes Silver Dragon", 30576089, "synchro", 2],
  ["Crystal Wing Synchro Dragon", 50954680, "synchro", 1],
  ["Stardust Dragon", 44508094, "synchro", 1],
  ["Number 38: Hope Harbinger Dragon Titanic Galaxy", 33776843, "xyz", 2],
  ["Galaxy-Eyes Cipher Dragon", 18963306, "xyz", 1],
  ["Hieratic Seal of the Heavenly Spheres", 24361622, "xyz", 2],
  ["I:P Masquerena", 65741786, "link", 1],
  ["Accesscode Talker", 86066372, "link", 1],
];

/* ---- built-in OPPONENT decks (independent of the player's deck) ---------
   Deliberately built from long-standing, pre-2005 cards that are guaranteed
   to exist in BabelCDB. Most are Normal Monsters (need no Lua script at all),
   padded with staple spells/traps that have stable, long-lived scripts — so
   these decks resolve and play cleanly every time. Each is exactly 40 cards,
   no Extra Deck, so the AI presents a real board + attacks to test against.
   Format: [passcode, copies].                                                */
const OPP_DECKS = {
  "Legendary Beatdown": [
    [89631139, 2], [70781052, 2], [6368038, 2], [97590747, 3], [5053103, 2],
    [13039848, 2], [28279543, 2], [46986414, 2], [91152256, 3], [15025844, 3],
    [88819587, 2], [67724379, 2],
    [83764718, 1], [53129443, 1], [12580477, 1], [55144522, 1], [5318639, 2],
    [66788016, 2], [86318356, 1], [44095762, 2], [4206964, 2],
  ],
  "Dragon's Roar": [
    [89631139, 3], [28279543, 3], [88819587, 3], [67724379, 3], [5053103, 2],
    [70781052, 2], [6368038, 2], [13039848, 2], [97590747, 2],
    [46986414, 2], [15025844, 2], [91152256, 2],
    [83764718, 1], [53129443, 1], [12580477, 1], [55144522, 1], [5318639, 2],
    [66788016, 2], [44095762, 2], [4206964, 2],
  ],
};
// expand [[id,copies]…] → flat [{id}…] the resolver/prewarm pipeline expects
const expandOppDeck = (rows) => {
  const out = [];
  (rows || []).forEach(([id, n]) => { for (let i = 0; i < n; i++) out.push({ id }); });
  return out;
};

const CATS = [
  ["", "All"],
  ["Effect Monster,Normal Monster,Flip Effect Monster,Gemini Monster,Spirit Monster,Tuner Monster,Union Effect Monster,Pendulum Effect Monster,Normal Tuner Monster", "Monsters"],
  ["Fusion Monster,Synchro Monster,XYZ Monster,Link Monster,Synchro Tuner Monster,Pendulum Effect Fusion Monster", "Extra"],
  ["Spell Card", "Spells"],
  ["Trap Card", "Traps"],
];
const ATTRS = ["", "DARK", "LIGHT", "EARTH", "WATER", "FIRE", "WIND", "DIVINE"];

/* small persistent-storage wrapper (falls back to memory) --------------- */
const mem = {};
const store = {
  async get(k) {
    try { const r = await window.storage.get(k); return r ? r.value : mem[k]; }
    catch { return mem[k]; }
  },
  async set(k, v) {
    mem[k] = v;
    try { await window.storage.set(k, v); } catch { /* memory only */ }
  },
};

/* ====================================================================== */
export default function App() {
  const [tab, setTab] = useState("editor");
  const [main, setMain] = useState([]);   // arrays of card objects (1 per copy)
  const [extra, setExtra] = useState([]);
  const [side, setSide] = useState([]);
  const [online, setOnline] = useState(null);
  const [toast, setToast] = useState("");
  const [musicOn, setMusicOn] = useState(false);
  const [sfxOn, setSfxOn] = useState(true);
  const [track, setTrack] = useState(Sound.trackKey);

  useEffect(() => { Sound.sfxOn = sfxOn; }, [sfxOn]);
  useEffect(() => { // unlock audio on the first user gesture (browser autoplay policy)
    const kick = () => { Sound.init(); Sound.resume(); window.removeEventListener("pointerdown", kick); };
    window.addEventListener("pointerdown", kick);
    return () => window.removeEventListener("pointerdown", kick);
  }, []);
  const toggleMusic = () => { Sound.init(); Sound.resume(); const v = !musicOn; setMusicOn(v); Sound.musicOn = v; if (v) Sound.startMusic(); else Sound.stopMusic(); };
  const toggleSfx = () => { Sound.init(); Sound.resume(); setSfxOn((s) => !s); };

  /* hydrate sample deck once — fetch by passcode so every card gets real art,
     stats and effect text (IDs are exact; name matching misses on punctuation) */
  useEffect(() => {
    let alive = true;
    (async () => {
      const ids = SAMPLE.map((s) => s[1]);
      let byId = {};
      try {
        const res = await fetch(`${API}?misc=yes&id=${ids.join(",")}`);
        const j = await res.json();
        if (j.data) j.data.forEach((c) => (byId[c.id] = c));
        if (alive) setOnline(true);
      } catch { if (alive) setOnline(false); }
      const m = [], x = [];
      SAMPLE.forEach(([name, id, ft, n]) => {
        const real = byId[id];
        const card = real
          ? normalize(real)
          : { id, name, frameType: ft, type: ft, level: null, atk: null, def: null, attribute: null, race: null, desc: "(effect text unavailable offline)" };
        for (let i = 0; i < n; i++) (isExtra(card.frameType) ? x : m).push(card);
      });
      if (alive) { setMain(m); setExtra(x); }
    })();
    return () => { alive = false; };
  }, []);

  const flash = (m) => { setToast(m); setTimeout(() => setToast(""), 1800); };

  const countOf = (list, name) => list.filter((c) => c.name === name).length;
  const totalCopies = (name) =>
    countOf(main, name) + countOf(extra, name) + countOf(side, name);

  const addCard = useCallback((card, dest) => {
    const target = dest || (isExtra(card.frameType) ? "extra" : "main");
    if (totalCopies(card.name) >= 3) return flash("Max 3 copies");
    const setter = target === "main" ? setMain : target === "extra" ? setExtra : setSide;
    const cap = target === "extra" ? 15 : target === "side" ? 15 : 60;
    setter((prev) => (prev.length >= cap ? (flash(`${target} deck full`), prev) : [...prev, card]));
  }, [main, extra, side]);

  const removeOne = (list, setter, name) => {
    const i = list.map((c) => c.name).lastIndexOf(name);
    if (i >= 0) { const cp = [...list]; cp.splice(i, 1); setter(cp); }
  };

  return (
    <div style={{ background: C.bg, color: C.text, minHeight: "100vh", fontFamily: "ui-sans-serif, system-ui, sans-serif" }}>
      <style>{`
        *{box-sizing:border-box}
        html{-webkit-font-smoothing:antialiased;text-rendering:optimizeLegibility}
        ::-webkit-scrollbar{width:9px;height:9px}
        ::-webkit-scrollbar-thumb{background:${C.line};border-radius:9px}
        ::-webkit-scrollbar-track{background:transparent}
        .mono{font-family:ui-monospace,'SF Mono',Menlo,monospace}
        .disp{font-family:'Oswald',ui-sans-serif,system-ui,sans-serif;font-weight:700;letter-spacing:.1em;text-transform:uppercase}
        button{cursor:pointer;font-family:inherit;transition:filter .12s ease, transform .06s ease, box-shadow .15s ease, background .15s ease, border-color .15s ease}
        button:not(:disabled):hover{filter:brightness(1.09)}
        button:not(:disabled):active{transform:translateY(1px)}
        button:disabled{cursor:default;opacity:.55}
        :focus-visible{outline:2px solid rgba(232,184,75,.8);outline-offset:2px}
        select,input{transition:border-color .15s ease, box-shadow .15s ease}
        select:focus,input:focus{border-color:#e8b84b;box-shadow:0 0 0 3px rgba(232,184,75,.16)}
        .cardimg{transition:transform .12s ease, box-shadow .12s ease}
        .cardimg:hover{transform:translateY(-3px);box-shadow:0 6px 18px rgba(0,0,0,.55)}
        input,select{font-family:inherit}
        .dcard{animation:popIn .28s cubic-bezier(.2,.9,.3,1.25)}
        .dcard:hover{filter:brightness(1.14);transform:translateY(-2px)}
        .lpnum{display:inline-block;animation:lpPulse .45s ease}
        .turnbanner{animation:bannerIn .5s ease}
        .dmgflash{position:fixed;inset:0;pointer-events:none;z-index:55;background:radial-gradient(circle at 50% 50%, transparent 38%, rgba(224,87,106,.55));animation:dmgflash .55s ease forwards}
        .shake{animation:shake .4s ease}
        @keyframes popIn{from{transform:scale(.55) translateY(6px);opacity:0}to{transform:scale(1) translateY(0);opacity:1}}
        @keyframes lpPulse{0%{transform:scale(1)}35%{transform:scale(1.3);filter:brightness(1.5)}100%{transform:scale(1)}}
        @keyframes bannerIn{from{opacity:0;transform:translateY(-6px)}to{opacity:1;transform:translateY(0)}}
        @keyframes attackPulse{0%,100%{box-shadow:0 0 0 0 rgba(224,87,106,.7)}50%{box-shadow:0 0 0 5px rgba(224,87,106,0)}}
        @keyframes dmgflash{0%{opacity:0}22%{opacity:1}100%{opacity:0}}
        @keyframes shake{0%,100%{transform:translateX(0)}20%{transform:translateX(-5px)}40%{transform:translateX(5px)}60%{transform:translateX(-3px)}80%{transform:translateX(3px)}}
        .atktarget{animation:attackPulse 1.1s infinite}
        /* heaven / hell arena backdrop */
        .fieldwrap{position:relative;overflow:auto;background:radial-gradient(120% 80% at 50% 50%,#0c0a12,#060509)}
        .fieldbg{position:absolute;inset:0;pointer-events:none}
        .fieldbg.hell{background:radial-gradient(75% 46% at 50% -10%,rgba(226,74,40,.34),transparent 66%),radial-gradient(38% 24% at 28% 6%,rgba(255,120,40,.16),transparent 70%);animation:glowpulse 6s ease-in-out infinite}
        .fieldbg.heaven{background:radial-gradient(75% 46% at 50% 110%,rgba(240,212,112,.26),transparent 66%),radial-gradient(38% 24% at 72% 94%,rgba(255,255,222,.13),transparent 70%);animation:glowpulse 7.5s ease-in-out infinite}
        .emberlayer,.motelayer{position:absolute;inset:0;pointer-events:none;background-repeat:repeat}
        .emberlayer{opacity:.6;background-image:radial-gradient(2px 2px at 15% 80%,#ff9a4d,transparent),radial-gradient(1.5px 1.5px at 45% 92%,#ffbe6a,transparent),radial-gradient(2px 2px at 76% 85%,#ff7a3d,transparent),radial-gradient(1px 1px at 60% 96%,#ffd27a,transparent),radial-gradient(1.5px 1.5px at 32% 70%,#ff8a45,transparent),radial-gradient(1px 1px at 88% 74%,#ffab55,transparent);background-size:420px 420px;animation:rise 15s linear infinite}
        .motelayer{opacity:.5;background-image:radial-gradient(1.5px 1.5px at 25% 20%,#fff6d8,transparent),radial-gradient(1px 1px at 65% 35%,#ffe9a8,transparent),radial-gradient(2px 2px at 82% 14%,#fffbe8,transparent),radial-gradient(1px 1px at 40% 8%,#ffe08a,transparent),radial-gradient(1.5px 1.5px at 12% 40%,#fff4cf,transparent);background-size:540px 540px;animation:rise 27s linear infinite}
        .rift{animation:riftglow 4s ease-in-out infinite}
        @keyframes rise{from{background-position:0 0}to{background-position:0 -420px}}
        @keyframes glowpulse{0%,100%{opacity:.72}50%{opacity:1}}
        @keyframes riftglow{0%,100%{opacity:.75;filter:drop-shadow(0 0 3px rgba(138,107,255,.5))}50%{opacity:1;filter:drop-shadow(0 0 12px rgba(138,107,255,.95))}}
        /* ---- Master Duel arena (modeled on the MD forest-ruins field) ---- */
        .mdArena{position:relative;border-radius:12px;overflow:hidden;
          background:
            radial-gradient(60% 90% at -5% 50%, rgba(24,52,22,.95), transparent 55%),
            radial-gradient(60% 90% at 105% 50%, rgba(22,48,20,.95), transparent 55%),
            radial-gradient(90% 55% at 50% -8%, rgba(30,58,24,.9), transparent 55%),
            radial-gradient(90% 55% at 50% 108%, rgba(28,54,22,.9), transparent 55%),
            linear-gradient(180deg,#4a5238 0%,#565d40 30%,#5b6144 55%,#4e5439 100%)}
        .mdArena::before{content:"";position:absolute;inset:0;pointer-events:none;opacity:.5;
          background-image:radial-gradient(3px 3px at 12% 24%,rgba(20,40,16,.7),transparent),radial-gradient(4px 3px at 88% 18%,rgba(22,44,18,.7),transparent),radial-gradient(3px 4px at 8% 78%,rgba(18,38,14,.7),transparent),radial-gradient(4px 4px at 92% 82%,rgba(20,42,16,.7),transparent),radial-gradient(2px 2px at 30% 8%,rgba(160,168,120,.35),transparent),radial-gradient(2px 2px at 66% 92%,rgba(158,166,118,.3),transparent);
          background-size:340px 300px}
        .mdField{position:relative;border-radius:10px;padding:14px 18px;
          background:
            repeating-linear-gradient(0deg, rgba(60,66,46,.28) 0 1px, transparent 1px 52px),
            repeating-linear-gradient(90deg, rgba(60,66,46,.28) 0 1px, transparent 1px 64px),
            radial-gradient(80% 60% at 50% 50%, rgba(205,200,170,.16), transparent 75%),
            linear-gradient(180deg,#8d8a6d 0%, #97927a 40%, #8f8b70 100%);
          box-shadow: inset 0 0 60px rgba(40,44,26,.55), inset 0 0 6px rgba(0,0,0,.35), 0 4px 24px rgba(0,0,0,.45);
          border:1px solid rgba(58,62,40,.8)}
        .octpad{clip-path:polygon(29% 0,71% 0,100% 29%,100% 71%,71% 100%,29% 100%,0 71%,0 29%)}
        .stonepad{position:relative;
          background:
            radial-gradient(78% 78% at 50% 46%, rgba(214,208,180,.9) 0 38%, rgba(178,172,142,.9) 39% 58%, rgba(196,190,160,.9) 59% 78%, rgba(160,155,126,.92) 79% 100%),
            linear-gradient(180deg,#b7b190,#a09a78)}
        .stonepad::after{content:"";position:absolute;inset:14%;clip-path:polygon(29% 0,71% 0,100% 29%,100% 71%,71% 100%,29% 100%,0 71%,0 29%);
          border:1px solid rgba(96,92,66,.55);opacity:.8}
        .bluerow{position:relative}
        .bluerow::before{content:"";position:absolute;left:-8px;right:-8px;top:-6px;bottom:-10px;pointer-events:none;border-radius:8px;
          background:radial-gradient(70% 120% at 50% 115%, rgba(64,170,255,.34), transparent 62%);
          box-shadow:0 10px 26px -8px rgba(64,170,255,.5);animation:glowpulse 3.6s ease-in-out infinite}
        .redrow{position:relative}
        .redrow::before{content:"";position:absolute;left:-8px;right:-8px;top:-10px;bottom:-6px;pointer-events:none;border-radius:8px;
          background:radial-gradient(70% 120% at 50% -15%, rgba(255,96,130,.26), transparent 62%)}
        .turnchange{position:absolute;left:0;right:0;top:42%;height:62px;z-index:34;display:grid;place-items:center;pointer-events:none;
          background:linear-gradient(180deg, rgba(70,120,230,0) 0%, rgba(38,84,200,.94) 26%, rgba(30,70,185,.96) 74%, rgba(70,120,230,0) 100%);
          box-shadow:0 0 30px rgba(40,90,210,.55);animation:tcSweep 1.7s cubic-bezier(.2,.8,.25,1) forwards}
        .turnchange span{font-style:italic;font-weight:800;letter-spacing:.26em;font-size:30px;color:#f2f6ff;
          text-shadow:0 2px 0 rgba(10,26,80,.9), 0 0 18px rgba(140,180,255,.8);text-transform:uppercase}
        @keyframes tcSweep{0%{transform:translateX(-102%)}16%{transform:translateX(0)}78%{transform:translateX(0);opacity:1}100%{transform:translateX(4%);opacity:0}}
        .mdBand{background:linear-gradient(90deg, rgba(8,10,14,0) 0%, rgba(8,10,14,.78) 12%, rgba(8,10,14,.78) 88%, rgba(8,10,14,0) 100%);
          color:#f4f2ea;font-weight:700;text-align:center;text-shadow:0 1px 3px rgba(0,0,0,.9);padding:7px 24px;font-size:12.5px;line-height:1.45}
        .turnhex{clip-path:polygon(25% 5%,75% 5%,100% 50%,75% 95%,25% 95%,0 50%);width:74px;height:60px;display:grid;place-items:center;
          background:radial-gradient(circle at 40% 30%, #d8433a, #8e1f1a 62%, #5c120e);box-shadow:inset 0 0 12px rgba(0,0,0,.55);
          color:#ffd9a8;font-weight:800;font-size:11px;text-shadow:0 1px 2px #000;position:relative}
        .turnhex::before{content:"";position:absolute;inset:3px;clip-path:polygon(25% 5%,75% 5%,100% 50%,75% 95%,25% 95%,0 50%);
          border:0;background:linear-gradient(180deg, rgba(255,210,140,.35), transparent 45%);pointer-events:none}
        .railbtn{width:46px;height:46px;border-radius:50%;display:grid;place-items:center;cursor:pointer;font-size:18px;color:#dceafe;
          background:radial-gradient(circle at 34% 28%, #2f6fd8, #123a86 62%, #0a2258);border:2px solid #6ea6f2;
          box-shadow:0 0 10px rgba(46,110,220,.55), inset 0 2px 4px rgba(160,200,255,.4)}
        .railbtn:hover{filter:brightness(1.18)}
        .railbtn.off{filter:saturate(.35) brightness(.75)}
        .lpplateOpp{position:absolute;top:10px;right:10px;z-index:20;display:flex;align-items:center;gap:8px}
        .lpplateMe{position:absolute;bottom:10px;left:10px;z-index:20;display:flex;align-items:center;gap:8px}
        .lpname{background:linear-gradient(90deg,#8e1f1a,#5c120e);color:#fff;font-size:10px;font-weight:700;padding:2px 10px;letter-spacing:.06em}
        .lpnumplate{background:rgba(6,8,10,.88);color:#fff;font-weight:800;font-size:22px;padding:2px 14px;letter-spacing:.04em;
          border:1px solid rgba(255,255,255,.12);text-shadow:0 0 8px rgba(255,255,255,.25)}
        .avhex{clip-path:polygon(25% 5%,75% 5%,100% 50%,75% 95%,25% 95%,0 50%);width:44px;height:48px;display:grid;place-items:center;
          background:radial-gradient(circle at 40% 30%, #b8362d, #6e1712);color:#ffe6c8;font-weight:800;font-size:12px;border:0}
        .atkplate{color:#fff;font-weight:800;text-shadow:0 1px 0 #000, 0 0 6px rgba(0,0,0,.9);font-size:11px;line-height:1.15;text-align:center}
        .atkplate .lv{color:#ffb63d;font-size:9px}
        .atkplate u{text-decoration:none;border-top:1px solid rgba(255,255,255,.75);display:inline-block;padding-top:1px}
        .flarelayer{position:absolute;inset:0;pointer-events:none;z-index:3}
        .flare-red{background:radial-gradient(circle at 50% 40%,transparent 35%,rgba(226,60,40,.6));animation:flarefade .6s ease forwards}
        .flare-gold{background:radial-gradient(120% 70% at 50% 100%,rgba(240,210,110,.55),transparent 62%);animation:flarefade .75s ease forwards}
        @keyframes flarefade{0%{opacity:0}22%{opacity:1}100%{opacity:0}}
        .summonpop{animation:summonpop 1.3s cubic-bezier(.2,.8,.2,1) forwards}
        @keyframes summonpop{0%{opacity:0;transform:scale(.4) translateY(24px)}18%{opacity:1;transform:scale(1.06) translateY(0)}72%{opacity:1;transform:scale(1)}100%{opacity:0;transform:scale(1.03) translateY(-10px)}}
        /* opponent-hand card backs — ornate MD-style back, fanned */
        .cardback{width:34px;height:50px;border-radius:4px;
          background:
            radial-gradient(circle at 50% 42%,rgba(232,184,75,.9) 0 18%,rgba(156,127,48,.55) 19% 30%,transparent 31%),
            linear-gradient(145deg,#7a4a1c,#4b2a0d 60%,#33200b);
          border:1px solid rgba(0,0,0,.55);
          box-shadow:0 3px 6px rgba(0,0,0,.5),inset 0 0 0 2px rgba(232,184,75,.28),inset 0 0 8px rgba(0,0,0,.5);
          position:relative;animation:cbIn .32s ease both}
        .cardback::after{content:"";position:absolute;inset:5px;border:1px solid rgba(232,184,75,.32);border-radius:3px}
        @keyframes cbIn{from{opacity:0;transform:translateY(-10px) scale(.9)}to{opacity:1}}
        /* floating damage number */
        .dmgfloat{position:absolute;left:50%;z-index:36;pointer-events:none;font-weight:900;font-style:italic;
          letter-spacing:.02em;text-shadow:0 2px 8px rgba(0,0,0,.85),0 0 14px currentColor;
          animation:dmgfloat 1.15s cubic-bezier(.2,.7,.3,1) forwards}
        @keyframes dmgfloat{0%{opacity:0;transform:translate(-50%,10px) scale(.6)}18%{opacity:1;transform:translate(-50%,-4px) scale(1.18)}55%{opacity:1;transform:translate(-50%,-30px) scale(1)}100%{opacity:0;transform:translate(-50%,-64px) scale(.95)}}
        /* summon ground-ring pulse under the spotlight card */
        .summonring{position:absolute;left:50%;top:50%;z-index:33;width:120px;height:120px;margin:-60px 0 0 -60px;border-radius:50%;
          border:2px solid rgba(232,184,75,.8);pointer-events:none;animation:summonring 1s ease-out forwards}
        @keyframes summonring{0%{opacity:0;transform:scale(.2)}30%{opacity:.9}100%{opacity:0;transform:scale(1.9)}}
        @media (prefers-reduced-motion:reduce){.cardimg,.dcard,.lpnum,.turnbanner,.dmgflash,.shake,.atktarget,.fieldbg,.emberlayer,.motelayer,.rift,.flare-red,.flare-gold,.summonpop{animation:none;transition:none}}
      `}</style>

      {/* header */}
      <header style={{ borderBottom: `1px solid ${C.line}`, padding: "14px 20px", display: "flex", alignItems: "center", gap: 18, position: "sticky", top: 0, background: "rgba(13,16,22,.92)", backdropFilter: "blur(6px)", zIndex: 20 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <div style={{ width: 30, height: 30, transform: "rotate(45deg)", background: `linear-gradient(135deg,${C.gold},${C.goldDim})`, borderRadius: 4, boxShadow: `0 0 14px ${C.goldDim}` }} />
          <div>
            <div className="disp" style={{ fontSize: 17, color: C.gold, lineHeight: 1 }}>Practice Lab</div>
            <div className="mono" style={{ fontSize: 10, color: C.mute, letterSpacing: ".18em" }}>GOLDFISH · TEST · TUNE</div>
          </div>
        </div>
        <nav style={{ display: "flex", gap: 4, marginLeft: 8 }}>
          {[["editor", "Deck Editor"], ["duel", "Duel"], ["manual", "Manual Board"], ["hand", "Test Hand"], ["stats", "Probability"]].map(([k, l]) => (
            <button key={k} onClick={() => setTab(k)} className="disp"
              style={{ fontSize: 12, padding: "8px 14px", borderRadius: 6, border: "none",
                background: tab === k ? C.gold : "transparent",
                color: tab === k ? "#1a1206" : C.mute }}>
              {l}
            </button>
          ))}
        </nav>
        <div style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: 8 }}>
          <button onClick={toggleMusic} title="Background music" style={{ background: "transparent", border: `1px solid ${musicOn ? C.gold : C.line}`, color: musicOn ? C.gold : C.mute, borderRadius: 6, padding: "5px 9px", fontSize: 12 }}>🎵</button>
          <select value={track} onChange={(e) => { setTrack(e.target.value); Sound.setTrack(e.target.value); }} title="Music track"
            style={{ background: "transparent", border: `1px solid ${C.line}`, color: C.mute, borderRadius: 6, padding: "5px 6px", fontSize: 11, maxWidth: 130 }}>
            {Object.keys(Sound.tracks).map((k) => <option key={k} value={k} style={{ background: C.panel }}>{k}</option>)}
          </select>
          <button onClick={toggleSfx} title="Sound effects" style={{ background: "transparent", border: `1px solid ${sfxOn ? C.gold : C.line}`, color: sfxOn ? C.gold : C.mute, borderRadius: 6, padding: "5px 9px", fontSize: 12 }}>{sfxOn ? "🔊" : "🔇"}</button>
          <span className="mono" style={{ fontSize: 11, color: online === false ? C.bad : C.mute }}>
            {online === null ? "connecting…" : online ? "● live db" : "○ offline"}
          </span>
        </div>
      </header>

      {tab === "editor" && (
        <Editor main={main} extra={extra} side={side}
          setMain={setMain} setExtra={setExtra} setSide={setSide}
          addCard={addCard} removeOne={removeOne} countOf={countOf} flash={flash} />
      )}
      {tab === "duel" && <EngineDuel main={main} extra={extra} />}
      {tab === "manual" && <DuelBoard main={main} extra={extra} />}
      {tab === "hand" && <HandTester main={main} />}
      {tab === "stats" && <Probability main={main} />}

      {toast && (
        <div className="mono" style={{ position: "fixed", bottom: 20, left: "50%", transform: "translateX(-50%)", background: C.panel2, border: `1px solid ${C.gold}`, color: C.gold, padding: "9px 16px", borderRadius: 8, fontSize: 12, zIndex: 50 }}>
          {toast}
        </div>
      )}
    </div>
  );
}

/* ---- helpers ---------------------------------------------------------- */
function normalize(c) {
  const misc = c.misc_info?.[0];
  return {
    id: c.card_images?.[0]?.id ?? c.id,
    name: c.name,
    frameType: c.frameType || (c.type?.toLowerCase().includes("spell") ? "spell" : c.type?.toLowerCase().includes("trap") ? "trap" : "effect"),
    type: c.type,
    level: c.level ?? c.rank ?? c.linkval ?? null,
    atk: c.atk ?? null,
    def: c.def ?? null,
    attribute: c.attribute ?? null,
    race: c.race ?? null,
    desc: c.desc ?? "",
    // open-source Master Duel data (via YGOPRODeck misc_info)
    rarity: misc?.md_rarity ?? null,
    formats: misc?.formats ?? null,
    inMD: misc?.formats ? misc.formats.includes("Master Duel") : null,
    banTcg: c.banlist_info?.ban_tcg ?? null,
    banOcg: c.banlist_info?.ban_ocg ?? null,
  };
}
/* resilient card image: tries the CDN, then a cached proxy, then a labelled
   placeholder — so a throttled/failed load never leaves a blank card */
function CardImg({ id, variant = "small", name = "", frameType = "", style, className, onClick, title }) {
  const primary = variant === "crop" ? IMG_CROP(id) : IMG(id, variant === "small");
  const chain = variant === "crop"
    ? [primary, imgProxy(primary), IMG(id), imgProxy(IMG(id))]
    : [primary, imgProxy(primary)];
  const [i, setI] = useState(0);
  if (i >= chain.length) {
    const f = FRAME[frameKey(frameType)];
    return (
      <div className={className} onClick={onClick} title={title || name}
        style={{ ...style, display: "grid", placeItems: "center", textAlign: "center", overflow: "hidden",
          background: `linear-gradient(155deg, ${shade(f.bg, 10)}, ${shade(f.bg, -34)})`, color: f.fg, fontSize: 8, lineHeight: 1.2, padding: "0 4px" }}>
        {name}
      </div>
    );
  }
  return (
    <img src={chain[i]} alt={name} title={title || name} loading="lazy" referrerPolicy="no-referrer"
      className={className} style={style} onClick={onClick} onError={() => setI((v) => v + 1)} />
  );
}
/* short rarity tag + colour for the Master Duel rarity gems */
const RARITY = {
  "Ultra Rare": { t: "UR", c: "#e8b84b" },
  "Super Rare": { t: "SR", c: "#c0c0d8" },
  Rare: { t: "R", c: "#6fb6ff" },
  "N-Rare": { t: "N", c: "#9aa2b1" },
  Normal: { t: "N", c: "#9aa2b1" },
};
const groupBy = (list) => {
  const m = new Map();
  list.forEach((c) => m.set(c.name, { card: c, n: (m.get(c.name)?.n || 0) + 1 }));
  return [...m.values()];
};

/* ====================================================================== */
/*  DECK EDITOR                                                            */
/* ====================================================================== */
function Editor({ main, extra, side, setMain, setExtra, setSide, addCard, removeOne, countOf, flash }) {
  const [q, setQ] = useState("");
  const [cat, setCat] = useState("");
  const [attr, setAttr] = useState("");
  const [level, setLevel] = useState("");
  const [results, setResults] = useState([]);
  const [loading, setLoading] = useState(false);
  const [dest, setDest] = useState("auto");     // auto | side
  const [mdOnly, setMdOnly] = useState(true);    // restrict pool to the Master Duel card set
  const [set, setSet] = useState("");            // browse a specific printed set (e.g. Chaos Origins)
  const [preview, setPreview] = useState(null);
  const [pinned, setPinned] = useState(false);   // keep a card in the inspector while browsing
  const [savedNames, setSavedNames] = useState([]);
  const debounce = useRef(null);
  const fileRef = useRef(null);

  useEffect(() => { (async () => setSavedNames((await store.get("deck_index")) || []))(); }, []);

  const runSearch = useCallback(async () => {
    if (!q && !cat && !attr && !level && !set) { setResults([]); return; }
    setLoading(true);
    const p = new URLSearchParams();
    if (q) p.set("fname", q);
    if (cat) p.set("type", cat);
    if (attr) p.set("attribute", attr);
    if (level) p.set("level", level);
    if (set) p.set("cardset", set);               // browse a specific printed set
    else if (mdOnly) p.set("format", "master duel"); // otherwise the Master Duel legal pool
    p.set("misc", "yes");                          // pulls md_rarity / formats
    p.set("num", set ? "120" : "80"); p.set("offset", "0");
    try {
      const r = await fetch(`${API}?${p.toString()}`);
      const j = await r.json();
      setResults((j.data || []).map(normalize));
    } catch { setResults([]); flash("Search unavailable offline"); }
    setLoading(false);
  }, [q, cat, attr, level, mdOnly, set]);

  useEffect(() => {
    clearTimeout(debounce.current);
    debounce.current = setTimeout(runSearch, 320);
    return () => clearTimeout(debounce.current);
  }, [q, cat, attr, level, mdOnly, set, runSearch]);

  const total = main.length;
  const mainGroups = useMemo(() => groupBy(main), [main]);
  const extraGroups = useMemo(() => groupBy(extra), [extra]);
  const sideGroups = useMemo(() => groupBy(side), [side]);

  /* .ydk export / import */
  const exportYdk = () => {
    const body =
      "#created by YGO Practice Lab\n#main\n" +
      main.map((c) => c.id).join("\n") +
      "\n#extra\n" + extra.map((c) => c.id).join("\n") +
      "\n!side\n" + side.map((c) => c.id).join("\n") + "\n";
    const url = URL.createObjectURL(new Blob([body], { type: "text/plain" }));
    const a = document.createElement("a");
    a.href = url; a.download = "deck.ydk"; a.click();
    URL.revokeObjectURL(url);
  };
  const importYdk = async (file) => {
    const text = await file.text();
    const sec = { main: [], extra: [], side: [] };
    let cur = "main";
    text.split(/\r?\n/).forEach((ln) => {
      ln = ln.trim();
      if (/^#main/i.test(ln)) cur = "main";
      else if (/^#extra/i.test(ln)) cur = "extra";
      else if (/^!side/i.test(ln)) cur = "side";
      else if (/^\d+$/.test(ln)) sec[cur].push(ln);
    });
    const ids = [...new Set([...sec.main, ...sec.extra, ...sec.side])];
    let byId = {};
    try {
      const r = await fetch(`${API}?misc=yes&id=${ids.join(",")}`);
      const j = await r.json();
      (j.data || []).forEach((c) => (byId[c.id] = normalize(c)));
    } catch { flash("Couldn't fetch card data (offline)"); }
    const build = (arr) => arr.map((id) => byId[id] || { id, name: `#${id}`, frameType: "effect", type: "?", level: null, desc: "" }).filter(Boolean);
    setMain(build(sec.main)); setExtra(build(sec.extra)); setSide(build(sec.side));
    flash(`Imported ${sec.main.length}+${sec.extra.length}+${sec.side.length}`);
  };

  const saveDeck = async () => {
    const name = prompt("Save deck as:");
    if (!name) return;
    await store.set(`deck:${name}`, JSON.stringify({ main, extra, side }));
    const idx = [...new Set([...(await store.get("deck_index") || []), name])];
    await store.set("deck_index", idx); setSavedNames(idx); flash("Saved");
  };
  const loadDeck = async (name) => {
    const raw = await store.get(`deck:${name}`);
    if (!raw) return;
    const d = JSON.parse(raw);
    setMain(d.main || []); setExtra(d.extra || []); setSide(d.side || []);
    flash(`Loaded ${name}`);
  };

  const hover = (c) => { if (!pinned) setPreview(c); };

  return (
    <div style={{ display: "grid", gridTemplateColumns: "272px minmax(0,1fr) minmax(300px,.92fr)", height: "calc(100vh - 60px)", background: MD.bg }}>
      {/* ---- left: full card inspector (Master Duel style) ---- */}
      <aside style={{ borderRight: `1px solid ${MD.line}`, padding: 14, overflowY: "auto", background: `linear-gradient(180deg, ${MD.panel}, ${MD.bg})` }}>
        <div style={{ display: "flex", justifyContent: "flex-end", marginBottom: 6 }}>
          <button onClick={() => setPinned((p) => !p)} title="Pin keeps this card in view while you browse the pool"
            style={{ background: pinned ? "rgba(232,184,75,.16)" : "transparent", border: `1px solid ${pinned ? MD.gold : MD.line}`, color: pinned ? MD.gold : C.mute, borderRadius: 6, padding: "3px 9px", fontSize: 10.5 }}>
            {pinned ? "📌 Pinned" : "📌 Pin"}
          </button>
        </div>
        <CardInspector card={preview} />
        <DeckAnalysis main={main} extra={extra} side={side} />
      </aside>

      {/* ---- centre: the deck being built ---- */}
      <section style={{ display: "flex", flexDirection: "column", minWidth: 0, borderRight: `1px solid ${MD.line}` }}>
        <div style={{ padding: "10px 14px", borderBottom: `1px solid ${MD.line}`, display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center" }}>
          <span className="disp" style={{ fontSize: 13, color: MD.gold, marginRight: 4 }}>Deck</span>
          <button onClick={saveDeck} style={mdBtn()}>Save</button>
          <select onChange={(e) => e.target.value && loadDeck(e.target.value)} value="" style={{ ...inp(), maxWidth: 120 }}>
            <option value="">Load…</option>
            {savedNames.map((n) => <option key={n} value={n}>{n}</option>)}
          </select>
          <button onClick={() => fileRef.current?.click()} style={mdBtn()}>Import .ydk</button>
          <button onClick={exportYdk} style={mdBtn()}>Export</button>
          <button onClick={() => { setMain(shuffle([...main])); flash("Deck shuffled"); }} style={mdBtn()}>Shuffle</button>
          <button onClick={() => { setMain([]); setExtra([]); setSide([]); }} style={{ ...mdBtn(), borderColor: C.bad, color: C.bad }}>Clear</button>
          <input ref={fileRef} type="file" accept=".ydk,.txt" style={{ display: "none" }}
            onChange={(e) => e.target.files[0] && importYdk(e.target.files[0])} />
        </div>

        <div style={{ overflowY: "auto", flex: 1, padding: 14 }}>
          <DeckSection title="Main Deck" count={main.length} min={40} max={60}
            groups={mainGroups} onRemove={(n) => removeOne(main, setMain, n)} onHover={hover} />
          <DeckSection title="Extra Deck" count={extra.length} min={0} max={15}
            groups={extraGroups} onRemove={(n) => removeOne(extra, setExtra, n)} onHover={hover} />
          <DeckSection title="Side Deck" count={side.length} min={0} max={15}
            groups={sideGroups} onRemove={(n) => removeOne(side, setSide, n)} onHover={hover} />
        </div>
      </section>

      {/* ---- right: searchable card pool ---- */}
      <section style={{ display: "flex", flexDirection: "column", minWidth: 0 }}>
        <div style={{ padding: "12px 14px", borderBottom: `1px solid ${MD.line}`, display: "flex", flexDirection: "column", gap: 8 }}>
          <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
            <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search card name…" style={inp(1, "120px")} />
            <button onClick={() => setMdOnly((v) => !v)} className="disp" title="Restrict to the Master Duel card set"
              style={{ fontSize: 10, padding: "6px 10px", borderRadius: 6, border: `1px solid ${mdOnly ? MD.gold : MD.line}`, background: mdOnly ? "rgba(232,184,75,.16)" : "transparent", color: mdOnly ? MD.gold : C.mute, whiteSpace: "nowrap" }}>
              MD only
            </button>
          </div>
          {/* browse a specific printed set */}
          <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
            <input value={set} onChange={(e) => setSet(e.target.value)} placeholder="Browse a set (e.g. Chaos Origins)…" style={inp(1, "120px")} />
            {SET_CHIPS.map((s) => (
              <button key={s} onClick={() => setSet(set === s ? "" : s)} className="disp"
                style={{ fontSize: 10, padding: "6px 9px", borderRadius: 6, border: `1px solid ${set === s ? MD.accent : MD.line}`, background: set === s ? "rgba(109,141,255,.18)" : "transparent", color: set === s ? MD.accent : C.mute, whiteSpace: "nowrap" }}>
                {s}
              </button>
            ))}
            {set && <button onClick={() => setSet("")} style={{ ...mdBtn(), padding: "4px 8px", fontSize: 10, color: C.bad, borderColor: C.bad }}>clear set</button>}
          </div>
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
            <select value={cat} onChange={(e) => setCat(e.target.value)} style={inp()}>
              {CATS.map(([v, l]) => <option key={l} value={v}>{l}</option>)}
            </select>
            <select value={attr} onChange={(e) => setAttr(e.target.value)} style={inp()}>
              {ATTRS.map((a) => <option key={a} value={a}>{a || "Any attr"}</option>)}
            </select>
            <select value={level} onChange={(e) => setLevel(e.target.value)} style={inp()}>
              <option value="">Any Lv</option>
              {Array.from({ length: 12 }, (_, i) => i + 1).map((l) => <option key={l} value={l}>Lv/Rk {l}</option>)}
            </select>
            <div style={{ marginLeft: "auto", display: "flex", gap: 4, alignItems: "center" }}>
              {["auto", "side"].map((d) => (
                <button key={d} onClick={() => setDest(d)} className="disp"
                  style={{ fontSize: 10, padding: "5px 9px", borderRadius: 5, border: `1px solid ${dest === d ? MD.gold : MD.line}`, background: dest === d ? "rgba(232,184,75,.14)" : "transparent", color: dest === d ? MD.gold : C.mute }}>
                  {d === "auto" ? "→ Main/Extra" : "→ Side"}
                </button>
              ))}
            </div>
          </div>
        </div>

        <div style={{ overflowY: "auto", padding: 12, flex: 1 }}>
          {loading && <p className="mono" style={{ color: C.mute, fontSize: 12 }}>searching…</p>}
          {!loading && results.length === 0 && <EmptyHint mdOnly={mdOnly} />}
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill,minmax(72px,1fr))", gap: 7 }}>
            {results.map((c) => (
              <CardTile key={c.id + c.name} card={c}
                badge={countOf(main, c.name) + countOf(extra, c.name) + countOf(side, c.name)}
                onClick={() => addCard(c, dest === "side" ? "side" : undefined)}
                onHover={() => hover(c)} />
            ))}
          </div>
        </div>
      </section>
    </div>
  );
}

/* Master Duel deck-editor palette (deep navy / violet) */
const MD = { bg: "#0b0e1a", panel: "#141a30", panel2: "#1c2440", line: "#2c3556", gold: "#e8c25a", accent: "#6d8dff" };
/* quick-pick set names for the pool browser */
const SET_CHIPS = ["Chaos Origins", "Battle of Chaos"];
const mdBtn = () => ({ background: MD.panel2, border: `1px solid ${MD.line}`, color: C.text, borderRadius: 6, padding: "7px 11px", fontSize: 12 });

/* left-hand inspector — big art, stats, effect text, MD rarity */
function CardInspector({ card }) {
  if (!card) return (
    <div style={{ color: C.mute, fontSize: 12.5, lineHeight: 1.6, marginTop: 30, textAlign: "center" }}>
      <div style={{ fontSize: 40, opacity: .25 }}>🂠</div>
      <p className="disp" style={{ color: MD.gold, fontSize: 12, margin: "10px 0 6px" }}>Card details</p>
      Hover any card in your deck or the pool to inspect it here.
    </div>
  );
  const f = FRAME[frameKey(card.frameType)];
  const rar = card.rarity ? RARITY[card.rarity] : null;
  return (
    <div>
      <div style={{ borderRadius: 8, overflow: "hidden", border: `2px solid ${f.bg}`, boxShadow: `0 8px 26px rgba(0,0,0,.55)` }}>
        <CardImg id={card.id} variant="full" name={card.name} frameType={card.frameType} style={{ width: "100%", aspectRatio: "0.686", display: "block", background: MD.panel2, objectFit: "cover" }} />
      </div>
      <div style={{ marginTop: 10, display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
        <span style={{ fontSize: 14, fontWeight: 800, lineHeight: 1.2 }}>{card.name}</span>
        {rar && <span className="mono" style={{ fontSize: 9, fontWeight: 700, color: "#1a1206", background: rar.c, borderRadius: 4, padding: "1px 5px" }}>{rar.t}</span>}
      </div>
      <div className="mono" style={{ fontSize: 10.5, color: f.bg, marginTop: 4, textTransform: "uppercase", letterSpacing: ".04em" }}>{card.type}</div>
      <div className="mono" style={{ fontSize: 11, color: C.mute, marginTop: 4, display: "flex", gap: 10, flexWrap: "wrap" }}>
        {card.attribute && <span>{card.attribute}</span>}
        {card.race && <span>{card.race}</span>}
        {card.level != null && <span>{isExtra(card.frameType) && /link/i.test(card.frameType) ? "LINK" : "Lv/Rk"} {card.level}</span>}
      </div>
      {card.atk != null && (
        <div className="mono" style={{ fontSize: 13, color: MD.gold, marginTop: 6, fontWeight: 700 }}>ATK {card.atk} / DEF {card.def ?? "—"}</div>
      )}
      {(card.banTcg || card.banOcg) && (
        <div className="mono" style={{ fontSize: 10, color: C.bad, marginTop: 6 }}>
          {card.banTcg ? `TCG: ${card.banTcg}` : ""}{card.banTcg && card.banOcg ? " · " : ""}{card.banOcg ? `OCG: ${card.banOcg}` : ""}
        </div>
      )}
      <div style={{ fontSize: 11.5, color: "#c8cee0", marginTop: 10, lineHeight: 1.5, whiteSpace: "pre-wrap" }}>{card.desc}</div>
    </div>
  );
}

/* live deck analysis — the kind of at-a-glance breakdown a deck-testing tool
   should have: monster/spell/trap split, level-rank curve, attributes, legality */
function DeckAnalysis({ main, extra, side }) {
  const s = useMemo(() => {
    const kind = (c) => frameKey(c.frameType);
    const isST = (c) => kind(c) === "spell" || kind(c) === "trap";
    const monsters = main.filter((c) => !isST(c));
    const levels = {}, attrs = {};
    monsters.forEach((c) => {
      const l = c.level ?? 0; if (l) levels[l] = (levels[l] || 0) + 1;
      if (c.attribute) attrs[c.attribute] = (attrs[c.attribute] || 0) + 1;
    });
    return {
      monsters: monsters.length,
      spells: main.filter((c) => kind(c) === "spell").length,
      traps: main.filter((c) => kind(c) === "trap").length,
      levels, attrs,
    };
  }, [main]);
  const mainOK = main.length >= 40 && main.length <= 60;
  const legal = mainOK && extra.length <= 15 && side.length <= 15;
  const maxLv = Math.max(1, ...Object.values(s.levels));
  const row = (label, val, tone) => (
    <div style={{ display: "flex", justifyContent: "space-between", fontSize: 11.5 }}>
      <span style={{ color: C.mute }}>{label}</span>
      <span style={{ color: tone || C.text, fontWeight: 700 }}>{val}</span>
    </div>
  );
  return (
    <div style={{ marginTop: 18, borderTop: `1px solid ${MD.line}`, paddingTop: 14 }}>
      <div className="disp" style={{ fontSize: 11, color: MD.gold, marginBottom: 8 }}>Deck Analysis</div>
      <div style={{ display: "flex", flexDirection: "column", gap: 3, marginBottom: 8 }}>
        {row("Monsters", s.monsters, "#e0a94a")}
        {row("Spells", s.spells, "#2fa6a0")}
        {row("Traps", s.traps, "#c05aa0")}
        {row("Main / Extra / Side", `${main.length} / ${extra.length} / ${side.length}`)}
      </div>
      <div className="mono" style={{ fontSize: 10.5, color: legal ? C.good : C.bad, marginBottom: 10 }}>
        {legal ? "✓ Legal deck sizes" : `⚠ ${!mainOK ? `Main ${main.length} (need 40–60)` : extra.length > 15 ? "Extra Deck > 15" : "Side Deck > 15"}`}
      </div>
      {Object.keys(s.levels).length > 0 && (
        <div style={{ marginBottom: 10 }}>
          <div className="mono" style={{ fontSize: 9.5, color: C.mute, marginBottom: 4, letterSpacing: ".08em" }}>LEVEL / RANK CURVE</div>
          {Object.keys(s.levels).map(Number).sort((a, b) => a - b).map((lv) => (
            <div key={lv} style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 2 }}>
              <span className="mono" style={{ fontSize: 10, color: C.mute, width: 18, textAlign: "right" }}>{lv}</span>
              <div style={{ flex: 1, height: 9, background: MD.panel2, borderRadius: 3, overflow: "hidden" }}>
                <div style={{ width: `${(s.levels[lv] / maxLv) * 100}%`, height: "100%", background: MD.gold, transition: "width .3s" }} />
              </div>
              <span className="mono" style={{ fontSize: 10, color: C.text, width: 14 }}>{s.levels[lv]}</span>
            </div>
          ))}
        </div>
      )}
      {Object.keys(s.attrs).length > 0 && (
        <div>
          <div className="mono" style={{ fontSize: 9.5, color: C.mute, marginBottom: 4, letterSpacing: ".08em" }}>ATTRIBUTES</div>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 4 }}>
            {Object.entries(s.attrs).sort((a, b) => b[1] - a[1]).map(([a, n]) => (
              <span key={a} className="mono" style={{ fontSize: 10, color: C.text, background: MD.panel2, border: `1px solid ${MD.line}`, borderRadius: 4, padding: "2px 6px" }}>{a} {n}</span>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function EmptyHint({ mdOnly }) {
  return (
    <div style={{ color: C.mute, fontSize: 12.5, lineHeight: 1.6 }}>
      <p className="disp" style={{ color: MD.gold, fontSize: 12, marginBottom: 6 }}>Search the pool</p>
      Type a name or filter by type / attribute / level. {mdOnly ? "Showing only cards in the Master Duel set — " : "Showing the full card database — "}
      toggle <b>MD only</b> to switch. Click a card to add it; Extra-Deck monsters route automatically.
    </div>
  );
}

/* one deck zone rendered as an image grid, like Master Duel's edit screen */
function DeckSection({ title, count, min, max, groups, onRemove, onHover }) {
  const ok = count >= min && count <= max;
  return (
    <div style={{ marginBottom: 16 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
        <span className="disp" style={{ fontSize: 12, color: C.text }}>{title}</span>
        <span className="mono" style={{ fontSize: 11, color: ok ? C.good : C.mute, border: `1px solid ${ok ? C.good : MD.line}`, borderRadius: 20, padding: "1px 8px" }}>
          {count}{max ? `/${max}` : ""}
        </span>
        <div style={{ flex: 1, height: 1, background: MD.line }} />
      </div>
      {groups.length === 0 && <p className="mono" style={{ fontSize: 11, color: C.mute }}>empty</p>}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill,minmax(58px,1fr))", gap: 6 }}>
        {groups.map(({ card, n }) => (
          <DeckCell key={card.name} card={card} n={n} onRemove={() => onRemove(card.name)} onHover={() => onHover(card)} />
        ))}
      </div>
    </div>
  );
}

function DeckCell({ card, n, onRemove, onHover }) {
  const f = FRAME[frameKey(card.frameType)];
  return (
    <button onClick={onRemove} onMouseEnter={onHover} title={`${card.name} — click to remove one`}
      className="cardimg" style={{ position: "relative", border: `1px solid ${shade(f.bg, 10)}`, borderRadius: 5, overflow: "hidden", padding: 0, aspectRatio: "0.686", background: `linear-gradient(155deg, ${shade(f.bg, 8)}, ${shade(f.bg, -36)})`, cursor: "pointer" }}>
      <CardImg id={card.id} variant="small" name={card.name} frameType={card.frameType} style={{ width: "100%", height: "100%", objectFit: "cover", display: "block" }} />
      {n > 1 && <span className="mono" style={{ position: "absolute", bottom: 2, right: 2, background: "rgba(0,0,0,.78)", color: MD.gold, fontSize: 10, fontWeight: 700, borderRadius: 4, padding: "0 4px" }}>×{n}</span>}
    </button>
  );
}

function CardTile({ card, badge, onClick, onHover }) {
  const f = FRAME[frameKey(card.frameType)];
  const rar = card.rarity ? RARITY[card.rarity] : null;
  return (
    <button onClick={onClick} onMouseEnter={onHover} title={card.name}
      style={{ position: "relative", border: "none", background: "transparent", padding: 0 }}>
      <div className="cardimg" style={{ aspectRatio: "0.686", borderRadius: 5, overflow: "hidden", border: `1px solid ${f.bg}`, background: `linear-gradient(155deg, ${shade(f.bg, 10)}, ${shade(f.bg, -34)})` }}>
        <CardImg id={card.id} variant="small" name={card.name} frameType={card.frameType} style={{ width: "100%", height: "100%", objectFit: "cover", display: "block" }} />
      </div>
      {rar && <span className="mono" style={{ position: "absolute", bottom: 2, left: 2, background: rar.c, color: "#1a1206", fontSize: 8, fontWeight: 700, borderRadius: 3, padding: "0 3px" }}>{rar.t}</span>}
      {badge > 0 && (
        <span className="mono" style={{ position: "absolute", top: 2, right: 2, background: MD.gold, color: "#1a1206", fontSize: 9, fontWeight: 700, borderRadius: 10, padding: "0 5px" }}>{badge}</span>
      )}
    </button>
  );
}

/* ---- 3D pop-out card: monster rises out of the frame & tilts ---------- */
function PopCard({ card, size = 158 }) {
  const ref = useRef(null);
  const [t, setT] = useState({ rx: 0, ry: 0, gx: 50, gy: 30, on: false });
  const [imgOk, setImgOk] = useState(true);
  const f = FRAME[frameKey(card.frameType)];
  const w = size, h = size / 0.686;
  const art = IMG_CROP(card.id);

  const move = (e) => {
    if (REDUCED) return;
    const r = ref.current?.getBoundingClientRect();
    if (!r) return;
    const px = (e.clientX - r.left) / r.width, py = (e.clientY - r.top) / r.height;
    setT({ rx: (0.5 - py) * 15, ry: (px - 0.5) * 15, gx: px * 100, gy: py * 100, on: true });
  };
  const leave = () => setT((s) => ({ ...s, rx: 0, ry: 0, on: false }));

  const statLine = card.atk != null
    ? `${card.type?.split(" ")[0] || ""} · ATK ${card.atk} / DEF ${card.def ?? "—"}`
    : (card.type || "");

  return (
    <div style={{ perspective: 950, width: w }}>
      <div ref={ref} onMouseMove={move} onMouseLeave={leave}
        style={{
          position: "relative", width: w, height: h, transformStyle: "preserve-3d",
          transform: `rotateX(${t.rx}deg) rotateY(${t.ry}deg)`,
          transition: t.on ? "none" : "transform .55s cubic-bezier(.2,.8,.2,1)",
        }}>
        {/* card body */}
        <div style={{
          position: "absolute", inset: 0, borderRadius: 11, overflow: "hidden",
          background: `linear-gradient(158deg, ${shade(f.bg, 18)}, ${shade(f.bg, -34)})`,
          border: `2px solid ${shade(f.bg, 40)}`,
          boxShadow: `0 ${12 + Math.abs(t.rx) + Math.abs(t.ry)}px 30px rgba(0,0,0,.55)`,
        }}>
          {/* recessed art slot (monster emerges from here) */}
          <div style={{ position: "absolute", left: "7%", right: "7%", top: "6%", height: "68%", borderRadius: 4, background: `radial-gradient(120% 90% at 50% 20%, ${shade(f.bg,-20)}, #05070b)`, boxShadow: "inset 0 6px 14px rgba(0,0,0,.6)" }} />
          {/* name / stat plate */}
          <div style={{ position: "absolute", left: "6%", right: "6%", top: "75.5%", bottom: "4.5%", background: "rgba(4,6,10,.5)", borderRadius: 4, padding: "5% 6%", display: "flex", flexDirection: "column", justifyContent: "center" }}>
            <div style={{ fontWeight: 800, fontSize: w * 0.082, color: f.fg, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", letterSpacing: ".01em" }}>{card.name}</div>
            <div className="mono" style={{ fontSize: w * 0.052, color: f.fg, opacity: .8, marginTop: 3, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
              {card.level != null ? `Lv/Rk ${card.level} · ` : ""}{statLine}
            </div>
          </div>
        </div>

        {/* POP-OUT monster — same art, floated forward and above the frame */}
        {imgOk ? (
          <img src={art} alt={card.name} onError={() => setImgOk(false)}
            style={{
              position: "absolute", left: "7%", right: "7%", top: "-16%", height: "90%",
              width: "86%", objectFit: "cover", objectPosition: "top", borderRadius: 4,
              transform: `translateZ(42px) rotateX(${t.rx * 0.25}deg) rotateY(${t.ry * 0.25}deg) scale(${t.on ? 1.03 : 1})`,
              transition: t.on ? "none" : "transform .55s cubic-bezier(.2,.8,.2,1)",
              filter: `drop-shadow(0 12px 12px rgba(0,0,0,.55))`,
              pointerEvents: "none",
              WebkitMaskImage: "linear-gradient(to bottom,#000 58%,transparent 90%)",
              maskImage: "linear-gradient(to bottom,#000 58%,transparent 90%)",
            }} />
        ) : (
          <div className="disp" style={{ position: "absolute", left: "7%", right: "7%", top: "6%", height: "68%", display: "grid", placeItems: "center", textAlign: "center", fontSize: w * 0.07, color: f.fg, opacity: .85, padding: "0 6%" }}>{card.name}</div>
        )}

        {/* holographic glare */}
        <div style={{
          position: "absolute", inset: 0, borderRadius: 11, pointerEvents: "none",
          background: `radial-gradient(circle at ${t.gx}% ${t.gy}%, rgba(255,255,255,.35), transparent 46%)`,
          mixBlendMode: "overlay", opacity: t.on ? 1 : 0, transition: "opacity .3s",
        }} />
      </div>
    </div>
  );
}

/* ====================================================================== */
/*  TEST HAND (goldfish)                                                   */
/* ====================================================================== */
function HandTester({ main }) {
  const [onPlay, setOnPlay] = useState(true);
  const [hand, setHand] = useState([]);
  const [deck, setDeck] = useState([]);
  const [drawn, setDrawn] = useState(0);

  const openingSize = onPlay ? 5 : 6;

  const newHand = useCallback(() => {
    const shuffled = shuffle([...main]);
    setHand(shuffled.slice(0, openingSize));
    setDeck(shuffled.slice(openingSize));
    setDrawn(0);
  }, [main, openingSize]);

  useEffect(() => { if (main.length) newHand(); }, [onPlay, main.length]); // reshuffle on toggle

  const drawOne = () => {
    if (!deck.length) return;
    setHand((h) => [...h, deck[0]]);
    setDeck((d) => d.slice(1));
    setDrawn((n) => n + 1);
  };

  if (!main.length) return <Center>Build a deck first — the Deck Editor tab.</Center>;

  return (
    <div style={{ padding: 20, height: "calc(100vh - 60px)", overflowY: "auto" }}>
      <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap", marginBottom: 18 }}>
        <button onClick={newHand} className="disp" style={{ ...btn(), background: C.gold, color: "#1a1206", border: "none", fontSize: 12, padding: "9px 18px" }}>New Hand</button>
        <button onClick={drawOne} style={btn()} disabled={!deck.length}>Draw 1 ({deck.length} left)</button>
        <div style={{ display: "flex", border: `1px solid ${C.line}`, borderRadius: 6, overflow: "hidden" }}>
          {[["Going 1st", true], ["Going 2nd", false]].map(([l, v]) => (
            <button key={l} onClick={() => setOnPlay(v)} className="mono"
              style={{ fontSize: 11, padding: "8px 12px", border: "none", background: onPlay === v ? C.panel2 : "transparent", color: onPlay === v ? C.gold : C.mute }}>{l}</button>
          ))}
        </div>
        <span className="mono" style={{ color: C.mute, fontSize: 11, marginLeft: "auto" }}>
          opening {openingSize}{drawn ? ` +${drawn} drawn` : ""}
        </span>
      </div>

      <div style={{ display: "flex", gap: 18, flexWrap: "wrap", justifyContent: "center", alignItems: "flex-end", padding: "56px 0 40px" }}>
        {hand.map((c, i) => (
          <div key={i} style={{ transform: `rotate(${(i - (hand.length - 1) / 2) * 2.2}deg)`, transformOrigin: "bottom center" }}>
            <PopCard card={c} size={162} />
          </div>
        ))}
      </div>
      <p className="mono" style={{ textAlign: "center", color: C.mute, fontSize: 11 }}>
        Draw repeatedly to feel your deck's consistency, or jump to Probability for hard numbers.
      </p>
    </div>
  );
}

/* ====================================================================== */
/*  PROBABILITY (Monte-Carlo opening simulator)                           */
/* ====================================================================== */
function Probability({ main }) {
  const groups = useMemo(() => groupBy(main), [main]);
  const [starters, setStarters] = useState(() => new Set());
  const [handSize, setHandSize] = useState(5);
  const [trials, setTrials] = useState(100000);
  const [res, setRes] = useState(null);

  const toggle = (name) =>
    setStarters((s) => { const n = new Set(s); n.has(name) ? n.delete(name) : n.add(name); return n; });

  const run = () => {
    const deck = main.map((c) => (starters.has(c.name) ? 1 : 0));
    const N = deck.length;
    if (N < handSize) return;
    let openAtLeast1 = 0, brick = 0, sum = 0;
    const dist = [0, 0, 0, 0]; // 0,1,2,3+
    const arr = deck.slice();
    for (let t = 0; t < trials; t++) {
      // partial Fisher-Yates for the first handSize picks
      for (let i = 0; i < handSize; i++) {
        const j = i + Math.floor(Math.random() * (N - i));
        const tmp = arr[i]; arr[i] = arr[j]; arr[j] = tmp;
      }
      let k = 0;
      for (let i = 0; i < handSize; i++) k += arr[i];
      sum += k;
      if (k >= 1) openAtLeast1++; else brick++;
      dist[Math.min(k, 3)]++;
    }
    setRes({
      p1: (openAtLeast1 / trials) * 100,
      brick: (brick / trials) * 100,
      avg: sum / trials,
      dist: dist.map((d) => (d / trials) * 100),
      count: main.filter((c) => starters.has(c.name)).length,
    });
  };

  if (!main.length) return <Center>Build a deck first — the Deck Editor tab.</Center>;

  return (
    <div style={{ display: "grid", gridTemplateColumns: "minmax(280px,1fr) minmax(300px,1fr)", height: "calc(100vh - 60px)" }}>
      <section style={{ borderRight: `1px solid ${C.line}`, overflowY: "auto", padding: 18 }}>
        <p className="disp" style={{ fontSize: 12, color: C.gold, marginBottom: 4 }}>1 · Mark your starters</p>
        <p style={{ fontSize: 12, color: C.mute, marginBottom: 14, lineHeight: 1.5 }}>
          Tick every card that, on its own, starts your combo (or that you want to open with). The simulator draws thousands of opening hands and measures how often you hit.
        </p>
        <div style={{ display: "flex", flexDirection: "column", gap: 3 }}>
          {groups.map(({ card, n }) => {
            const on = starters.has(card.name);
            return (
              <button key={card.name} onClick={() => toggle(card.name)}
                style={{ display: "flex", alignItems: "center", gap: 9, textAlign: "left", background: on ? "rgba(232,184,75,.12)" : C.panel, border: `1px solid ${on ? C.gold : "transparent"}`, borderRadius: 6, padding: "5px 8px" }}>
                <span style={{ width: 15, height: 15, borderRadius: 4, border: `1.5px solid ${on ? C.gold : C.line}`, background: on ? C.gold : "transparent", flexShrink: 0, color: "#1a1206", fontSize: 11, textAlign: "center", lineHeight: "13px" }}>{on ? "✓" : ""}</span>
                <CardImg id={card.id} variant="small" name="" frameType={card.frameType} style={{ width: 22, height: 32, borderRadius: 2, objectFit: "cover" }} />
                <span style={{ flex: 1, fontSize: 12.5, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", color: on ? C.text : C.mute }}>{card.name}</span>
                <span className="mono" style={{ fontSize: 11, color: C.mute }}>×{n}</span>
              </button>
            );
          })}
        </div>
      </section>

      <section style={{ padding: 18, overflowY: "auto" }}>
        <p className="disp" style={{ fontSize: 12, color: C.gold, marginBottom: 12 }}>2 · Run the sim</p>
        <div style={{ display: "flex", gap: 10, flexWrap: "wrap", marginBottom: 16, alignItems: "center" }}>
          <label className="mono" style={{ fontSize: 11, color: C.mute }}>hand
            <select value={handSize} onChange={(e) => setHandSize(+e.target.value)} style={{ ...inp(), marginLeft: 6 }}>
              {[5, 6].map((h) => <option key={h} value={h}>{h}</option>)}
            </select>
          </label>
          <label className="mono" style={{ fontSize: 11, color: C.mute }}>trials
            <select value={trials} onChange={(e) => setTrials(+e.target.value)} style={{ ...inp(), marginLeft: 6 }}>
              {[10000, 100000, 500000].map((t) => <option key={t} value={t}>{t.toLocaleString()}</option>)}
            </select>
          </label>
          <button onClick={run} className="disp" style={{ ...btn(), background: C.gold, color: "#1a1206", border: "none", padding: "9px 18px" }}>Simulate</button>
        </div>

        {!res && <p style={{ fontSize: 12, color: C.mute }}>Mark starters, then hit Simulate. Deck size in play: {main.length} cards.</p>}
        {res && res.count === 0 && <p style={{ fontSize: 12, color: C.bad }}>No starters selected.</p>}
        {res && res.count > 0 && (
          <div>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, marginBottom: 20 }}>
              <Stat label="Open ≥1 starter" val={res.p1} good />
              <Stat label="Brick (zero)" val={res.brick} bad />
            </div>
            <div className="mono" style={{ fontSize: 12, color: C.mute, marginBottom: 8 }}>
              {res.count} copies · avg {res.avg.toFixed(2)} starters per opening hand
            </div>
            <div style={{ marginTop: 10 }}>
              {res.dist.map((p, i) => (
                <div key={i} style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6 }}>
                  <span className="mono" style={{ fontSize: 11, color: C.mute, width: 52 }}>{i === 3 ? "3+" : i} in hand</span>
                  <div style={{ flex: 1, height: 16, background: C.panel, borderRadius: 4, overflow: "hidden" }}>
                    <div style={{ width: `${p}%`, height: "100%", background: i === 0 ? C.bad : C.gold, transition: "width .4s" }} />
                  </div>
                  <span className="mono" style={{ fontSize: 11, color: C.text, width: 46, textAlign: "right" }}>{p.toFixed(1)}%</span>
                </div>
              ))}
            </div>
            <p className="mono" style={{ fontSize: 10.5, color: C.mute, marginTop: 16, lineHeight: 1.5 }}>
              Monte-Carlo over {trials.toLocaleString()} shuffles of your {main.length}-card main deck.
              Margin of error at 100k trials is well under ±0.5%.
            </p>
          </div>
        )}
      </section>
    </div>
  );
}

function Stat({ label, val, good, bad }) {
  const col = good ? C.good : bad ? C.bad : C.gold;
  return (
    <div style={{ background: C.panel, border: `1px solid ${C.line}`, borderRadius: 8, padding: "14px 16px" }}>
      <div className="mono" style={{ fontSize: 30, fontWeight: 700, color: col, lineHeight: 1 }}>{val.toFixed(1)}<span style={{ fontSize: 15 }}>%</span></div>
      <div className="mono" style={{ fontSize: 10.5, color: C.mute, marginTop: 6, textTransform: "uppercase", letterSpacing: ".08em" }}>{label}</div>
    </div>
  );
}

/* ====================================================================== */
/*  DUEL BOARD — local hot-seat manual play                               */
/* ====================================================================== */
const PHASES = ["DP", "SP", "M1", "BP", "M2", "EP"];
const PHASE_FULL = { DP: "Draw", SP: "Standby", M1: "Main 1", BP: "Battle", M2: "Main 2", EP: "End" };
const clone = (o) => JSON.parse(JSON.stringify(o));
const isFieldSpell = (c) => /field/i.test(c.race || "") && /spell/i.test(c.type || "");
let UID = 0;
const mkInst = (c) => ({ uid: `i${UID++}`, card: c, pos: "atk", attacked: false });

/* tributes required to Normal Summon a main-deck monster of a given level */
const tributesFor = (card) => {
  if (isExtra(card.frameType) || /spell|trap/.test(card.frameType || "")) return 0;
  const lv = card.level ?? 0;
  return lv >= 7 ? 2 : lv >= 5 ? 1 : 0;
};

function buildSide(main, extra) {
  return {
    lp: 8000, normalSummoned: false,
    deck: shuffle(main.map(mkInst)),
    extra: extra.map(mkInst),
    hand: [], gy: [], banish: [],
    mzones: [null, null, null, null, null],
    szones: [null, null, null, null, null],
    field: null,
  };
}
/* clear per-turn flags for the player whose turn is starting */
function resetTurnFlags(n, p) {
  const pl = n.players[p];
  pl.normalSummoned = false;
  pl.mzones.forEach((m) => m && (m.attacked = false));
  n.emz.forEach((e) => e && e.owner === p && (e.inst.attacked = false));
}
function pull(n, s) {
  const pl = n.players[s.p]; let x = null;
  if (s.loc === "hand") x = pl.hand.splice(s.idx, 1)[0];
  else if (s.loc === "m") { x = pl.mzones[s.idx]; pl.mzones[s.idx] = null; }
  else if (s.loc === "s") { x = pl.szones[s.idx]; pl.szones[s.idx] = null; }
  else if (s.loc === "field") { x = pl.field; pl.field = null; }
  else if (s.loc === "gy") x = pl.gy.splice(s.idx, 1)[0];
  else if (s.loc === "banish") x = pl.banish.splice(s.idx, 1)[0];
  else if (s.loc === "deck") x = pl.deck.splice(s.idx, 1)[0];
  else if (s.loc === "extra") x = pl.extra.splice(s.idx, 1)[0];
  else if (s.loc === "emz") { const e = n.emz[s.idx]; n.emz[s.idx] = null; x = e ? e.inst : null; }
  return x;
}
function placeInst(n, p, kind, idx, inst, pos) {
  const pl = n.players[p];
  inst.pos = pos;
  if (kind === "m") pl.mzones[idx] = inst;
  else if (kind === "s") pl.szones[idx] = inst;
  else if (kind === "field") pl.field = inst;
  else if (kind === "emz") n.emz[idx] = { inst, owner: p };
}

/* ---- heuristic AI + move coach (rules-level; effects stay manual) ------ */
const ownMonsters = (g, p) => {
  const out = [];
  g.players[p].mzones.forEach((m, i) => m && out.push({ p, loc: "m", idx: i, inst: m }));
  g.emz.forEach((e, i) => e && e.owner === p && out.push({ p, loc: "emz", idx: i, inst: e.inst }));
  return out;
};
/* best Normal Summon for player p: highest-ATK main-deck monster that's
   summonable now (tributing lowest-ATK monsters only when it's an upgrade) */
function aiBestSummon(g, p) {
  const pl = g.players[p];
  if (pl.normalSummoned) return null;
  const field = ownMonsters(g, p);
  const emptyMZ = pl.mzones.filter((z) => !z).length;
  const cands = [];
  pl.hand.forEach((inst, hi) => {
    const c = inst.card;
    const isMon = frameKey(c.frameType) && !/spell|trap/.test(c.frameType || "");
    if (!isMon || isExtra(c.frameType)) return;
    const need = tributesFor(c);
    if (need === 0) { if (emptyMZ > 0) cands.push({ handIdx: hi, tributes: [], atk: c.atk ?? 0, need }); }
    else if (field.length >= need) {
      const trib = [...field].sort((a, b) => (a.inst.card.atk ?? 0) - (b.inst.card.atk ?? 0)).slice(0, need).map((o) => o.idx);
      cands.push({ handIdx: hi, tributes: trib, atk: c.atk ?? 0, need });
    }
  });
  if (!cands.length) return null;
  cands.sort((a, b) => b.atk - a.atk);
  const best = cands[0];
  if (best.need > 0) {
    const maxField = Math.max(0, ...field.map((o) => o.inst.card.atk ?? 0));
    if (best.atk <= maxField) return null; // not worth tributing down
  }
  return { ...best, pos: "atk" };
}
/* choose an attack for attacker aSel: destroy the biggest thing it safely
   beats, attack directly if the lane is open, otherwise hold back */
function aiPickAttack(g, me, aSel) {
  const opp = 1 - me, aAtk = getAt(g, aSel).card.atk ?? 0;
  const targets = ownMonsters(g, opp);
  if (!targets.length) return { kind: "direct" };
  let best = null, bestScore = -Infinity;
  targets.forEach((t) => {
    const def = t.inst.pos === "atk" ? (t.inst.card.atk ?? 0) : (t.inst.card.def ?? 0);
    let score;
    if (t.inst.pos === "atk") score = aAtk > def ? 100 + (aAtk - def) : aAtk === def ? -50 : -100 - (def - aAtk);
    else score = aAtk > def ? 60 + (aAtk - def) : aAtk === def ? -10 : -80 - (def - aAtk);
    if (score > bestScore) { bestScore = score; best = t; }
  });
  if (bestScore < 0) return { kind: "skip" };
  return { kind: "battle", tSel: { p: opp, loc: best.loc, idx: best.idx } };
}
const getAt = (g, s) => s.loc === "emz" ? g.emz[s.idx]?.inst : g.players[s.p][s.loc + "zones"][s.idx];

/* coaching tips for the human (player 0) at the current state */
function coachTips(g) {
  if (!g || g.winner != null) return [];
  const me = 0, opp = 1, pl = g.players[me], op = g.players[opp];
  if (g.active !== me) return [{ t: "info", m: "Opponent's turn — watch for their attacks and set traps if you have them." }];
  const tips = [];
  const atkMons = ownMonsters(g, me).filter((o) => o.inst.pos === "atk");
  const oppMons = ownMonsters(g, opp);
  const mainPhase = g.phase === "M1" || g.phase === "M2";
  if (mainPhase && !pl.normalSummoned) {
    const best = aiBestSummon(g, me);
    if (best) { const c = pl.hand[best.handIdx].card; tips.push({ t: "good", m: `Normal Summon ${c.name} (ATK ${c.atk ?? 0})${best.tributes.length ? ` — tribute ${best.tributes.length}` : ""}.` }); }
    else if (pl.hand.some((i) => /trap/i.test(i.card.type || ""))) tips.push({ t: "info", m: "Set a Trap face-down to protect your board." });
  }
  if (g.phase !== "BP" && g.turn > 1 && atkMons.some((o) => !o.inst.attacked)) tips.push({ t: "info", m: "Advance to the Battle Phase (Next ▸) to attack." });
  if (g.phase === "BP") {
    const unatt = atkMons.filter((o) => !o.inst.attacked);
    const total = unatt.reduce((s, o) => s + (o.inst.card.atk ?? 0), 0);
    if (!oppMons.length && unatt.length) tips.push({ t: "good", m: total >= op.lp ? `LETHAL — attack directly for ${total} (they have ${op.lp} LP).` : `Open field — attack directly for ${total} damage.` });
    unatt.forEach((o) => {
      const a = o.inst.card.atk ?? 0;
      if (!oppMons.length) return;
      const beatable = oppMons.filter((t) => (t.inst.pos === "atk" ? (t.inst.card.atk ?? 0) : (t.inst.card.def ?? 0)) < a);
      if (beatable.length) { const big = beatable.sort((x, y) => (y.inst.card.atk ?? 0) - (x.inst.card.atk ?? 0))[0]; tips.push({ t: "good", m: `${o.inst.card.name} (ATK ${a}) can safely destroy ${big.inst.card.name}.` }); }
      else { const small = [...oppMons].sort((x, y) => (x.inst.card.atk ?? 0) - (y.inst.card.atk ?? 0))[0]; if (small.inst.pos === "atk" && (small.inst.card.atk ?? 0) > a) tips.push({ t: "warn", m: `Hold ${o.inst.card.name} (ATK ${a}) — every enemy monster is bigger; attacking loses LP.` }); }
    });
  }
  if (!tips.length) tips.push({ t: "info", m: "No forced play — develop your board, then pass with End Turn." });
  return tips;
}

function DuelBoard({ main, extra }) {
  const [game, setGame] = useState(null);
  const [sel, setSel] = useState(null);
  const [pending, setPending] = useState(null);
  const [attackFrom, setAttackFrom] = useState(null); // {p,loc,idx} of attacking monster
  const [hover, setHover] = useState(null);            // instance under the cursor
  const [viewer, setViewer] = useState(null);
  const [hideHands, setHideHands] = useState(true);
  const [dmg, setDmg] = useState(1000);
  const [vsAI, setVsAI] = useState(true);              // P2 auto-plays
  const [coach, setCoach] = useState(true);            // show move suggestions
  const [fx, setFx] = useState(0);                     // bump to replay the damage flash
  const hist = useRef([]);
  const aiTickRef = useRef(() => {});

  /* drive the AI: when it's P2's turn, take one action on a short timer so
     the player can watch it play out. aiTickRef is refreshed each render. */
  useEffect(() => {
    if (!vsAI || !game || game.winner != null || game.active !== 1 || pending || attackFrom) return;
    const t = setTimeout(() => aiTickRef.current(), 650);
    return () => clearTimeout(t);
  }, [vsAI, game, pending, attackFrom]);

  const start = () => {
    UID = 0;
    const g = { turn: 1, active: 0, firstPlayer: 0, winner: null, phase: "M1",
      log: [{ t: 1, m: "Duel start — P1 goes first (no draw on turn 1)" }],
      emz: [null, null], players: [buildSide(main, extra), buildSide(main, extra)] };
    g.players.forEach((pl) => { for (let i = 0; i < 5; i++) pl.hand.push(pl.deck.shift()); });
    hist.current = []; setGame(g); setSel(null); setPending(null); setAttackFrom(null); setViewer(null);
  };
  const commit = (mut, msg) => {
    if (msg) { // audio + damage flash feedback
      if (msg[0] === "🏆") Sound.sfx("win");
      else if (msg[0] === "⚔") { Sound.sfx("attack"); if (/takes \d/.test(msg)) { setFx((f) => f + 1); setTimeout(() => Sound.sfx("damage"), 150); } }
      else if (/Summon/.test(msg)) Sound.sfx("summon");
      else if (/drew|Draw Phase/.test(msg)) Sound.sfx("draw");
      else if (/Phase/.test(msg)) Sound.sfx("phase");
    }
    setGame((g) => {
      if (!g) return g;
      hist.current.push(clone(g)); if (hist.current.length > 50) hist.current.shift();
      const n = clone(g); mut(n);
      if (msg) n.log = [...n.log, { t: n.turn, m: msg }];
      // win condition: life points hit zero
      if (n.winner == null) {
        if (n.players[0].lp <= 0) { n.winner = 1; n.log.push({ t: n.turn, m: "🏆 P2 wins — P1's LP hit 0" }); }
        else if (n.players[1].lp <= 0) { n.winner = 0; n.log.push({ t: n.turn, m: "🏆 P1 wins — P2's LP hit 0" }); }
      }
      return n;
    });
    setSel(null); setPending(null); setAttackFrom(null);
  };
  const undo = () => { const p = hist.current.pop(); if (p) { setGame(p); setSel(null); setPending(null); setAttackFrom(null); } };

  if (!main.length) return <Center>Build a deck first — the Deck Editor tab.</Center>;
  if (!game) return (
    <div style={{ height: "calc(100vh - 60px)", display: "grid", placeItems: "center", padding: 24 }}>
      <div style={{ textAlign: "center", maxWidth: 440 }}>
        <p className="disp" style={{ color: C.gold, fontSize: 16, marginBottom: 8 }}>Duel · Hot Seat</p>
        <p style={{ color: C.mute, fontSize: 13, lineHeight: 1.6, marginBottom: 20 }}>
          Both sides start with your current deck ({main.length} main / {extra.length} extra), 8000 LP and a 5-card hand.
          The engine enforces the rules like Master Duel — turn/phase flow, the once-per-turn Normal Summon, tribute costs, battle damage, and win by LP-0 or deck-out.
          You still apply individual card <i>effects</i> yourself (that needs the full ygopro engine). Click any card for its legal actions.
        </p>
        <button onClick={start} className="disp" style={{ ...btn(), background: C.gold, color: "#1a1206", border: "none", padding: "12px 30px", fontSize: 14 }}>Start Duel</button>
      </div>
    </div>
  );

  const P = game.players;
  const you = game.active === 0;
  const plabel = (p) => (p === 0 ? "P1" : "P2");

  const zoneInst = (p, kind, idx) =>
    kind === "m" ? P[p].mzones[idx] : kind === "s" ? P[p].szones[idx] : kind === "field" ? P[p].field : kind === "emz" ? game.emz[idx]?.inst : null;
  const getInst = (s) => {
    if (!s) return null;
    const pl = P[s.p];
    return s.loc === "hand" ? pl.hand[s.idx] : s.loc === "gy" ? pl.gy[s.idx] : s.loc === "banish" ? pl.banish[s.idx]
      : s.loc === "deck" ? pl.deck[s.idx] : s.loc === "extra" ? pl.extra[s.idx] : zoneInst(s.p, s.loc, s.idx);
  };

  const isTrib = (p, kind, idx) => (pending?.tribs || []).some((t) => t.p === p && t.loc === kind && t.idx === idx);
  const tributesSatisfied = () => (pending?.tribs?.length || 0) >= (pending?.needTrib || 0);
  const canTribute = (p, kind, idx) => {
    if (!pending || pending.kind !== "mon" || !pending.needTrib) return false;
    if (tributesSatisfied()) return false;
    if (p !== pending.src.p) return false;
    if (!(kind === "m" || kind === "emz")) return false;
    return !!zoneInst(p, kind, idx) && !isTrib(p, kind, idx);
  };
  const canPlace = (p, kind, idx) => {
    if (!pending) return false;
    const pl = P[p];
    if (pending.kind === "mon") {
      if (!tributesSatisfied()) return false;
      const free = (occupied, k) => !occupied || isTrib(p, k, idx);
      return (kind === "m" && p === pending.src.p && free(pl.mzones[idx], "m")) ||
        (kind === "emz" && free(game.emz[idx], "emz"));
    }
    if (pending.kind === "st") return kind === "s" && p === pending.src.p && !pl.szones[idx];
    if (pending.kind === "field") return kind === "field" && p === pending.src.p && !pl.field;
    return false;
  };
  const addTribute = (p, kind, idx) =>
    setPending((prev) => ({ ...prev, tribs: [...(prev.tribs || []), { p, loc: kind, idx }] }));
  const finishPlace = (p, kind, idx) => {
    const inst = getInst(pending.src); const name = inst?.card.name || "card";
    const v = pending.pos === "set" ? "Set" : pending.normal ? "Normal Summoned" : "Special Summoned";
    const verb = pending.kind === "st" ? (pending.pos === "settrap" ? "Set" : "activated") : v;
    const src = pending.src, pos = pending.pos, normal = pending.normal, kindP = pending.kind, tribs = pending.tribs || [];
    commit((n) => {
      tribs.forEach((t) => { const x = pull(n, t); if (x) { x.pos = "atk"; n.players[t.p].gy.push(x); } });
      const x = pull(n, src); if (!x) return;
      x.attacked = false;
      placeInst(n, p, kind, idx, x, pos);
      if (normal && kindP === "mon") n.players[src.p].normalSummoned = true;
    }, `${plabel(src.p)} ${verb} ${name}${tribs.length ? ` (tributing ${tribs.length})` : ""}`);
  };
  /* -------- battle: attacker → target with auto damage calc -------- */
  const beginAttack = (s) => { setAttackFrom(s); setSel(null); setPending(null); };
  const atkTarget = (p, kind, idx) => {
    if (!attackFrom) return false;
    return p === 1 - attackFrom.p && (kind === "m" || kind === "emz") && !!zoneInst(p, kind, idx);
  };
  const oppMonsters = (opp) =>
    P[opp].mzones.some(Boolean) || game.emz.some((e) => e && e.owner === opp);

  /* explicit attacker+target so both the human UI and the AI can call it */
  const resolveBattle = (aSel, tSel) => {
    const aInst = getInst(aSel), tInst = getInst(tSel);
    if (!aInst || !tInst) { setAttackFrom(null); return; }
    const aP = aSel.p, tP = tSel.p, aAtk = aInst.card.atk ?? 0;
    const aName = aInst.card.name, tName = tInst.card.name;
    const bury = (n, s) => { const x = pull(n, s); if (x) { x.pos = "atk"; n.players[s.p].gy.push(x); } };
    let killA = false, killT = false, dmgTo = null, dmgAmt = 0, msg;
    if (tInst.pos === "atk") {
      const tAtk = tInst.card.atk ?? 0;
      if (aAtk > tAtk) { killT = true; dmgTo = tP; dmgAmt = aAtk - tAtk; msg = `⚔ ${aName} destroys ${tName} — ${plabel(tP)} takes ${dmgAmt}`; }
      else if (aAtk < tAtk) { killA = true; dmgTo = aP; dmgAmt = tAtk - aAtk; msg = `⚔ ${tName} survives — ${plabel(aP)} takes ${dmgAmt}`; }
      else { killA = killT = true; msg = `⚔ ${aName} and ${tName} destroy each other`; }
    } else { /* target set / defense — reveal and compare against DEF */
      const tDef = tInst.card.def ?? 0;
      if (aAtk > tDef) { killT = true; msg = `⚔ ${aName} destroys defending ${tName} (${aAtk} vs DEF ${tDef})`; }
      else if (aAtk < tDef) { dmgTo = aP; dmgAmt = tDef - aAtk; msg = `⚔ ${tName} holds (DEF ${tDef}) — ${plabel(aP)} takes ${dmgAmt}`; }
      else { msg = `⚔ ${aName} bounces off ${tName} (${aAtk} = DEF ${tDef})`; }
    }
    commit((n) => {
      const A = getInstMut(n, aSel); if (A) A.attacked = true;
      if (dmgTo != null) n.players[dmgTo].lp = Math.max(0, n.players[dmgTo].lp - dmgAmt);
      if (killT) bury(n, tSel);
      if (killA) bury(n, aSel);
    }, msg);
    setAttackFrom(null);
  };
  const resolveDirect = (aSel) => {
    const aInst = getInst(aSel); if (!aInst) { setAttackFrom(null); return; }
    const oppP = 1 - aSel.p, dealt = aInst.card.atk ?? 0;
    commit((n) => { const A = getInstMut(n, aSel); if (A) A.attacked = true; n.players[oppP].lp = Math.max(0, n.players[oppP].lp - dealt); },
      `⚔ ${aInst.card.name} attacks directly — ${plabel(oppP)} takes ${dealt}`);
    setAttackFrom(null);
  };
  const resolveAttack = (tSel) => resolveBattle(attackFrom, tSel);   // human path
  const directAttack = () => resolveDirect(attackFrom);

  const onZone = (p, kind, idx) => {
    if (attackFrom) { if (atkTarget(p, kind, idx)) resolveAttack({ p, loc: kind, idx }); return; }
    if (pending) {
      if (pending.kind === "mon" && !tributesSatisfied()) { if (canTribute(p, kind, idx)) addTribute(p, kind, idx); return; }
      if (canPlace(p, kind, idx)) finishPlace(p, kind, idx);
      return;
    }
    const inst = zoneInst(p, kind, idx);
    if (inst) setSel({ p, loc: kind, idx });
  };

  /* -------- action list for the selected card -------- */
  const move = (s, to, pos, msg) => commit((n) => { const x = pull(n, s); if (!x) return; const pl = n.players[s.p]; if (pos) x.pos = pos; pl[to][to === "deck" ? "unshift" : "push"](x); }, msg);
  const setPos = (s, pos, msg) => commit((n) => { const i = getInstMut(n, s); if (i) i.pos = pos; }, msg);
  const getInstMut = (n, s) => (s.loc === "m" ? n.players[s.p].mzones[s.idx] : s.loc === "s" ? n.players[s.p].szones[s.idx] : s.loc === "field" ? n.players[s.p].field : s.loc === "emz" ? n.emz[s.idx]?.inst : null);

  const actionsFor = (s) => {
    const inst = getInst(s); if (!inst) return [];
    const c = inst.card, name = c.name, P1 = plabel(s.p);
    const mon = frameKey(c.frameType) && !/spell|trap/.test(c.frameType);
    const isActive = s.p === game.active;
    const mainPhase = game.phase === "M1" || game.phase === "M2";
    const canMain = isActive && mainPhase && game.winner == null;
    const A = [];
    if (s.loc === "hand") {
      if (mon) {
        const need = tributesFor(c);
        const haveMon = P[s.p].mzones.filter(Boolean).length + game.emz.filter((e) => e && e.owner === s.p).length;
        const summoned = P[s.p].normalSummoned;
        const label = need ? `Tribute Summon — ${need} trib` : "Normal Summon (ATK)";
        if (!canMain) A.push({ l: "Normal Summon", disabled: true, hint: game.winner != null ? "game over" : !isActive ? "not your turn" : "Main Phase only" });
        else if (summoned) A.push({ l: "Normal Summon", disabled: true, hint: "already summoned this turn" });
        else if (need > haveMon) A.push({ l: `Tribute Summon`, disabled: true, hint: `needs ${need} tribute${need > 1 ? "s" : ""}` });
        else {
          A.push({ l: label, go: () => setPending({ kind: "mon", pos: "atk", normal: true, needTrib: need, tribs: [], src: s }) });
          A.push({ l: need ? `Tribute Set — ${need} trib` : "Normal Set (DEF)", go: () => setPending({ kind: "mon", pos: "set", normal: true, needTrib: need, tribs: [], src: s }) });
        }
        A.push({ l: "Special Summon (ATK)", go: () => setPending({ kind: "mon", pos: "atk", normal: false, needTrib: 0, tribs: [], src: s }) });
        A.push({ l: "Special Summon (DEF)", go: () => setPending({ kind: "mon", pos: "def", normal: false, needTrib: 0, tribs: [], src: s }) });
      } else if (/spell/i.test(c.type)) {
        A.push({ l: isFieldSpell(c) ? "Activate (Field)" : "Activate", go: () => setPending({ kind: isFieldSpell(c) ? "field" : "st", pos: "up", src: s }) });
        if (canMain) A.push({ l: "Set", go: () => setPending({ kind: "st", pos: "settrap", src: s }) });
        else A.push({ l: "Set", disabled: true, hint: "Main Phase only" });
      } else {
        if (canMain) A.push({ l: "Set", go: () => setPending({ kind: "st", pos: "settrap", src: s }) });
        else A.push({ l: "Set", disabled: true, hint: "Main Phase only" });
      }
      A.push({ l: "Discard to GY", go: () => move(s, "gy", "atk", `${P1} discarded ${name}`) });
      A.push({ l: "Banish", go: () => move(s, "banish", "atk", `${P1} banished ${name}`) });
      A.push({ l: "To Deck (top)", go: () => move(s, "deck", "atk", `${P1} sent ${name} to deck`) });
    } else if (s.loc === "m" || s.loc === "emz") {
      // battle: attack legality enforced (Battle Phase, your turn, not turn 1, once per monster)
      if (inst.pos === "atk") {
        if (game.winner != null) { /* no action */ }
        else if (game.phase !== "BP") A.push({ l: "⚔ Declare attack", disabled: true, hint: "Battle Phase only" });
        else if (!isActive) A.push({ l: "⚔ Declare attack", disabled: true, hint: "not your turn" });
        else if (game.turn === 1) A.push({ l: "⚔ Declare attack", disabled: true, hint: "no Battle Phase on turn 1" });
        else if (inst.attacked) A.push({ l: "⚔ Declare attack", disabled: true, hint: "already attacked" });
        else A.push({ l: "⚔ Declare attack", go: () => beginAttack(s) });
      }
      if (canMain) {
        if (inst.pos !== "atk") A.push({ l: "To ATK (face-up)", go: () => setPos(s, "atk", `${P1}: ${name} → ATK`) });
        if (inst.pos !== "def") A.push({ l: "To DEF (face-up)", go: () => setPos(s, "def", `${P1}: ${name} → DEF`) });
        if (inst.pos !== "set") A.push({ l: "Set (face-down DEF)", go: () => setPos(s, "set", `${P1} set a monster`) });
      }
      A.push({ l: "Send to GY", go: () => move(s, "gy", "atk", `${P1} sent ${name} to GY`) });
      A.push({ l: "Banish", go: () => move(s, "banish", "atk", `${P1} banished ${name}`) });
      A.push({ l: "Return to Hand", go: () => move(s, "hand", "atk", `${name} returned to hand`) });
      if (s.loc === "emz" || isExtra(c.frameType)) A.push({ l: "To Extra Deck", go: () => move(s, "extra", "atk", `${name} → Extra`) });
      else A.push({ l: "To Deck (top)", go: () => move(s, "deck", "atk", `${name} → deck`) });
    } else if (s.loc === "s" || s.loc === "field") {
      if (inst.pos === "settrap") A.push({ l: "Activate (flip up)", go: () => setPos(s, "up", `${P1} activated ${name}`) });
      A.push({ l: "Send to GY", go: () => move(s, "gy", "atk", `${P1} sent ${name} to GY`) });
      A.push({ l: "Banish", go: () => move(s, "banish", "atk", `${P1} banished ${name}`) });
      A.push({ l: "Return to Hand", go: () => move(s, "hand", "atk", `${name} returned to hand`) });
    } else { /* pile viewer cards */
      if (mon || isExtra(c.frameType)) {
        A.push({ l: "Special Summon (ATK)", go: () => { setPending({ kind: "mon", pos: "atk", normal: false, src: s }); setViewer(null); } });
        A.push({ l: "Special Summon (DEF)", go: () => { setPending({ kind: "mon", pos: "def", normal: false, src: s }); setViewer(null); } });
      }
      A.push({ l: "Add to Hand", go: () => { move(s, "hand", "atk", `${P1} added ${name} to hand`); setViewer(null); } });
      if (s.loc !== "gy") A.push({ l: "Send to GY", go: () => { move(s, "gy", "atk", `${name} → GY`); setViewer(null); } });
      if (s.loc !== "banish") A.push({ l: "Banish", go: () => { move(s, "banish", "atk", `${name} banished`); setViewer(null); } });
      if (s.loc !== "deck" && s.loc !== "extra") A.push({ l: "To Deck (top)", go: () => { move(s, "deck", "atk", `${name} → deck`); setViewer(null); } });
    }
    return A;
  };

  const drawCard = (p) => commit((n) => {
    const c = n.players[p].deck.shift();
    if (c) n.players[p].hand.push(c);
    else { n.winner = 1 - p; n.log.push({ t: n.turn, m: `🏆 ${plabel(1 - p)} wins — ${plabel(p)} decked out` }); }
  }, `${plabel(p)} drew a card`);
  const shuffleDeck = (p) => commit((n) => { shuffle(n.players[p].deck); }, `${plabel(p)} shuffled`);
  const changeLP = (p, d) => commit((n) => { n.players[p].lp = Math.max(0, n.players[p].lp + d); }, `${plabel(p)} LP ${d > 0 ? "+" : ""}${d}`);
  const setPhase = (ph) => { if (game.winner == null) commit((n) => { n.phase = ph; }, `→ ${PHASE_FULL[ph]} Phase`); };
  const endTurn = () => commit((n) => {
    const np = 1 - n.active;
    n.active = np; n.turn += 1; n.phase = "DP";
    resetTurnFlags(n, np);
    // Draw Phase — the incoming player always draws (turn-1 no-draw only applies to the opener)
    const c = n.players[np].deck.shift();
    if (c) n.players[np].hand.push(c);
    else { n.winner = 1 - np; n.log.push({ t: n.turn, m: `🏆 ${plabel(1 - np)} wins — ${plabel(np)} decked out` }); }
  }, `— ${plabel(1 - game.active)}'s turn (T${game.turn + 1}) · Draw Phase —`);
  /* advance one phase; auto-skips Battle Phase on turn 1 and ends the turn after End Phase */
  const nextPhase = () => {
    if (game.winner != null) return;
    if (game.phase === "EP") { endTurn(); return; }
    let ni = PHASES.indexOf(game.phase) + 1;
    if (PHASES[ni] === "BP" && game.turn === 1) ni++;   // opener has no Battle Phase
    const np = PHASES[ni];
    commit((n) => { n.phase = np; }, `→ ${PHASE_FULL[np]} Phase`);
  };
  const coin = () => commit(() => {}, `🪙 Coin: ${Math.random() < 0.5 ? "Heads" : "Tails"}`);
  const dice = () => commit(() => {}, `🎲 Dice: ${1 + Math.floor(Math.random() * 6)}`);

  /* ---- AI opponent (P2): one action per tick ---- */
  const aiSummon = (cand) => {
    const me = 1;
    const name = game.players[me].hand[cand.handIdx]?.card.name || "a monster";
    commit((n) => {
      const pl = n.players[me];
      cand.tributes.forEach((zi) => { const x = pl.mzones[zi]; if (x) { pl.mzones[zi] = null; x.pos = "atk"; pl.gy.push(x); } });
      const inst = pl.hand.splice(cand.handIdx, 1)[0]; if (!inst) return;
      inst.pos = cand.pos; inst.attacked = false;
      let zi = pl.mzones.findIndex((z) => !z);
      if (zi < 0) zi = cand.tributes[0] ?? 0;
      pl.mzones[zi] = inst;
      pl.normalSummoned = true;
    }, `P2 Normal Summoned ${name}${cand.tributes.length ? ` (tributing ${cand.tributes.length})` : ""}`);
  };
  const aiTick = () => {
    const g = game, me = 1;
    if (!g || g.winner != null || g.active !== me) return;
    if (g.phase === "DP" || g.phase === "SP" || g.phase === "M2") { nextPhase(); return; }
    if (g.phase === "EP") { endTurn(); return; }
    if (g.phase === "M1") {
      const cand = aiBestSummon(g, me);
      if (cand) { aiSummon(cand); return; }
      nextPhase(); return; // → Battle
    }
    if (g.phase === "BP") {
      const attacker = ownMonsters(g, me).find((o) => o.inst.pos === "atk" && !o.inst.attacked);
      if (attacker) {
        const aSel = { p: me, loc: attacker.loc, idx: attacker.idx };
        const dec = aiPickAttack(g, me, aSel);
        if (dec.kind === "direct") resolveDirect(aSel);
        else if (dec.kind === "battle") resolveBattle(aSel, dec.tSel);
        else commit((n) => { const A = getInstMut(n, aSel); if (A) A.attacked = true; }, `P2's ${attacker.inst.card.name} holds back`);
        return;
      }
      nextPhase(); return; // → Main 2
    }
  };
  aiTickRef.current = aiTick;

  const selInst = getInst(sel);
  const previewInst = hover || selInst;
  const attackerInst = getInst(attackFrom);
  const tips = coach ? coachTips(game) : [];

  return (
    <div style={{ display: "grid", gridTemplateColumns: "1fr 272px", height: "calc(100vh - 60px)" }}>
      {/* ---- board ---- */}
      <div style={{ overflow: "auto", padding: "10px 14px", display: "flex", flexDirection: "column", gap: 8 }}>
        {/* HUD */}
        <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", background: C.panel, borderRadius: 8, padding: "7px 10px", position: "sticky", top: 0, zIndex: 5 }}>
          <span key={game.turn} className="disp turnbanner" style={{ fontSize: 12, color: C.gold }}>Turn {game.turn}</span>
          <span className="mono" style={{ fontSize: 11, color: you ? C.good : C.bad, border: `1px solid ${you ? C.good : C.bad}`, borderRadius: 20, padding: "2px 9px" }}>{you ? "P1's turn" : "P2's turn"}</span>
          <div style={{ display: "flex", gap: 2 }}>
            {PHASES.map((ph) => (
              <button key={ph} onClick={() => setPhase(ph)} title={PHASE_FULL[ph]} className="mono"
                style={{ fontSize: 10, padding: "4px 7px", borderRadius: 4, border: "none", background: game.phase === ph ? C.gold : C.panel2, color: game.phase === ph ? "#1a1206" : C.mute }}>{ph}</button>
            ))}
          </div>
          <button onClick={nextPhase} className="disp" style={{ ...miniBar(), background: C.good, color: "#07120b", border: "none" }}>{game.phase === "EP" ? "End Turn ▸" : `Next: ${PHASE_FULL[PHASES[Math.min(PHASES.indexOf(game.phase) + 1, 5)]]} ▸`}</button>
          <button onClick={endTurn} className="disp" style={{ ...miniBar(), background: C.panel2 }}>End Turn ⟳</button>
          <button onClick={undo} style={miniBar()}>↩ Undo</button>
          <button onClick={coin} style={miniBar()}>🪙</button>
          <button onClick={dice} style={miniBar()}>🎲</button>
          <button onClick={() => setVsAI((v) => !v)} style={{ ...miniBar(), borderColor: vsAI ? C.good : C.line, color: vsAI ? C.good : C.mute }}>🤖 AI {vsAI ? "on" : "off"}</button>
          <button onClick={() => setCoach((v) => !v)} style={{ ...miniBar(), borderColor: coach ? C.gold : C.line, color: coach ? C.gold : C.mute }}>🎓 Coach {coach ? "on" : "off"}</button>
          <button onClick={() => setHideHands((h) => !h)} style={miniBar()}>{hideHands ? "Show P2 hand" : "Hide P2 hand"}</button>
          <button onClick={start} style={{ ...miniBar(), color: C.bad }}>Reset</button>
        </div>

        {pending && (
          <div className="mono" style={{ background: "rgba(79,191,123,.12)", border: `1px solid ${C.good}`, color: C.good, borderRadius: 6, padding: "6px 10px", fontSize: 11.5, display: "flex", justifyContent: "space-between", gap: 10 }}>
            <span>
              {pending.kind === "mon" && !tributesSatisfied()
                ? `Tribute Summon: pick ${pending.needTrib - (pending.tribs?.length || 0)} more monster${pending.needTrib - (pending.tribs?.length || 0) > 1 ? "s" : ""} to tribute for “${getInst(pending.src)?.card.name}”.`
                : `Select a highlighted zone to place “${getInst(pending.src)?.card.name}”.`}
            </span>
            <button onClick={() => { setPending(null); setSel(null); }} style={{ background: "none", border: "none", color: C.good, textDecoration: "underline" }}>cancel</button>
          </div>
        )}
        {attackFrom && (
          <div className="mono" style={{ background: "rgba(224,87,106,.12)", border: `1px solid ${C.bad}`, color: C.bad, borderRadius: 6, padding: "6px 10px", fontSize: 11.5, display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
            <span>⚔ {attackerInst?.card.name} ({attackerInst?.card.atk ?? 0} ATK) is attacking — click a pulsing target{!oppMonsters(1 - attackFrom.p) ? "" : ""}.</span>
            <button onClick={directAttack} style={{ ...miniBar(), color: C.bad, borderColor: C.bad }}>Direct attack (−{attackerInst?.card.atk ?? 0})</button>
            <button onClick={() => setAttackFrom(null)} style={{ background: "none", border: "none", color: C.bad, textDecoration: "underline", marginLeft: "auto" }}>cancel</button>
          </div>
        )}

        {/* the duel mat — field in the middle, each player's half facing them */}
        <div style={{ flex: 1, borderRadius: 14, padding: "12px 16px", display: "flex", flexDirection: "column", gap: 6,
          background: `radial-gradient(70% 55% at 50% 0%, ${hexA(ZONE.st, 0.1)}, transparent 62%), radial-gradient(70% 55% at 50% 100%, ${hexA(ZONE.mon, 0.09)}, transparent 62%), linear-gradient(180deg, #0e1424 0%, #0a0f1b 50%, #0e1424 100%)`,
          border: `1px solid ${C.line}`, boxShadow: "inset 0 0 80px rgba(0,0,0,.62), 0 2px 20px rgba(0,0,0,.4)" }}>
          {/* opponent (P2) — rotated 180° so the whole half faces them across the table */}
          <div style={{ transform: "rotate(180deg)" }}>
            <PlayerField p={1} P={P} game={game} onZone={onZone} canPlace={canPlace} atkTarget={atkTarget} tribTarget={canTribute} isTrib={isTrib} attackFrom={attackFrom} sel={sel} setSel={setSel} setViewer={setViewer} setHover={setHover} drawCard={drawCard} shuffleDeck={shuffleDeck} changeLP={changeLP} dmg={dmg} hideHand={hideHands} />
          </div>
          <EMZRow game={game} onZone={onZone} canPlace={canPlace} atkTarget={atkTarget} tribTarget={canTribute} isTrib={isTrib} sel={sel} setHover={setHover} />
          {/* you (P1) — facing up toward the player */}
          <PlayerField p={0} P={P} game={game} onZone={onZone} canPlace={canPlace} atkTarget={atkTarget} tribTarget={canTribute} isTrib={isTrib} attackFrom={attackFrom} sel={sel} setSel={setSel} setViewer={setViewer} setHover={setHover} drawCard={drawCard} shuffleDeck={shuffleDeck} changeLP={changeLP} dmg={dmg} hideHand={false} />
        </div>
      </div>

      {/* ---- side panel: live preview + selected card actions + log ---- */}
      <div style={{ borderLeft: `1px solid ${C.line}`, display: "flex", flexDirection: "column", minHeight: 0 }}>
        <div style={{ padding: 12, borderBottom: `1px solid ${C.line}` }}>
          {previewInst ? (
            <div style={{ display: "flex", gap: 10 }}>
              <CardImg id={previewInst.card.id} variant="full" name={previewInst.card.name} frameType={previewInst.card.frameType} style={{ width: 88, aspectRatio: "0.686", borderRadius: 5, objectFit: "cover", flexShrink: 0, background: C.panel2, alignSelf: "flex-start" }} />
              <div style={{ minWidth: 0 }}>
                <div style={{ fontSize: 13, fontWeight: 700, lineHeight: 1.25 }}>{previewInst.card.name}</div>
                <div className="mono" style={{ fontSize: 10, color: FRAME[frameKey(previewInst.card.frameType)].bg, marginTop: 3, textTransform: "uppercase", letterSpacing: ".04em" }}>
                  {previewInst.card.type || ""}{previewInst.card.level != null ? ` · Lv/Rk ${previewInst.card.level}` : ""}
                </div>
                {previewInst.card.atk != null && (
                  <div className="mono" style={{ fontSize: 11, color: C.gold, marginTop: 2 }}>ATK {previewInst.card.atk} / DEF {previewInst.card.def ?? "—"}</div>
                )}
                <div style={{ fontSize: 10.5, color: C.mute, marginTop: 6, lineHeight: 1.4, maxHeight: 96, overflowY: "auto" }}>{previewInst.card.desc}</div>
              </div>
            </div>
          ) : (
            <p className="mono" style={{ fontSize: 11, color: C.mute, lineHeight: 1.6 }}>Hover any card to preview it. Click one — hand, field, or a pile — for its actions. Declare an attack, then click a pulsing enemy monster to auto-resolve damage.</p>
          )}
          {selInst && (
            <div style={{ display: "flex", flexDirection: "column", gap: 4, marginTop: 10 }}>
              <div className="mono" style={{ fontSize: 9.5, color: C.mute, textTransform: "uppercase", letterSpacing: ".08em" }}>{plabel(sel.p)} · {sel.loc.toUpperCase()} — actions</div>
              {actionsFor(sel).map((a, i) => (
                <button key={a.l + i} onClick={a.disabled ? undefined : a.go} disabled={a.disabled}
                  style={{ textAlign: "left", background: a.disabled ? "transparent" : C.panel2, border: `1px solid ${a.disabled ? C.line : a.l[0] === "⚔" ? C.bad : C.line}`, color: a.disabled ? C.mute : a.l[0] === "⚔" ? C.bad : C.text, borderRadius: 5, padding: "6px 9px", fontSize: 11.5, cursor: a.disabled ? "not-allowed" : "pointer", opacity: a.disabled ? 0.6 : 1 }}>
                  {a.l}{a.disabled && a.hint ? ` — ${a.hint}` : ""}
                </button>
              ))}
            </div>
          )}
        </div>
        {coach && tips.length > 0 && (
          <div style={{ padding: "8px 12px", borderBottom: `1px solid ${C.line}`, background: hexA(C.gold, 0.04) }}>
            <div className="disp" style={{ fontSize: 10, color: C.gold, marginBottom: 6 }}>🎓 Trainer{vsAI ? " · vs AI" : ""}</div>
            <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
              {tips.map((tip, i) => (
                <div key={i} className="mono" style={{ fontSize: 10.5, lineHeight: 1.35, color: tip.t === "good" ? C.good : tip.t === "warn" ? C.bad : C.mute, display: "flex", gap: 6 }}>
                  <span>{tip.t === "good" ? "✓" : tip.t === "warn" ? "⚠" : "•"}</span><span>{tip.m}</span>
                </div>
              ))}
            </div>
          </div>
        )}
        <div style={{ padding: "8px 12px", flex: 1, overflowY: "auto", minHeight: 0 }}>
          <div className="disp" style={{ fontSize: 10, color: C.mute, marginBottom: 6 }}>Game Log</div>
          {[...game.log].reverse().map((e, i) => (
            <div key={i} className="mono" style={{ fontSize: 10.5, color: e.m.startsWith("—") ? C.gold : e.m[0] === "⚔" ? C.bad : C.text, opacity: e.m.startsWith("—") ? 1 : 0.88, padding: "2px 0", borderBottom: `1px solid ${C.panel}` }}>
              <span style={{ color: C.mute }}>T{e.t} </span>{e.m}
            </div>
          ))}
        </div>
      </div>

      {viewer && <PileViewer game={game} viewer={viewer} setViewer={setViewer} setSel={setSel} sel={sel} actionsFor={actionsFor} plabel={plabel} />}
      {fx > 0 && <div key={fx} className="dmgflash" />}

      {game.winner != null && (
        <div style={{ position: "fixed", inset: 0, background: "rgba(4,7,12,.82)", zIndex: 60, display: "grid", placeItems: "center" }}>
          <div className="turnbanner" style={{ textAlign: "center", background: C.panel, border: `1px solid ${C.gold}`, borderRadius: 14, padding: "30px 44px", boxShadow: `0 0 40px ${C.goldDim}` }}>
            <div className="disp" style={{ fontSize: 13, color: C.mute, letterSpacing: ".2em" }}>DUEL OVER</div>
            <div className="disp" style={{ fontSize: 34, color: C.gold, margin: "8px 0 4px" }}>{plabel(game.winner)} WINS</div>
            <div className="mono" style={{ fontSize: 12, color: C.mute, marginBottom: 18 }}>{P[0].lp} — {P[1].lp}</div>
            <button onClick={start} className="disp" style={{ ...btn(), background: C.gold, color: "#1a1206", border: "none", padding: "10px 26px", fontSize: 13 }}>Rematch</button>
          </div>
        </div>
      )}
    </div>
  );
}

const miniBar = () => ({ background: "transparent", border: `1px solid ${C.line}`, color: C.text, borderRadius: 5, padding: "5px 9px", fontSize: 11 });

function DuelCard({ inst, onClick, onHover, selected, target, attacker }) {
  const c = inst.card, f = FRAME[frameKey(c.frameType)];
  const back = inst.pos === "set" || inst.pos === "settrap";
  const rot = inst.pos === "def" || inst.pos === "set";
  const isMon = !/spell|trap/.test(c.frameType || "");
  const bd = selected ? C.gold : attacker ? C.bad : target ? C.bad : shade(f.bg, 22);
  return (
    <button onClick={onClick} onMouseEnter={() => onHover?.(inst)} onMouseLeave={() => onHover?.(null)}
      title={c.name} className={target ? "dcard atktarget" : "dcard"}
      style={{ border: "none", background: "transparent", padding: 0, cursor: "pointer", display: "grid", placeItems: "center", width: "100%", height: "100%" }}>
      <div style={{ position: "relative", width: 50, height: 73, borderRadius: 4, overflow: "hidden", transform: rot ? "rotate(90deg) scale(.82)" : "none",
        border: `2px solid ${bd}`, boxShadow: selected ? `0 0 10px ${C.gold}` : attacker ? `0 0 10px ${C.bad}` : "none", background: C.panel2 }}>
        {back ? (
          <div style={{ width: "100%", height: "100%", background: `repeating-linear-gradient(45deg, ${shade(f.bg, -18)} 0 4px, ${shade(f.bg, -34)} 4px 8px)`, display: "grid", placeItems: "center" }}>
            <div style={{ width: "40%", height: "40%", transform: "rotate(45deg)", background: `linear-gradient(${C.gold}, ${C.goldDim})`, borderRadius: 3, opacity: 0.85 }} />
          </div>
        ) : (
          <CardImg id={c.id} variant="small" name={c.name} frameType={c.frameType} style={{ width: "100%", height: "100%", objectFit: "cover" }} />
        )}
        {!back && isMon && c.atk != null && (
          <span className="mono" style={{ position: "absolute", left: 0, right: 0, bottom: 0, fontSize: 8, textAlign: "center", color: "#fff", background: "rgba(0,0,0,.62)", letterSpacing: ".02em" }}>
            {c.atk}/{c.def ?? "—"}
          </span>
        )}
      </div>
    </button>
  );
}

function Slot({ inst, valid, selected, target, attacker, trib, tribbed, tone = ZONE.mon, onClick, onHover, label }) {
  const bd = valid ? C.good : target ? C.bad : (trib || tribbed) ? C.gold : inst ? shade(tone, -6) : hexA(tone, 0.45);
  const bg = valid ? hexA(C.good, 0.18) : trib ? hexA(C.gold, 0.14)
    : `radial-gradient(120% 120% at 50% 35%, ${hexA(tone, 0.14)}, rgba(4,7,12,.5))`;
  return (
    <div onClick={onClick} className={target || trib ? "atktarget" : undefined}
      style={{ position: "relative", width: 52, height: 75, flexShrink: 0, borderRadius: 6, display: "grid", placeItems: "center",
        border: `1.5px solid ${bd}`, background: bg,
        boxShadow: tribbed ? `0 0 8px ${C.gold}` : inst ? "none" : `inset 0 0 10px ${hexA(tone, 0.18)}`,
        cursor: valid || target || trib || inst ? "pointer" : "default" }}>
      {inst ? <DuelCard inst={inst} onClick={onClick} onHover={onHover} selected={selected} target={target} attacker={attacker} />
        : <span className="mono" style={{ fontSize: 7.5, color: hexA(tone, 0.85), letterSpacing: ".06em", fontWeight: 700 }}>{label}</span>}
      {tribbed && <span className="mono" style={{ position: "absolute", top: 1, left: 2, fontSize: 8, fontWeight: 700, color: "#1a1206", background: C.gold, borderRadius: 3, padding: "0 3px" }}>TRB</span>}
    </div>
  );
}

function Pile({ label, list, onClick, onHover, accent }) {
  const top = list[list.length - 1];
  return (
    <button onClick={onClick} onMouseEnter={() => top && onHover?.(top)} onMouseLeave={() => onHover?.(null)}
      style={{ width: 52, height: 75, flexShrink: 0, border: `1px solid ${accent ? shade(accent, -30) : C.line}`, borderRadius: 5, background: C.panel, cursor: "pointer", position: "relative", overflow: "hidden", padding: 0 }}>
      {top && <CardImg id={top.card.id} variant="small" name="" frameType={top.card.frameType} style={{ width: "100%", height: "100%", objectFit: "cover", opacity: 0.45 }} />}
      <span className="mono" style={{ position: "absolute", inset: 0, display: "grid", placeItems: "center", fontSize: 8.5, color: accent || C.text, textShadow: "0 1px 3px #000", flexDirection: "column" }}>
        <b>{label}</b><br />{list.length}
      </span>
    </button>
  );
}

/* one player's half of the mat, laid out like a Master Duel play field:
   ┌ left col: Field Spell / Extra Deck ┐ ┌ centre: Monster row + Spell/Trap row ┐ ┌ right col: Deck / GY / Banish ┐
   with the hand + life points along the player's edge. Rendered identically
   for both players; the parent rotates P2's copy 180° so the monster rows meet
   in the centre and each hand faces its own player. */
function PlayerField({ p, P, game, onZone, canPlace, atkTarget, tribTarget, isTrib, attackFrom, sel, setSel, setViewer, setHover, drawCard, shuffleDeck, changeLP, dmg, hideHand }) {
  const pl = P[p];
  const active = p === game.active;
  const selMatch = (loc, idx) => sel && sel.p === p && sel.loc === loc && sel.idx === idx;
  const isAtkFrom = (loc, idx) => attackFrom && attackFrom.p === p && attackFrom.loc === loc && attackFrom.idx === idx;

  const monRow = [0, 1, 2, 3, 4].map((i) => (
    <Slot key={"m" + i} inst={pl.mzones[i]} tone={ZONE.mon} valid={canPlace(p, "m", i)} target={atkTarget(p, "m", i)} attacker={isAtkFrom("m", i)}
      trib={tribTarget(p, "m", i)} tribbed={isTrib(p, "m", i)}
      selected={selMatch("m", i)} onClick={() => onZone(p, "m", i)} onHover={setHover} label="M" />
  ));
  const stRow = [0, 1, 2, 3, 4].map((i) => (
    <Slot key={"s" + i} inst={pl.szones[i]} tone={ZONE.st} valid={canPlace(p, "s", i)} selected={selMatch("s", i)} onClick={() => onZone(p, "s", i)} onHover={setHover} label="S / T" />
  ));

  const leftCol = (
    <div style={{ display: "flex", flexDirection: "column", gap: 5, justifyContent: "center" }}>
      <Slot inst={pl.field} tone={ZONE.field} valid={canPlace(p, "field", 0)} selected={selMatch("field", 0)} onClick={() => onZone(p, "field", 0)} onHover={setHover} label="FIELD" />
      <Pile label="EXTRA" list={pl.extra} onClick={() => setViewer({ p, pile: "extra" })} onHover={setHover} accent={C.gold} />
    </div>
  );
  const rightCol = (
    <div style={{ display: "flex", flexDirection: "column", gap: 5, justifyContent: "center" }}>
      <div style={{ display: "flex", gap: 4 }}>
        <button onClick={() => drawCard(p)} style={{ width: 52, height: 75, border: `1px solid ${C.gold}`, borderRadius: 5, background: `linear-gradient(160deg, ${shade(C.gold, -30)}, #1a130a)`, cursor: "pointer", color: C.gold }} className="mono" title="Draw a card">
          <div style={{ fontSize: 8 }}>DECK</div><div style={{ fontSize: 16, fontWeight: 700 }}>{pl.deck.length}</div><div style={{ fontSize: 7 }}>draw</div>
        </button>
        <div style={{ display: "flex", flexDirection: "column", gap: 4, justifyContent: "center" }}>
          <button onClick={() => shuffleDeck(p)} style={{ ...miniBar(), padding: "3px 6px" }} title="Shuffle deck">⤨</button>
          <button onClick={() => setViewer({ p, pile: "deck" })} style={{ ...miniBar(), padding: "3px 6px", fontSize: 9 }}>view</button>
        </div>
      </div>
      <div style={{ display: "flex", gap: 4 }}>
        <Pile label="GY" list={pl.gy} onClick={() => setViewer({ p, pile: "gy" })} onHover={setHover} />
        <Pile label="BANISH" list={pl.banish} onClick={() => setViewer({ p, pile: "banish" })} onHover={setHover} />
      </div>
    </div>
  );

  const lpPct = Math.max(0, Math.min(100, (pl.lp / 8000) * 100));
  const lpCol = pl.lp > 4000 ? C.good : pl.lp > 1500 ? C.gold : C.bad;
  const lp = (
    <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "3px 6px", background: active ? hexA(C.gold, 0.07) : "rgba(0,0,0,.25)", borderRadius: 8, border: `1px solid ${active ? shade(C.gold, -40) : C.line}` }}>
      {/* avatar + name */}
      <div style={{ display: "flex", alignItems: "center", gap: 7 }}>
        <div className="disp" style={{ width: 26, height: 26, borderRadius: "50%", display: "grid", placeItems: "center", fontSize: 11, color: "#0b0e1a", background: `radial-gradient(circle at 35% 30%, ${shade(lpCol, 40)}, ${shade(lpCol, -30)})`, boxShadow: active ? `0 0 8px ${hexA(C.gold, 0.6)}` : "none" }}>{p === 0 ? "P1" : "P2"}</div>
      </div>
      {/* LP bar */}
      <div style={{ flex: 1, minWidth: 90 }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
          <span className="mono" style={{ fontSize: 8.5, color: C.mute, letterSpacing: ".14em" }}>LP</span>
          <span key={pl.lp} className="mono lpnum" style={{ fontSize: 16, fontWeight: 700, color: lpCol, lineHeight: 1 }}>{pl.lp}</span>
        </div>
        <div style={{ height: 6, borderRadius: 4, background: "rgba(0,0,0,.5)", overflow: "hidden", marginTop: 2, border: `1px solid ${hexA(lpCol, 0.3)}` }}>
          <div style={{ width: `${lpPct}%`, height: "100%", background: `linear-gradient(90deg, ${shade(lpCol, -20)}, ${lpCol})`, transition: "width .45s ease" }} />
        </div>
      </div>
      {/* quick damage + NS status */}
      <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
        <button onClick={() => changeLP(p, -dmg)} style={{ ...miniBar(), color: C.bad, padding: "3px 6px", fontSize: 10 }}>−{dmg}</button>
        <button onClick={() => changeLP(p, dmg)} style={{ ...miniBar(), color: C.good, padding: "3px 6px", fontSize: 10 }}>+{dmg}</button>
        <span className="mono" style={{ fontSize: 8.5, color: pl.normalSummoned ? C.bad : C.good, whiteSpace: "nowrap" }}>{pl.normalSummoned ? "NS ✓" : "NS ○"}</span>
      </div>
    </div>
  );

  const nH = pl.hand.length, midH = (nH - 1) / 2;
  const hand = (
    <div style={{ display: "flex", gap: 2, justifyContent: "center", alignItems: "flex-end", flexWrap: "nowrap", overflowX: "auto", overflowY: "hidden", minHeight: 84, padding: "8px 4px 2px" }}>
      {pl.hand.map((inst, i) => {
        const rot = nH > 1 ? (i - midH) * 3.2 : 0;          // gentle fan
        const lift = nH > 1 ? Math.abs(i - midH) * 3 : 0;   // arc: middle sits highest
        const wrap = { transform: `rotate(${rot}deg) translateY(${lift}px)`, transformOrigin: "bottom center", flex: "0 0 auto", transition: "transform .15s" };
        return hideHand ? (
          <div key={inst.uid} style={{ ...wrap, width: 50, height: 73, borderRadius: 4, background: `repeating-linear-gradient(45deg, ${shade(C.gold, -30)} 0 4px, #14100a 4px 8px)`, border: `1px solid ${C.line}` }} />
        ) : (
          <div key={inst.uid} style={wrap}>
            <DuelCard inst={inst} onClick={() => setSel({ p, loc: "hand", idx: i })} onHover={setHover} selected={selMatch("hand", i)} />
          </div>
        );
      })}
      {nH === 0 && <span className="mono" style={{ fontSize: 10, color: C.mute, alignSelf: "center" }}>empty hand</span>}
    </div>
  );

  const board = (
    <div style={{ display: "flex", gap: 10, alignItems: "center", justifyContent: "center", flexWrap: "wrap" }}>
      {leftCol}
      <div style={{ display: "flex", flexDirection: "column", gap: 5 }}>
        <div style={{ display: "flex", gap: 5 }}>{monRow}</div>
        <div style={{ display: "flex", gap: 5 }}>{stRow}</div>
      </div>
      {rightCol}
    </div>
  );

  return (
    <div style={{ background: active ? "rgba(232,184,75,.06)" : "transparent", borderRadius: 10, padding: "6px 8px", border: `1px solid ${active ? shade(C.gold, -45) : "transparent"}`, transition: "background .3s" }}>
      {board}
      {hand}
      {lp}
    </div>
  );
}

function EMZRow({ game, onZone, canPlace, atkTarget, tribTarget, isTrib, sel, setHover }) {
  return (
    <div style={{ display: "flex", gap: 34, justifyContent: "center", alignItems: "center", padding: "5px 0", borderTop: `1px solid ${hexA(ZONE.emz, 0.35)}`, borderBottom: `1px solid ${hexA(ZONE.emz, 0.35)}`, background: `linear-gradient(90deg, transparent, ${hexA(ZONE.emz, 0.06)}, transparent)` }}>
      <span className="mono" style={{ fontSize: 8, color: hexA(ZONE.emz, 0.85), letterSpacing: ".12em" }}>◄ EXTRA MONSTER ZONES</span>
      {[0, 1].map((i) => (
        <Slot key={i} inst={game.emz[i]?.inst} tone={ZONE.emz} valid={canPlace(0, "emz", i) || canPlace(1, "emz", i)}
          target={atkTarget(0, "emz", i) || atkTarget(1, "emz", i)}
          trib={tribTarget(0, "emz", i) || tribTarget(1, "emz", i)} tribbed={isTrib(0, "emz", i) || isTrib(1, "emz", i)}
          selected={sel && sel.loc === "emz" && sel.idx === i}
          onClick={() => { const e = game.emz[i]; onZone(e ? e.owner : (sel?.p ?? game.active), "emz", i); }} onHover={setHover} label="EMZ" />
      ))}
      <span className="mono" style={{ fontSize: 8, color: shade(C.good, 30), letterSpacing: ".12em" }}>SHARED ►</span>
    </div>
  );
}

function PileViewer({ game, viewer, setViewer, setSel, sel, actionsFor, plabel }) {
  const pl = game.players[viewer.p];
  const list = pl[viewer.pile] || [];
  const title = { gy: "Graveyard", banish: "Banished", deck: "Deck", extra: "Extra Deck" }[viewer.pile];
  const selHere = sel && sel.p === viewer.p && sel.loc === viewer.pile;
  return (
    <div onClick={() => setViewer(null)} style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,.6)", zIndex: 40, display: "grid", placeItems: "center" }}>
      <div onClick={(e) => e.stopPropagation()} style={{ background: C.panel, border: `1px solid ${C.line}`, borderRadius: 12, padding: 16, width: "min(760px,92vw)", maxHeight: "84vh", display: "flex", flexDirection: "column" }}>
        <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 10 }}>
          <span className="disp" style={{ color: C.gold, fontSize: 13 }}>{plabel(viewer.p)} · {title} ({list.length})</span>
          <button onClick={() => setViewer(null)} style={miniBar()}>close</button>
        </div>
        <div style={{ display: "flex", gap: 14, minHeight: 0 }}>
          <div style={{ flex: 1, overflowY: "auto", display: "grid", gridTemplateColumns: "repeat(auto-fill,minmax(64px,1fr))", gap: 8, alignContent: "start" }}>
            {list.map((inst, i) => (
              <button key={inst.uid} onClick={() => setSel({ p: viewer.p, loc: viewer.pile, idx: i })}
                style={{ border: `2px solid ${selHere && sel.idx === i ? C.gold : "transparent"}`, borderRadius: 5, padding: 0, background: "none", cursor: "pointer" }}>
                <CardImg id={inst.card.id} variant="small" name={inst.card.name} frameType={inst.card.frameType} style={{ width: "100%", aspectRatio: "0.686", borderRadius: 4, display: "block", objectFit: "cover" }} />
              </button>
            ))}
            {list.length === 0 && <span className="mono" style={{ fontSize: 11, color: C.mute }}>empty</span>}
          </div>
          <div style={{ width: 180, flexShrink: 0, borderLeft: `1px solid ${C.line}`, paddingLeft: 12 }}>
            {selHere ? (
              <div style={{ display: "flex", flexDirection: "column", gap: 5 }}>
                <div style={{ fontSize: 12, fontWeight: 700, marginBottom: 4 }}>{pl[viewer.pile][sel.idx]?.card.name}</div>
                {actionsFor(sel).map((a) => (
                  <button key={a.l} onClick={a.go} style={{ textAlign: "left", background: C.panel2, border: `1px solid ${C.line}`, color: C.text, borderRadius: 5, padding: "6px 9px", fontSize: 11.5 }}>{a.l}</button>
                ))}
              </div>
            ) : (
              <p className="mono" style={{ fontSize: 10.5, color: C.mute }}>Pick a card for actions.</p>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

/* ====================================================================== */
/*  AUTO-DUEL ENGINE — Phase 1: load & self-test the ocgcore/EDOPro WASM   */
/*  stack (engine + cards.cdb + Lua scripts) entirely from CDNs, isolated  */
/*  so it can never break the manual app. Full duel loop is a later phase. */
/* ====================================================================== */
const ENGINE = {
  // the package root (mod.ts) uses `export *`, which drops the default export;
  // createCore is the DEFAULT export of dist/index.js, so import that directly.
  core: "https://esm.sh/@jsr/n1xx1__ocgcore-wasm@0.1.3/dist/index.js",
  sqljsScript: "https://cdn.jsdelivr.net/npm/sql.js@1.11.0/dist/sql-wasm.js", // browser UMD build (sets window.initSqlJs)
  sqlWasm: "https://cdn.jsdelivr.net/npm/sql.js@1.11.0/dist/sql-wasm.wasm",
  cdb: "https://cdn.jsdelivr.net/gh/ProjectIgnis/BabelCDB@f9e0404bed1d363bd6e7cab8ae89299231608416/cards.cdb",
  // supplementary card databases for cards not yet in the main cards.cdb
  // (new sets, unofficial/anime). Merged into the engine DB at load so their
  // real passcodes resolve. Add more filenames here as new sets drop.
  extraCdbs: [
    "https://cdn.jsdelivr.net/gh/ProjectIgnis/BabelCDB@f9e0404bed1d363bd6e7cab8ae89299231608416/release-cori.cdb",      // Chaos Origins (Sacred Beasts / Invoked support)
    "https://cdn.jsdelivr.net/gh/ProjectIgnis/BabelCDB@f9e0404bed1d363bd6e7cab8ae89299231608416/prerelease-cori-en.cdb", // CORI pre-release entries
    "https://cdn.jsdelivr.net/gh/ProjectIgnis/BabelCDB@f9e0404bed1d363bd6e7cab8ae89299231608416/cards-unofficial.cdb",   // general catch-all for new/anime cards
  ],
  script: (code) => `https://cdn.jsdelivr.net/gh/ProjectIgnis/CardScripts@b11c233502fd75fc06b281f473937fbb27910e41/official/c${code}.lua`,
};
/* fresh RNG seed per duel — a fixed seed deals the exact same hands every game */
const rndSeed = () => Array.from({ length: 4 }, () => BigInt(1 + Math.floor(Math.random() * 0x7fffffff)));
/* inject a UMD <script> once and resolve when it's loaded */
const loadScript = (src) => new Promise((res, rej) => {
  if ([...document.scripts].some((s) => s.src === src)) return res();
  const el = document.createElement("script");
  el.src = src; el.async = true;
  el.onload = () => res(); el.onerror = () => rej(new Error("failed to load " + src));
  document.head.appendChild(el);
});

function EngineBeta({ main, extra }) {
  const [steps, setSteps] = useState([]);
  const [running, setRunning] = useState(false);
  const [duelLog, setDuelLog] = useState([]);
  const [duelBusy, setDuelBusy] = useState(false);
  const dbRef = useRef(null);
  const set = (i, patch) => setSteps((s) => s.map((x, j) => (j === i ? { ...x, ...patch } : x)));

  /* ensure sql.js + cards.cdb are loaded, return the SQLite handle */
  const ensureDb = async () => {
    if (dbRef.current) return dbRef.current;
    await loadScript(ENGINE.sqljsScript);
    const SQL = await window.initSqlJs({ locateFile: () => ENGINE.sqlWasm });
    const buf = await (await fetch(ENGINE.cdb)).arrayBuffer();
    dbRef.current = new SQL.Database(new Uint8Array(buf));
    return dbRef.current;
  };

  /* Phase 2 — load the deck into the real engine, start a duel, run the
     effect-resolving message loop until it needs a player decision. */
  const runDuel = async () => {
    setDuelBusy(true); setDuelLog([]);
    const log = (s) => setDuelLog((l) => [...l, s]);
    try {
      if (!main.length) throw new Error("Build a deck first (Deck Editor tab).");
      log("Loading card database…");
      const db = await ensureDb();
      log("Loading engine core (sync)…");
      // the bundled URL is what actually resolves the code-split wasm chunks
      const candidates = [ENGINE.core + "?bundle", ENGINE.core];
      let mod = null, lastErr = "";
      for (const url of candidates) {
        try { mod = await import(/* @vite-ignore */ url); break; }
        catch (e) { lastErr = String(e?.message || e); }
      }
      if (!mod) throw new Error("engine import failed — " + lastErr);
      const createCore = mod.default || mod.createCore;
      if (typeof createCore !== "function") throw new Error("createCore not found");
      const L = mod.OcgLocation || { DECK: 1, EXTRA: 64 };
      const POS = mod.OcgPosition || { FACEDOWN_DEFENSE: 8 };
      const PR = mod.OcgProcessResult || { END: 0, WAITING: 1, CONTINUE: 2 };
      const MODE = mod.OcgDuelMode || {};
      const names = mod.ocgMessageTypeStrings;
      const core = await createCore({ sync: true });

      // the SYNC core calls these readers synchronously from inside the WASM —
      // an async scriptReader hands it a Promise instead of Lua source and every
      // card script silently fails. Use the shared synchronous readers.
      const cardReader = makeCardReader(db);
      const scriptReader = syncScript;

      // prewarm all scripts async so nothing depends on blocking sync XHR (sandbox-safe)
      const DIAG_BASE = ["constant.lua", "utility.lua", "cards_specific_functions.lua", "proc_normal.lua",
        "proc_fusion.lua", "proc_synchro.lua", "proc_xyz.lua", "proc_link.lua", "proc_pendulum.lua", "proc_ritual.lua"];
      const codes = [...new Set([...main, ...extra].map((c) => Number(c.id)).filter(Boolean))];
      log("Prefetching rules + card scripts…");
      await prewarmScripts([...DIAG_BASE, ...codes.map((c) => `c${c}.lua`)]);

      log("Creating duel…");
      const handle = await core.createDuel({
        flags: MODE.MODE_MR5 ?? 0n,
        seed: rndSeed(),
        team1: { startingLP: 8000, startingDrawCount: 5, drawCountPerTurn: 1 },
        team2: { startingLP: 8000, startingDrawCount: 5, drawCountPerTurn: 1 },
        cardReader, scriptReader,
        errorHandler: (type, text) => log("⚠ core: " + text),
      });
      if (!handle) throw new Error("createDuel returned null (check card data / scripts)");

      for (const nm of DIAG_BASE) { const t = syncScript(nm); if (t) { try { await core.loadScript(handle, nm, t); } catch {} } }

      const addDeck = (team, list, location) => list.forEach((c) =>
        core.duelNewCard(handle, { team, duelist: 0, code: Number(c.id), controller: team, location, sequence: 2, position: POS.FACEDOWN_DEFENSE ?? 8 }));
      addDeck(0, main, L.DECK ?? 1); addDeck(0, extra, L.EXTRA ?? 64);
      addDeck(1, main, L.DECK ?? 1); addDeck(1, extra, L.EXTRA ?? 64);
      log(`Deck loaded: ${main.length} main + ${extra.length} extra (both sides). Starting duel…`);

      await core.startDuel(handle);
      const nameOf = (t) => (names?.get ? (names.get(t) || `msg#${t}`) : `msg#${t}`);
      const summarize = (m) => { const { type, ...rest } = m; const s = JSON.stringify(rest, (k, v) => (typeof v === "bigint" ? Number(v) : v)); return s && s !== "{}" ? " " + (s.length > 140 ? s.slice(0, 140) + "…" : s) : ""; };

      let status, guard = 0;
      const CONT = PR.CONTINUE ?? 2, END = PR.END ?? 0, WAIT = PR.WAITING ?? 1;
      do {
        status = await core.duelProcess(handle);
        const msgs = core.duelGetMessage(handle) || [];
        for (const m of msgs) log("• " + nameOf(m.type) + summarize(m));
        guard++;
      } while (status === CONT && guard < 4000);

      if (status === END) log("— duel ended —");
      else if (status === WAIT) log("⏸ Engine reached the first player decision. It ran the ruleset + card scripts to get here — interactive play / auto-response is Phase 3.");
      try { const f = core.duelQueryField?.(handle); if (f) log("field snapshot: " + JSON.stringify(f).slice(0, 160) + "…"); } catch {}
      log(`✅ processed ${guard} engine cycle(s).`);
    } catch (e) {
      setDuelLog((l) => [...l, "❌ " + String(e?.message || e)]);
    }
    setDuelBusy(false);
  };

  const run = async () => {
    setRunning(true);
    const plan = [
      "Load sql.js (SQLite in the browser)",
      "Download EDOPro card database (cards.cdb ~7.4 MB)",
      "Query a card to prove the cardReader source works",
      "Fetch a Lua card script (scriptReader source)",
      "Load the ocgcore / EDOPro WASM engine (sync build)",
      "Confirm the duel API (createDuel / process / …)",
    ];
    setSteps(plan.map((label) => ({ label, state: "pending", note: "" })));
    try {
      // 1. sql.js (browser UMD build → window.initSqlJs; avoids esm.sh's fs shim)
      set(0, { state: "run" });
      await loadScript(ENGINE.sqljsScript);
      const initSqlJs = window.initSqlJs;
      if (typeof initSqlJs !== "function") throw new Error("initSqlJs global not found after load");
      const SQL = await initSqlJs({ locateFile: () => ENGINE.sqlWasm });
      set(0, { state: "ok", note: "sql.js ready" });

      // 2. cards.cdb
      set(1, { state: "run" });
      const buf = await (await fetch(ENGINE.cdb)).arrayBuffer();
      const db = new SQL.Database(new Uint8Array(buf));
      dbRef.current = db;
      set(1, { state: "ok", note: `${(buf.byteLength / 1e6).toFixed(1)} MB loaded` });

      // 3. query a card (use a card from the loaded deck if possible)
      set(2, { state: "run" });
      const testId = main.find((c) => c.id)?.id || 89631139;
      const res = db.exec(`SELECT name FROM texts WHERE id=${testId}`);
      const nm = res?.[0]?.values?.[0]?.[0];
      const dat = db.exec(`SELECT atk,def,level,type FROM datas WHERE id=${testId}`);
      set(2, { state: nm ? "ok" : "warn", note: nm ? `#${testId} → “${nm}” (atk ${dat?.[0]?.values?.[0]?.[0]})` : `no row for #${testId}` });

      // 4. script fetch
      set(3, { state: "run" });
      const sc = await fetch(ENGINE.script(testId));
      const scText = sc.ok ? await sc.text() : "";
      set(3, { state: sc.ok ? "ok" : "warn", note: sc.ok ? `c${testId}.lua (${scText.length} bytes)` : `no script for #${testId} (normal monster?)` });

      // 5. engine wasm — use the SYNC build (browser-safe; the default async
      //    build needs experimental JSPI stack-switching). Try bundle first.
      set(4, { state: "run" });
      const candidates = [ENGINE.core, ENGINE.core + "?bundle"];
      let coreMod = null, usedUrl = "", lastErr = "";
      for (const url of candidates) {
        try { coreMod = await import(/* @vite-ignore */ url); usedUrl = url; break; }
        catch (e) { lastErr = String(e?.message || e); }
      }
      if (!coreMod) throw new Error("engine import failed — " + lastErr);
      const createCore = coreMod.default || coreMod.createCore;
      if (typeof createCore !== "function") throw new Error("createCore not exported. keys: " + Object.keys(coreMod).slice(0, 14).join(","));
      const core = await createCore({ sync: true });
      window.__ocg = core;
      set(4, { state: "ok", note: `engine ready (${usedUrl.includes("bundle") ? "bundled" : "esm"})` });

      // 6. confirm the duel API is present
      set(5, { state: "run" });
      const methods = ["createDuel", "startDuel", "duelProcess", "duelGetMessage", "duelSetResponse"].filter((m) => typeof core[m] === "function");
      set(5, { state: methods.length >= 4 ? "ok" : "warn", note: methods.length ? `API: ${methods.join(", ")}` : "no duel methods found on core" });
    } catch (e) {
      setSteps((s) => { const i = s.findIndex((x) => x.state === "run"); return s.map((x, j) => (j === i ? { ...x, state: "fail", note: String(e.message || e) } : x)); });
    }
    setRunning(false);
  };

  const dot = { pending: C.mute, run: C.gold, ok: C.good, warn: C.gold, fail: C.bad };
  return (
    <div style={{ height: "calc(100vh - 60px)", overflowY: "auto", padding: 24, maxWidth: 760, margin: "0 auto" }}>
      <p className="disp" style={{ color: C.gold, fontSize: 18 }}>Auto-Duel Engine · Phase 1 (beta)</p>
      <p style={{ color: C.mute, fontSize: 13, lineHeight: 1.6, marginTop: 8 }}>
        This is the first phase of the real <b>ygopro / EDOPro (ocgcore)</b> engine integration — the same engine
        family Master Duel is built on — for true automatic card-effect resolution. This step just loads and
        self-tests the whole stack in <i>your</i> browser (I can't test WASM from my side), so we confirm it works
        before building the full duel loop and field UI. It's fully isolated — nothing here affects the manual Duel tab.
      </p>
      <button onClick={run} disabled={running} className="disp"
        style={{ ...btn(), background: C.gold, color: "#1a1206", border: "none", padding: "11px 26px", fontSize: 14, marginTop: 16, opacity: running ? 0.6 : 1 }}>
        {running ? "Running self-test…" : "Run engine self-test"}
      </button>
      <div style={{ marginTop: 20, display: "flex", flexDirection: "column", gap: 8 }}>
        {steps.map((s, i) => (
          <div key={i} style={{ display: "flex", alignItems: "flex-start", gap: 10, background: C.panel, border: `1px solid ${C.line}`, borderRadius: 8, padding: "10px 12px" }}>
            <span style={{ width: 10, height: 10, borderRadius: "50%", background: dot[s.state], marginTop: 4, flexShrink: 0, boxShadow: s.state === "run" ? `0 0 8px ${C.gold}` : "none" }} />
            <div style={{ minWidth: 0 }}>
              <div style={{ fontSize: 13, color: C.text }}>{s.label}</div>
              {s.note && <div className="mono" style={{ fontSize: 11, color: s.state === "fail" ? C.bad : C.mute, marginTop: 2, wordBreak: "break-word" }}>{s.note}</div>}
            </div>
          </div>
        ))}
      </div>
      {steps.length > 0 && !running && (
        <p className="mono" style={{ fontSize: 11, color: C.mute, marginTop: 16, lineHeight: 1.6 }}>
          Tell me which steps are green / which failed and the exact error text.
        </p>
      )}

      {/* ---- Phase 2: actually run a duel through the engine ---- */}
      <div style={{ marginTop: 30, borderTop: `1px solid ${C.line}`, paddingTop: 20 }}>
        <p className="disp" style={{ color: C.gold, fontSize: 14 }}>Phase 2 · Run a real duel</p>
        <p style={{ color: C.mute, fontSize: 12.5, lineHeight: 1.6, marginTop: 6 }}>
          Loads your current deck ({main.length} main / {extra.length} extra) into the engine on <b>both</b> sides,
          starts a duel, and runs the real rules + Lua card scripts, streaming every engine event below. It will run
          up to the first decision point (interactive play + auto-opponent is Phase 3). Watch for any <span style={{ color: C.bad }}>⚠ core</span> script errors.
        </p>
        <button onClick={runDuel} disabled={duelBusy} className="disp"
          style={{ ...btn(), background: C.good, color: "#07120b", border: "none", padding: "11px 24px", fontSize: 13, marginTop: 12, opacity: duelBusy ? 0.6 : 1 }}>
          {duelBusy ? "Running duel…" : "▶ Run a duel through the engine"}
        </button>
        {duelLog.length > 0 && (
          <div className="mono" style={{ marginTop: 14, background: "#07090f", border: `1px solid ${C.line}`, borderRadius: 8, padding: 12, fontSize: 11, lineHeight: 1.5, maxHeight: 340, overflowY: "auto", whiteSpace: "pre-wrap", wordBreak: "break-word" }}>
            {duelLog.map((l, i) => (
              <div key={i} style={{ color: l[0] === "❌" ? C.bad : l.startsWith("⚠") ? C.gold : l[0] === "✅" ? C.good : C.text }}>{l}</div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

/* ---- shared engine helpers (sync build needs synchronous readers) ------ */
const engineScriptCache = new Map();

/* The sync core asks for Lua scripts SYNCHRONOUSLY, which normally forces a
   blocking cross-origin XMLHttpRequest — and a sandboxed / strict-CORS context
   (iframe, some embeds, COEP) blocks exactly that. When it's blocked, the rule
   libraries (proc_normal, proc_fusion, constants…) and every card script fail
   to load, so main-deck monsters can't be summoned and the duel is unplayable.
   Fix: pre-fetch everything with ordinary ASYNC fetch (sandbox/CORS-friendly)
   into the cache BEFORE the duel, so syncScript only ever hits the cache. */
const SCRIPT_BASE = "https://cdn.jsdelivr.net/gh/ProjectIgnis/CardScripts@b11c233502fd75fc06b281f473937fbb27910e41/";
const scriptUrl = (file) => (/^c\d+\.lua$/.test(file) ? SCRIPT_BASE + "official/" + file : SCRIPT_BASE + file);
async function prewarmScripts(files, onProgress) {
  const want = [...new Set(files.map((f) => String(f).split("/").pop()))].filter((f) => !engineScriptCache.has(f));
  let done = 0;
  const CHUNK = 24; // parallel, but polite to the CDN
  for (let i = 0; i < want.length; i += CHUNK) {
    await Promise.all(want.slice(i, i + CHUNK).map(async (file) => {
      try {
        const res = await fetch(scriptUrl(file));
        engineScriptCache.set(file, res.ok ? await res.text() : null);
      } catch { engineScriptCache.set(file, null); }
      onProgress?.(++done, want.length);
    }));
  }
}
const syncScript = (name) => {
  const file = String(name).split("/").pop();
  // cache first — prewarmScripts() fills this via async fetch before the duel,
  // so in a sandbox we never reach the blocking XHR below.
  if (engineScriptCache.has(file)) return engineScriptCache.get(file);
  let txt = null;
  try { const x = new XMLHttpRequest(); x.open("GET", scriptUrl(file), false); x.send(); if (x.status >= 200 && x.status < 300) txt = x.responseText; } catch { txt = null; }
  engineScriptCache.set(file, txt);
  return txt;
};
const makeCardReader = (db) => (code) => {
  const r = db.exec(`SELECT id,alias,CAST(setcode AS TEXT) sc,type,atk,def,level,CAST(race AS TEXT) rc,attribute FROM datas WHERE id=${code}`);
  const v = r?.[0]?.values?.[0];
  if (!v) return null;
  const [id, alias, sc, type, atk, def, level, rc, attribute] = v;
  const t = Number(type) >>> 0, isLink = !!(t & 0x4000000), lv = Number(level) >>> 0;
  const setBig = BigInt(sc || "0"), setcodes = [];
  for (let i = 0n; i < 4n; i++) { const s = Number((setBig >> (16n * i)) & 0xffffn); if (s) setcodes.push(s); }
  return { code: Number(id), alias: Number(alias) || 0, setcodes, type: t, level: lv & 0xff, attribute: Number(attribute) || 0, race: BigInt(rc || "0"), attack: Number(atk) || 0, defense: isLink ? 0 : (Number(def) || 0), lscale: (lv >> 24) & 0xff, rscale: (lv >> 16) & 0xff, link_marker: isLink ? (Number(def) || 0) : 0 };
};
/* Resolve a deck card's passcode to one the engine database actually has.
   YGOPRODeck sometimes hands back an alternate-art passcode that isn't the
   primary row in BabelCDB; if the direct id misses, fall back to the card's
   alias (its base print). Returns the usable code, or null if truly absent. */
/* A vanilla Normal Monster has no Lua script and doesn't need one, so a null
   script for it is expected, not an error. TYPE_NORMAL = 0x10, TYPE_MONSTER = 0x1. */
const isVanillaCode = (db, code) => {
  try {
    const r = db.exec(`SELECT type FROM datas WHERE id=${Number(code)}`);
    const t = Number(r?.[0]?.values?.[0]?.[0]) >>> 0;
    return !!(t & 0x1) && !!(t & 0x10); // monster AND normal
  } catch { return false; }
};
/* Extra-Deck monster types must live in the Extra Deck, never the main deck —
   otherwise they get loaded into the draw pile and turn up in the opening hand.
   TYPE_FUSION 0x40, TYPE_SYNCHRO 0x2000, TYPE_XYZ 0x800000, TYPE_LINK 0x4000000. */
const isExtraDeckCode = (db, code) => {
  try {
    const r = db.exec(`SELECT type FROM datas WHERE id=${Number(code)}`);
    const t = Number(r?.[0]?.values?.[0]?.[0]) >>> 0;
    return !!(t & (0x40 | 0x2000 | 0x800000 | 0x4000000));
  } catch { return false; }
};
const makeCodeResolver = (db) => (code) => {
  const n = Number(code);
  if (!Number.isFinite(n) || n <= 0) return null;
  try {
    const r = db.exec(`SELECT id,alias FROM datas WHERE id=${n}`);
    const v = r?.[0]?.values?.[0];
    if (v) { const alias = Number(v[1]) || 0; return alias && !db.exec(`SELECT 1 FROM texts WHERE id=${n}`)?.[0] ? alias : n; }
    // not found directly — maybe YGOPRODeck's id is an alias target
    const r2 = db.exec(`SELECT id FROM datas WHERE alias=${n} LIMIT 1`);
    const v2 = r2?.[0]?.values?.[0];
    return v2 ? Number(v2[0]) : null;
  } catch { return n; }
};

// merge a supplementary .cdb (opened as a second sql.js Database) into the main
// engine DB, so cards from newer sets resolve by their real passcode. Columns
// are quoted because `desc` is a SQLite reserved word.
const CDB_DCOLS = ["id", "ot", "alias", "setcode", "type", "atk", "def", "level", "race", "attribute", "category"];
const CDB_TCOLS = ["id", "name", "desc", ...Array.from({ length: 16 }, (_, i) => `str${i + 1}`)];
const mergeCdb = (main, ext) => {
  const copy = (table, cols) => {
    const q = '"' + cols.join('","') + '"';
    let res; try { res = ext.exec(`SELECT ${q} FROM ${table}`); } catch { return 0; }
    const rows = res?.[0]?.values || [];
    if (!rows.length) return 0;
    const stmt = main.prepare(`INSERT OR IGNORE INTO ${table} (${q}) VALUES (${cols.map(() => "?").join(",")})`);
    for (const row of rows) { try { stmt.run(row); } catch {} }
    stmt.free();
    return rows.length;
  };
  return copy("datas", CDB_DCOLS) + copy("texts", CDB_TCOLS);
};

// Deck-name → real passcode overrides. Some cards carry an English name in the
// deck data that differs from the engine DB's name (e.g. the Chaos Origins
// Sacred Beast retrains, whose deck names use the OCG-literal subtitle while the
// engine uses the official TCG name). Matching by name would either miss or hit
// the wrong (original) card, so these are pinned explicitly. Keys are raw names;
// they're normalized with nameKey() when the map is built.
const DECK_NAME_OVERRIDES_RAW = {
  "Hamon, Lord of Striking Thunder - Sacred Beast of Sinful Catastrophe": 50251045, // Calamity of the Sacred Beasts - Hamon
  "Raviel, Lord of Phantasms - Sacred Beast of Endless Eternity":         96345184, // Infinity of the Sacred Beasts - Raviel
  "Uria, Lord of Searing Flames - Sacred Beast of Cataclysmic Fire":      23856331, // Inferno of the Sacred Beasts - Uria
};

/* ---- NAME-based fallback resolution ------------------------------------
   Root-cause fix for "real card, wrong passcode": when a deck entry's id
   isn't in cards.cdb, recover the correct passcode by matching the card's
   NAME against the engine database instead. Handles decks whose passcodes
   were hand-entered / imported / AI-generated with wrong numbers on real,
   often very new cards. Pure-local (no network) so it works in the WKWebView
   and any sandbox.                                                            */
// known garbled → real name fragments (extend as you hit more)
const NAME_FIXES = [
  [/remlisunet/gi, "reminiscent"],   // "Aleister the Remlisunet" → "Aleister the Reminiscent"
  [/\balwass\b/gi, "aiwass"],        // "Alwass" → "Aiwass"
];
// collapse a card name to a comparison key: fix garbles, drop punctuation,
// unify dash variants, lowercase, squeeze spaces
const nameKey = (s) => {
  let t = String(s || "");
  for (const [re, to] of NAME_FIXES) t = t.replace(re, to);
  return t
    .replace(/[\u2010-\u2015\u2212]/g, "-")   // en/em/minus dashes → hyphen
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")              // strip punctuation
    .replace(/\s+/g, " ")
    .trim();
};
// explicit deck-name → passcode overrides, keyed by normalized name
const DECK_NAME_OVERRIDES = new Map(
  Object.entries(DECK_NAME_OVERRIDES_RAW).map(([name, id]) => [nameKey(name), Number(id)])
);
// build a normalized name→id index over the whole database, once per duel
const makeNameResolver = (db) => {
  const idx = new Map();
  try {
    const r = db.exec("SELECT id,name FROM texts");
    const rows = r?.[0]?.values || [];
    for (const [id, name] of rows) { const k = nameKey(name); if (k && !idx.has(k)) idx.set(k, Number(id)); }
  } catch {}
  return (name) => {
    const k = nameKey(name);
    if (!k) return null;
    if (DECK_NAME_OVERRIDES.has(k)) return DECK_NAME_OVERRIDES.get(k); // pinned mismatches first
    if (idx.has(k)) return idx.get(k);
    // second chance: match on the base name before a " - subtitle"
    const base = k.split(" - ")[0];
    if (base !== k && idx.has(base)) return idx.get(base);
    return null;
  };
};
const loadEngineMod = async () => {
  const candidates = [ENGINE.core + "?bundle", ENGINE.core];
  let mod = null, err = "";
  for (const u of candidates) { try { mod = await import(/* @vite-ignore */ u); break; } catch (e) { err = String(e?.message || e); } }
  if (!mod) throw new Error("engine import failed — " + err);
  return mod;
};

/* Deck-load diagnostic — shows the user exactly what the engine could and
   couldn't load, so a broken duel is never a mystery. */
function DeckLoadReport({ rep }) {
  const okMain = rep.mainLoaded === rep.mainTotal, okExtra = rep.extraLoaded === rep.extraTotal;
  const line = (label, on) => ({ color: on ? "#7bd88f" : "#ffb454", fontWeight: 700 });
  return (
    <div className="mono" style={{ marginTop: 16, textAlign: "left", fontSize: 11.5, background: "rgba(0,0,0,.35)", border: "1px solid rgba(255,255,255,.12)", borderRadius: 8, padding: "12px 14px", lineHeight: 1.7 }}>
      <div className="disp" style={{ fontSize: 11, letterSpacing: ".12em", color: "#9aa2b1", marginBottom: 6 }}>Deck-Load Report</div>
      <div style={line("main", okMain)}>Your main deck: {rep.mainLoaded}/{rep.mainTotal} loaded {okMain ? "✓" : "⚠"}</div>
      <div style={line("extra", okExtra)}>Your extra deck: {rep.extraLoaded}/{rep.extraTotal} loaded {okExtra ? "✓" : "⚠"}</div>
      {rep.oppLabel && (
        <div style={{ ...line("opp", (rep.oppMainLoaded || 0) >= 40), marginTop: 4, borderTop: "1px solid rgba(255,255,255,.08)", paddingTop: 4 }}>
          Opponent — {rep.oppLabel}: {rep.oppMainLoaded}/{rep.oppMainTotal} loaded {(rep.oppMainLoaded || 0) >= 40 ? "✓" : "⚠"}
          {rep.oppMissing && rep.oppMissing.length > 0 && <span style={{ color: "#cfcabb", fontWeight: 400 }}> · missing: {rep.oppMissing.slice(0, 8).join(", ")}</span>}
        </div>
      )}
      {rep.libsBroken && <div style={{ color: "#ff6b6b", fontWeight: 700, marginTop: 6 }}>⚠ Rule scripts blocked — sandbox/CORS. Run in a normal browser tab.</div>}
      {rep.repaired && rep.repaired.length > 0 && (
        <div style={{ marginTop: 8, color: "#7bd88f" }}>
          Passcode auto-repaired by name ({rep.repaired.length}): <span style={{ color: "#cfcabb" }}>{rep.repaired.slice(0, 12).map((r) => r.name).join(", ")}{rep.repaired.length > 12 ? "…" : ""}</span>
        </div>
      )}
      {rep.missingData.length > 0 && (
        <div style={{ marginTop: 8, color: "#ffb454" }}>
          Not in engine database — real card too new, or genuinely wrong/absent ({rep.missingData.length}): <span style={{ color: "#cfcabb" }}>{rep.missingData.slice(0, 15).join(", ")}{rep.missingData.length > 15 ? "…" : ""}</span>
        </div>
      )}
      {rep.missingScripts.length > 0 && (
        <div style={{ marginTop: 6, color: "#9aa2b1" }}>
          No effect script (will play as vanilla): <span style={{ color: "#cfcabb" }}>{rep.missingScripts.slice(0, 12).join(", ")}{rep.missingScripts.length > 12 ? "…" : ""}</span>
        </div>
      )}
      {rep.unsupported && rep.unsupported.length > 0 && (
        <div style={{ marginTop: 6, color: "#ff6b6b", fontWeight: 700 }}>
          Skipped — too new to have a working script ({rep.unsupported.length}): <span style={{ color: "#cfcabb", fontWeight: 400 }}>{rep.unsupported.slice(0, 12).join(", ")}{rep.unsupported.length > 12 ? "…" : ""}</span>
        </div>
      )}
      {rep.movedToExtra && rep.movedToExtra.length > 0 && (
        <div style={{ marginTop: 6, color: "#6fb6ff" }}>
          Moved to Extra Deck (were in your Main list) ({rep.movedToExtra.length}): <span style={{ color: "#cfcabb" }}>{rep.movedToExtra.slice(0, 12).join(", ")}{rep.movedToExtra.length > 12 ? "…" : ""}</span>
        </div>
      )}
      {typeof rep.playableMain === "number" && (
        <div style={{ marginTop: 6, color: rep.playableMain >= 40 ? "#7bd88f" : "#ffb454" }}>
          Playable into the engine: {rep.playableMain} main / {rep.playableExtra} extra {rep.playableMain >= 40 ? "✓" : "⚠ (need 40+ main)"}
        </div>
      )}
      {!rep.libsBroken && rep.missingData.length === 0 && (!rep.unsupported || rep.unsupported.length === 0) && <div style={{ color: "#7bd88f", marginTop: 6 }}>All cards resolved cleanly. ✓</div>}
    </div>
  );
}

/* ====================================================================== */
/*  ENGINE DUEL (Phase 3) — playable, fully rules-enforced by ocgcore.     */
/*  Effects resolve automatically; you only answer the engine's prompts.   */
/* ====================================================================== */
const POSLABEL = (p) => (p & 10) ? "SET" : (p & 4) ? "DEF" : "ATK"; // FACEDOWN=10, DEF=4
function EngineDuel({ main, extra }) {
  const [status, setStatus] = useState("idle"); // idle|loading|playing|ended|error
  const [err, setErr] = useState("");
  const [board, setBoard] = useState(null);
  const [prompt, setPrompt] = useState(null);
  const [pick, setPick] = useState([]);          // multi-select buffer for SELECT_CARD
  const [placeSel, setPlaceSel] = useState([]);  // chosen zones for SELECT_PLACE
  const [log, setLog] = useState([]);
  const [diag, setDiag] = useState(false);
  const [flare, setFlare] = useState(null); // {kind,n} reactive arena flash
  const [shaking, setShaking] = useState(false);
  const [summonSpot, setSummonSpot] = useState(null); // {card,n} 3D pop-out on summon
  const [turnInfo, setTurnInfo] = useState({ n: 0, player: 0, phase: "" }); // MD turn chip
  const [turnFlash, setTurnFlash] = useState(0);       // triggers the TURN CHANGE banner
  const [report, setReport] = useState(null);          // deck-load diagnostic {mainLoaded,...}
  const [prep, setPrep] = useState("");                // loading sub-status text
  const [showBand, setShowBand] = useState(true);      // ⓘ — dark instruction band
  const [arenaLog, setArenaLog] = useState(false);     // 🗒 — recent log overlaid on the arena
  const [logOpen, setLogOpen] = useState(false);       // engine log runs in the background; toggle to peek
  const [oppChoice, setOppChoice] = useState("Legendary Beatdown"); // opponent deck
  const [oppNames, setOppNames] = useState([]);        // your saved decks, usable as the opponent
  const [dmgFloat, setDmgFloat] = useState(null);      // floating damage number {n,amt,who}
  useEffect(() => { (async () => setOppNames((await store.get("deck_index")) || []))(); }, []);
  // Resolve the chosen opponent deck into {main,extra} card-lists (or null = mirror your deck)
  const buildOppDeck = async () => {
    if (oppChoice === "__mirror") return null;
    if (OPP_DECKS[oppChoice]) return { main: expandOppDeck(OPP_DECKS[oppChoice]), extra: [] };
    const raw = await store.get(`deck:${oppChoice}`);
    if (raw) { try { const d = JSON.parse(raw); return { main: d.main || [], extra: d.extra || [] }; } catch {} }
    return null;
  };
  const core = useRef(null), handle = useRef(null), mod = useRef(null), db = useRef(null), fxN = useRef(0);
  const lastSel = useRef(null), turnRef = useRef(0);
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const doFlare = (kind) => { fxN.current += 1; setFlare({ kind, n: fxN.current }); };
  const doShake = () => { setShaking(true); setTimeout(() => setShaking(false), 420); };
  // build a card object for the PopCard from a passcode
  const cardObjFromCode = (code) => {
    try {
      const r = db.current.exec(`SELECT type,atk,def,level FROM datas WHERE id=${code}`);
      const v = r?.[0]?.values?.[0] || [];
      const t = Number(v[0]) >>> 0;
      const ft = (t & 0x4) ? "trap" : (t & 0x2) ? "spell" : (t & 0x4000000) ? "link" : (t & 0x800000) ? "xyz" : (t & 0x2000) ? "synchro" : (t & 0x40) ? "fusion" : (t & 0x80) ? "ritual" : (t & 0x10) ? "normal" : "effect";
      return { id: code, name: nameOf(code), frameType: ft, type: ft, atk: (t & 0x1) ? Number(v[1]) : null, def: (t & 0x1) ? Number(v[2]) : null, level: (t & 0x1) ? (Number(v[3]) & 0xff) : null };
    } catch { return { id: code, name: nameOf(code), frameType: "effect", type: "", atk: null, def: null, level: null }; }
  };
  const spotlightSummon = (code) => { fxN.current += 1; setSummonSpot({ card: cardObjFromCode(code), n: fxN.current }); setTimeout(() => setSummonSpot((s) => (s && s.n === fxN.current ? null : s)), 1300); };

  const logLine = (s) => setLog((l) => [...l.slice(-160), s]);
  const nameOf = (code) => {
    try { const r = db.current.exec(`SELECT name FROM texts WHERE id=${code}`); return r?.[0]?.values?.[0]?.[0] || `#${code}`; } catch { return `#${code}`; }
  };
  const descOf = (code) => {
    try { const r = db.current.exec(`SELECT desc FROM texts WHERE id=${code}`); return r?.[0]?.values?.[0]?.[0] || ""; } catch { return ""; }
  };
  // cards the human can act on RIGHT NOW, from the current prompt — used to show
  // their effect text and highlight the effects that are currently usable.
  const effectCards = () => {
    const p = prompt, m = mod.current;
    if (!p || !m) return [];
    const seen = new Map();
    const add = (code, tag) => {
      if (code == null) return;
      const prev = seen.get(code);
      if (prev) { if (tag && !prev.tags.includes(tag)) prev.tags.push(tag); return; }
      seen.set(code, { code, name: nameOf(code), desc: descOf(code), tags: tag ? [tag] : [] });
    };
    (p.activates || []).forEach((c) => add(c.code, "ACTIVATE EFFECT"));
    (p.chains || []).forEach((c) => add(c.code, "ACTIVATE EFFECT"));
    (p.special_summons || []).forEach((c) => add(c.code, "SPECIAL SUMMON"));
    (p.summons || []).forEach((c) => add(c.code, "NORMAL SUMMON"));
    (p.monster_sets || []).forEach((c) => add(c.code, "SET"));
    (p.spell_sets || []).forEach((c) => add(c.code, "SET"));
    (p.pos_changes || []).forEach((c) => add(c.code, "CHANGE POSITION"));
    (p.attacks || []).forEach((c) => add(c.code, "ATTACK"));
    (p.selects || []).forEach((c) => add(c.code, "SELECT"));
    return [...seen.values()];
  };

  const readBoard = () => {
    const c = core.current, h = handle.current, m = mod.current;
    const L = m.OcgLocation, QF = m.OcgQueryFlags;
    const flags = QF.CODE | QF.POSITION | QF.ATTACK | QF.DEFENSE | QF.LEVEL;
    // NOTE: the query field is `controller` (not `team`) — passing `team` reads
    // player 0 for both sides, which is why the opponent's board mirrored yours.
    const loc = (t, location) => c.duelQueryLocation(h, { controller: t, location, flags }) || [];
    let lp = [8000, 8000];
    try { const f = c.duelQueryField(h); if (f?.players) lp = [f.players[0]?.lp ?? 8000, f.players[1]?.lp ?? 8000]; } catch {}
    const side = (t) => {
      const mz = loc(t, L.MZONE);   // 7 slots: 0–4 main monster zones, 5–6 the shared EMZs
      const sz = loc(t, L.SZONE);   // 8 slots: 0–4 S/T, 5 field spell, 6–7 pendulum
      return {
        lp: lp[t],
        mon: [0, 1, 2, 3, 4].map((i) => mz[i] || null),   // keep empty slots → cards stay in their real zones
        emz: [mz[5] || null, mz[6] || null],
        st: [0, 1, 2, 3, 4].map((i) => sz[i] || null),
        fieldZone: sz[5] || null,
        hand: loc(t, L.HAND).filter(Boolean),
        grave: c.duelQueryCount(h, t, L.GRAVE), deck: c.duelQueryCount(h, t, L.DECK), extra: c.duelQueryCount(h, t, L.EXTRA),
      };
    };
    setBoard({ me: side(0), opp: side(1) });
  };

  const isSelect = (m, MT) => [MT.SELECT_BATTLECMD, MT.SELECT_IDLECMD, MT.SELECT_EFFECTYN, MT.SELECT_YESNO, MT.SELECT_OPTION, MT.SELECT_CARD, MT.SELECT_CHAIN, MT.SELECT_PLACE, MT.SELECT_POSITION, MT.SELECT_TRIBUTE, MT.SELECT_SUM, MT.SELECT_UNSELECT_CARD].includes(m.type);

  // minimal auto-resolution (used for the human's complex selects we don't
  // have a UI for yet, so the game never deadlocks)
  const autoResponse = (m, RT, IA, BA, MT) => {
    switch (m.type) {
      case MT.SELECT_IDLECMD: return { type: RT.SELECT_IDLECMD, action: IA.TO_EP, index: null };
      case MT.SELECT_BATTLECMD: return { type: RT.SELECT_BATTLECMD, action: BA.TO_EP, index: null };
      case MT.SELECT_CHAIN: return { type: RT.SELECT_CHAIN, index: null };
      case MT.SELECT_EFFECTYN: return { type: RT.SELECT_EFFECTYN, yes: false };
      case MT.SELECT_YESNO: return { type: RT.SELECT_YESNO, yes: false };
      case MT.SELECT_OPTION: return { type: RT.SELECT_OPTION, index: 0 };
      case MT.SELECT_CARD: return { type: RT.SELECT_CARD, indicies: Array.from({ length: m.min }, (_, i) => i) };
      case MT.SELECT_TRIBUTE: return { type: RT.SELECT_TRIBUTE, indicies: Array.from({ length: m.min }, (_, i) => i) };
      case MT.SELECT_SUM: return { type: RT.SELECT_SUM, indicies: [...(m.selects_must || []).map((_, i) => i), ...Array.from({ length: Math.max(0, m.min) }, (_, i) => i)] };
      case MT.SELECT_UNSELECT_CARD: return { type: RT.SELECT_UNSELECT_CARD, index: 0 };
      case MT.SELECT_POSITION: return { type: RT.SELECT_POSITION, position: firstPos(m.positions) };
      case MT.SELECT_PLACE: case MT.SELECT_DISFIELD: return { type: m.type === MT.SELECT_DISFIELD ? RT.SELECT_DISFIELD : RT.SELECT_PLACE, places: firstPlaces(m, 1) };
      default: return { type: RT.SELECT_YESNO, yes: false };
    }
  };
  // the AI opponent (Player 2): plays its OWN line — varied, not a mirror.
  const rnd = (n) => Math.floor(Math.random() * n);
  const oppResponse = (m, RT, IA, BA, MT) => {
    switch (m.type) {
      case MT.SELECT_IDLECMD: {
        // occasionally set a monster or backrow instead of always summoning the first card
        if (m.summons?.length && Math.random() < 0.75) return { type: RT.SELECT_IDLECMD, action: IA.SELECT_SUMMON, index: rnd(m.summons.length) };
        if (m.monster_sets?.length && Math.random() < 0.5) return { type: RT.SELECT_IDLECMD, action: IA.SELECT_MONSTER_SET, index: rnd(m.monster_sets.length) };
        if (m.spell_sets?.length && Math.random() < 0.6) return { type: RT.SELECT_IDLECMD, action: IA.SELECT_SPELL_SET, index: rnd(m.spell_sets.length) };
        if (m.activates?.length && Math.random() < 0.4) return { type: RT.SELECT_IDLECMD, action: IA.SELECT_ACTIVATE, index: rnd(m.activates.length) };
        if (m.to_bp) return { type: RT.SELECT_IDLECMD, action: IA.TO_BP, index: null };
        return { type: RT.SELECT_IDLECMD, action: IA.TO_EP, index: null };
      }
      case MT.SELECT_BATTLECMD:
        if (m.attacks?.length) return { type: RT.SELECT_BATTLECMD, action: BA.SELECT_BATTLE, index: rnd(m.attacks.length) };
        return { type: RT.SELECT_BATTLECMD, action: m.to_ep ? BA.TO_EP : BA.TO_M2, index: null };
      case MT.SELECT_CARD: case MT.SELECT_TRIBUTE: return { type: m.type === MT.SELECT_TRIBUTE ? RT.SELECT_TRIBUTE : RT.SELECT_CARD, indicies: Array.from({ length: m.min }, (_, i) => i) };
      case MT.SELECT_CHAIN: return { type: RT.SELECT_CHAIN, index: m.forced ? 0 : null };
      case MT.SELECT_EFFECTYN: return { type: RT.SELECT_EFFECTYN, yes: Math.random() < 0.6 };
      case MT.SELECT_YESNO: return { type: RT.SELECT_YESNO, yes: Math.random() < 0.5 };
      case MT.SELECT_POSITION: return { type: RT.SELECT_POSITION, position: firstPos(m.positions) };
      default: return autoResponse(m, RT, IA, BA, MT);
    }
  };
  const isMultiSel = (p) => { const MT = mod.current.OcgMessageType; return p && (p.type === MT.SELECT_CARD || p.type === MT.SELECT_TRIBUTE); };
  const confirmSelect = (cancel) => {
    const MT = mod.current.OcgMessageType, RT = mod.current.OcgResponseType;
    const rt = prompt.type === MT.SELECT_TRIBUTE ? RT.SELECT_TRIBUTE : RT.SELECT_CARD;
    respond({ type: rt, indicies: cancel ? null : pick });
  };
  const firstPos = (mask) => [1, 4, 2, 8].find((p) => mask & p) || 1;
  const firstPlaces = (m, n) => {
    const L = mod.current.OcgLocation, out = [];
    for (let seq = 0; seq < 7 && out.length < (n || m.count); seq++) if (!(m.field_mask & (1 << seq))) out.push({ player: m.player, location: L.MZONE, sequence: seq });
    for (let seq = 0; seq < 5 && out.length < (n || m.count); seq++) if (!(m.field_mask & (1 << (8 + seq)))) out.push({ player: m.player, location: L.SZONE, sequence: seq });
    return out.length ? out : [{ player: m.player, location: L.MZONE, sequence: 0 }];
  };
  // human-readable title + instruction for the current decision — so it's always
  // clear WHAT you're being asked to do (target, tribute, zone, respond, …).
  const promptMeta = (p) => {
    const MT = mod.current.OcgMessageType;
    switch (p.type) {
      case MT.SELECT_IDLECMD: return { title: "Main Phase — your move", hint: "Summon or set a monster, set/activate a Spell or Trap, or end your turn." };
      case MT.SELECT_BATTLECMD: return { title: "Battle Phase", hint: "Declare an attack, or advance to Main Phase 2 / End Turn." };
      case MT.SELECT_CHAIN: return { title: p.forced ? "Mandatory response" : "Response window", hint: p.forced ? "You must activate one of these effects." : "You may chain an effect in response — or pass." };
      case MT.SELECT_EFFECTYN: return { title: "Activate this effect?", hint: "Choose whether to apply the card's optional effect." };
      case MT.SELECT_YESNO: return { title: "Yes or No", hint: "Answer the card's question." };
      case MT.SELECT_OPTION: return { title: "Choose an effect", hint: "This card offers more than one effect — pick which to use." };
      case MT.SELECT_CARD: return { title: "Select target(s)", hint: `Pick ${p.min}${p.max > p.min ? `–${p.max}` : ""} card${p.max > 1 ? "s" : ""}. These are your targets or the cards to act on.` };
      case MT.SELECT_TRIBUTE: return { title: "Select tribute(s)", hint: `Choose ${p.min}${p.max > p.min ? `–${p.max}` : ""} monster(s) to Tribute.` };
      case MT.SELECT_POSITION: return { title: "Battle position", hint: "Choose the position to place this card." };
      case MT.SELECT_PLACE: case MT.SELECT_DISFIELD: return { title: "Choose a zone", hint: `Pick where to place ${(p.count || 1) > 1 ? `${p.count} cards` : "the card"}.` };
      default: return { title: "Your decision", hint: "" };
    }
  };
  const isPlace = (p) => { const MT = mod.current.OcgMessageType; return p && (p.type === MT.SELECT_PLACE || p.type === MT.SELECT_DISFIELD); };
  const availablePlaces = (m) => {
    const L = mod.current.OcgLocation, out = [];
    for (let seq = 0; seq < 7; seq++) if (!(m.field_mask & (1 << seq))) out.push({ player: m.player, location: L.MZONE, sequence: seq, label: seq < 5 ? `Monster ${seq + 1}` : `Extra Monster ${seq - 4}` });
    for (let seq = 0; seq < 5; seq++) if (!(m.field_mask & (1 << (8 + seq)))) out.push({ player: m.player, location: L.SZONE, sequence: seq, label: `Spell/Trap ${seq + 1}` });
    return out;
  };
  const confirmPlace = () => {
    const MT = mod.current.OcgMessageType, RT = mod.current.OcgResponseType;
    const places = placeSel.length ? placeSel : firstPlaces(prompt);
    respond({ type: prompt.type === MT.SELECT_DISFIELD ? RT.SELECT_DISFIELD : RT.SELECT_PLACE, places });
  };
  // guaranteed-safe escape hatch: let the engine resolve the current prompt the
  // old automatic way (used if a manual selection isn't behaving as expected).
  const autoResolveCurrent = () => {
    const m = mod.current;
    respond(autoResponse(prompt, m.OcgResponseType, m.SelectIdleCMDAction, m.SelectBattleCMDAction, m.OcgMessageType));
  };

  const drive = async () => {
    const c = core.current, h = handle.current, m = mod.current;
    const MT = m.OcgMessageType, PR = m.OcgProcessResult, RT = m.OcgResponseType, IA = m.SelectIdleCMDAction, BA = m.SelectBattleCMDAction;
    // selections we resolve automatically for the human (no meaningful choice / no UI yet)
    // zone placement is now a real player choice (see the SELECT_PLACE picker);
    // SUM/COUNTER/UNSELECT stay auto for now but are logged transparently below.
    const AUTO = [MT.SELECT_SUM, MT.SELECT_UNSELECT_CARD, MT.SELECT_COUNTER];
    const PHNAME = { 0x01: "Draw", 0x02: "Standby", 0x04: "Main 1", 0x08: "Battle Start", 0x10: "Battle Step", 0x20: "Damage", 0x40: "Damage Calc", 0x80: "Battle", 0x100: "Main 2", 0x200: "End" };
    let guard = 0, autoStreak = 0;
    while (guard++ < 8000) {
      const st = c.duelProcess(h);
      const msgs = c.duelGetMessage(h) || [];
      let shown = false, fxRed = false, fxGold = false, fxShake = false, summonCode = null, dmgAmt = 0, dmgWho = 1;
      for (const msg of msgs) {
        if (msg.type === MT.HINT) continue;
        const nm = (m.ocgMessageTypeStrings?.get?.(msg.type)) || `msg#${msg.type}`;
        if ([MT.DRAW, MT.SUMMONING, MT.SPSUMMONING, MT.MOVE, MT.CHAINING, MT.SET, MT.FLIPSUMMONING, MT.ATTACK, MT.DAMAGE, MT.RECOVER, MT.NEW_TURN, MT.NEW_PHASE].includes(msg.type)) {
          logLine("• " + nm.toLowerCase().replace(/_/g, " ")); shown = true;
        }
        if (msg.type === MT.NEW_TURN) { turnRef.current += 1; setTurnInfo((t) => ({ ...t, n: turnRef.current, player: msg.player })); fxN.current += 1; setTurnFlash(fxN.current); }
        else if (msg.type === MT.NEW_PHASE) setTurnInfo((t) => ({ ...t, phase: PHNAME[msg.phase] || "" }));
        if (msg.type === MT.DAMAGE) { fxRed = true; fxShake = true; const a = msg.amount ?? msg.value ?? msg.damage ?? 0; if (a) { dmgAmt = a; dmgWho = msg.player ?? 1; } }
        else if (msg.type === MT.ATTACK) fxShake = true;
        else if ([MT.SUMMONING, MT.SPSUMMONING, MT.FLIPSUMMONING].includes(msg.type)) { fxGold = true; if (msg.code) summonCode = msg.code; }
        if (isSelect(msg, MT)) lastSel.current = msg;  // remember across batches — the WAITING result can land a batch after its select message
      }
      readBoard();
      if (fxRed) { doFlare("red"); Sound.sfx("damage"); } else if (fxGold) { doFlare("gold"); Sound.sfx("summon"); }
      if (fxShake) { doShake(); if (!fxRed) Sound.sfx("attack"); }
      if (dmgAmt) { fxN.current += 1; const id = fxN.current; setDmgFloat({ n: id, amt: dmgAmt, who: dmgWho }); setTimeout(() => setDmgFloat((d) => (d && d.n === id ? null : d)), 1150); }
      if (summonCode) spotlightSummon(summonCode);
      if (st === PR.END) { setStatus("ended"); setPrompt(null); return; }
      if (st === PR.WAITING) {
        const sel = [...msgs].reverse().find((x) => isSelect(x, MT)) || lastSel.current;
        if (!sel) { logLine("⚠ engine is waiting but no selection request was seen — stopping"); return; }
        if (sel.player !== 0) { c.duelSetResponse(h, oppResponse(sel, RT, IA, BA, MT)); lastSel.current = null; if (++autoStreak > 600) { logLine("⚠ opponent stalled — stopping"); return; } await sleep(260); continue; } // AI opponent, paced
        if (AUTO.includes(sel.type)) { logLine("⚙ auto-resolved for you: " + (((m.ocgMessageTypeStrings?.get?.(sel.type)) || ("msg#" + sel.type)).toLowerCase().replace(/select_/, "").replace(/_/g, " ")) + " (cost / selection handled automatically)"); c.duelSetResponse(h, autoResponse(sel, RT, IA, BA, MT)); lastSel.current = null; if (++autoStreak > 600) { logLine("⚠ engine stalled on a selection — stopping"); return; } continue; }
        autoStreak = 0;
        setPick([]); setPlaceSel([]); setPrompt(sel); return; // a real decision → hand off to the human
      }
      autoStreak = 0;
      if (shown) await sleep(summonCode ? 900 : 150); // let animations / the summon spotlight breathe
      // CONTINUE → keep processing
    }
    logLine("⚠ processing cap reached — stopping");
  };

  const respond = (resp) => {
    try { core.current.duelSetResponse(handle.current, resp); lastSel.current = null; setPrompt(null); setPick([]); setPlaceSel([]); drive(); }
    catch (e) { setErr(String(e?.message || e)); setStatus("error"); }
  };

  const start = async () => {
    setStatus("loading"); setErr(""); setLog([]); setPrompt(null); setBoard(null);
    lastSel.current = null; turnRef.current = 0; setTurnInfo({ n: 0, player: 0, phase: "" }); setTurnFlash(0); setReport(null); setPrep("");
    try {
      if (!main.length) throw new Error("Build a deck first (Deck Editor tab).");
      // sql.js + cdb
      await loadScript(ENGINE.sqljsScript);
      const SQL = await window.initSqlJs({ locateFile: () => ENGINE.sqlWasm });
      db.current = new SQL.Database(new Uint8Array(await (await fetch(ENGINE.cdb)).arrayBuffer()));
      // merge supplementary databases (new sets not yet in the main cards.cdb,
      // e.g. Chaos Origins) so their real passcodes resolve
      for (const url of ENGINE.extraCdbs || []) {
        setPrep(`Loading card set: ${url.split("/").pop()}…`);
        try {
          const eb = new Uint8Array(await (await fetch(url)).arrayBuffer());
          const ext = new SQL.Database(eb);
          const n = mergeCdb(db.current, ext);
          try { ext.close(); } catch {}
          logLine(`+${n} rows from ${url.split("/").pop()}`);
        } catch (e) { logLine("⚠ couldn't load " + url.split("/").pop() + " — " + (e?.message || e)); }
      }
      // engine
      const m = await loadEngineMod(); mod.current = m;
      const c = await m.default({ sync: true }); core.current = c;
      const L = m.OcgLocation, MODE = m.OcgDuelMode, POS = m.OcgPosition;

      // the shared Lua libraries every card script depends on (constants, aux,
      // and the Normal/Fusion/Synchro/Xyz/Link/etc. summon procedures)
      const BASE = [
        "constant.lua", "archetype_setcode_constants.lua", "card_counter_constants.lua",
        "utility.lua", "cards_specific_functions.lua", "chain.lua", "deprecated_functions.lua",
        "proc_normal.lua", "proc_equip.lua", "proc_fusion.lua", "proc_fusion_spell.lua", "proc_ritual.lua",
        "proc_synchro.lua", "proc_xyz.lua", "proc_link.lua", "proc_pendulum.lua", "proc_gemini.lua",
        "proc_spirit.lua", "proc_union.lua", "proc_maximum.lua", "proc_persistent.lua", "proc_workaround.lua",
      ];

      // ---- resolve every deck card against the engine database FIRST --------
      const resolve = makeCodeResolver(db.current);
      const resolveByName = makeNameResolver(db.current);
      const nameById = {};
      [...main, ...extra].forEach((cd) => { nameById[Number(cd.id)] = cd.name || String(cd.id); });
      const resolveList = (list) => {
        const ok = [], missing = [], repaired = [];
        for (const cd of list) {
          let code = resolve(cd.id);
          if (!code && cd.name) {                       // wrong/absent passcode → recover by NAME
            const byName = resolveByName(cd.name);
            if (byName) { code = byName; repaired.push({ name: cd.name, id: byName }); nameById[byName] = cd.name; }
          }
          if (code) ok.push(code); else missing.push(cd.name || String(cd.id));
        }
        return { ok, missing, repaired };
      };
      const mainR = resolveList(main), extraR = resolveList(extra);

      // ---- resolve the OPPONENT's (separate) deck --------------------------
      const oppDeck = await buildOppDeck();               // null → mirror your deck
      const oppMainR = oppDeck ? resolveList(oppDeck.main) : mainR;
      const oppExtraR = oppDeck ? resolveList(oppDeck.extra) : extraR;
      const oppLabel = oppDeck ? oppChoice : "Mirror (your deck)";

      // ---- PREWARM every script via async fetch (sandbox/CORS-safe) ---------
      // this is the fix for the "sandbox breaks the duel" problem: no blocking
      // cross-origin request ever happens while the engine is running.
      const cardFiles = [...new Set([...mainR.ok, ...extraR.ok, ...oppMainR.ok, ...oppExtraR.ok])].map((code) => `c${code}.lua`);
      setPrep("Downloading rules + card scripts…");
      await prewarmScripts([...BASE, ...cardFiles], (d, n) => setPrep(`Downloading scripts… ${d}/${n}`));
      setPrep("Starting engine…");

      const h = c.createDuel({
        flags: MODE?.MODE_MR5 ?? 0n, seed: rndSeed(),
        team1: { startingLP: 8000, startingDrawCount: 5, drawCountPerTurn: 1 },
        team2: { startingLP: 8000, startingDrawCount: 5, drawCountPerTurn: 1 },
        cardReader: makeCardReader(db.current), scriptReader: syncScript,
        errorHandler: (t, text) => logLine("⚠ " + text),
      });
      if (!h) throw new Error("createDuel returned null");
      handle.current = h;

      // load rule libraries (now all cache hits)
      let libFail = 0;
      for (const nm of BASE) {
        const t = syncScript(nm);
        if (!t) { libFail++; continue; }
        try { c.loadScript(h, nm, t); } catch (e) { libFail++; logLine("⚠ lib " + nm + ": " + (e?.message || e)); }
      }
      logLine(`rules libraries: ${BASE.length - libFail}/${BASE.length} loaded.`);
      const libsBroken = libFail > BASE.length / 2; // sandbox almost certainly blocked fetches

      // ---- add cards (deduped codes already resolved) ----------------------
      const scriptMissing = new Set();
      for (const code of [...new Set([...mainR.ok, ...extraR.ok, ...oppMainR.ok, ...oppExtraR.ok])]) {
        if (engineScriptCache.get(`c${code}.lua`) == null && !isVanillaCode(db.current, code)) scriptMissing.add(nameById[code] || code);
      }
      const add = (team, codes, location) => codes.forEach((code) =>
        c.duelNewCard(h, { team, duelist: 0, code, controller: team, location, sequence: 2, position: POS?.FACEDOWN_DEFENSE ?? 8 }));
      // a card is playable only if the engine has a Lua script for it — OR it's
      // a vanilla Normal Monster (which needs none). Cards too new to be scripted
      // are dropped from the duel (and reported) so a single unscripted card can
      // never crash the engine mid-duel (the "attempt to call an error function").
      const scriptOK = (code) => isVanillaCode(db.current, code) || engineScriptCache.get(`c${code}.lua`) != null;
      const skippedNames = [];
      const keepPlayable = (codes) => codes.filter((code) => { if (scriptOK(code)) return true; skippedNames.push(nameById[code] || String(code)); return false; });
      // route every resolved+playable card by its REAL engine type: Extra-Deck
      // monsters (Fusion/Synchro/Xyz/Link) ALWAYS go to the Extra Deck, never the
      // main deck — otherwise a mis-categorised import shuffles them into the draw
      // pile and they turn up in the opening hand.
      const splitDeck = (mainCodes, extraCodes) => {
        const toMain = [], toExtra = [...keepPlayable(extraCodes)];
        for (const code of keepPlayable(mainCodes)) (isExtraDeckCode(db.current, code) ? toExtra : toMain).push(code);
        return { toMain, toExtra };
      };
      const you = splitDeck(mainR.ok, extraR.ok);
      const them = splitDeck(oppMainR.ok, oppExtraR.ok);
      add(0, you.toMain, L.DECK); add(0, you.toExtra, L.EXTRA);
      add(1, them.toMain, L.DECK); add(1, them.toExtra, L.EXTRA);   // ← opponent's OWN deck
      const unsupported = [...new Set(skippedNames)];
      // Extra-Deck monsters that were sitting in the main-deck list (moved for you)
      const movedToExtra = [...new Set(mainR.ok.filter((code) => scriptOK(code) && isExtraDeckCode(db.current, code)).map((code) => nameById[code] || String(code)))];

      // ---- diagnostic report -----------------------------------------------
      const oppMainTotal = oppDeck ? oppDeck.main.length : main.length;
      const oppExtraTotal = oppDeck ? oppDeck.extra.length : extra.length;
      const rep = {
        mainLoaded: mainR.ok.length, mainTotal: main.length,
        extraLoaded: extraR.ok.length, extraTotal: extra.length,
        missingData: [...mainR.missing, ...extraR.missing],
        missingScripts: [...scriptMissing],
        repaired: [...(mainR.repaired || []), ...(extraR.repaired || [])],
        libsBroken,
        oppLabel, oppMainLoaded: oppMainR.ok.length, oppMainTotal,
        oppExtraLoaded: oppExtraR.ok.length, oppExtraTotal,
        oppMissing: oppDeck ? [...oppMainR.missing, ...oppExtraR.missing] : [],
        unsupported, movedToExtra,
        playableMain: you.toMain.length, playableExtra: you.toExtra.length,
      };
      setReport(rep);
      logLine(`your deck: ${rep.mainLoaded}/${rep.mainTotal} main, ${rep.extraLoaded}/${rep.extraTotal} extra.`);
      logLine(`opponent (${oppLabel}): ${rep.oppMainLoaded}/${rep.oppMainTotal} main.`);

      // ---- guardrails: refuse to start a broken/illegal duel ---------------
      if (libsBroken) {
        setErr("The rule scripts couldn't be downloaded — this is the sandbox/CORS block. The duel can't run here. Open the app in a normal browser tab (not an embedded/sandboxed frame), or deploy it to a host that allows cross-origin script fetches. See the deck-load report below.");
        setStatus("error"); return;
      }
      if (you.toMain.length < 40) {
        const why = [];
        if (unsupported.length) why.push(`skipped as too new / unscripted: ${unsupported.slice(0, 10).join(", ")}${unsupported.length > 10 ? "…" : ""}`);
        if (rep.missingData.length) why.push(`not in engine database: ${rep.missingData.slice(0, 10).join(", ")}${rep.missingData.length > 10 ? "…" : ""}`);
        if (movedToExtra.length) why.push(`${movedToExtra.length} Extra-Deck monster(s) moved out of your Main Deck`);
        setErr(`Your Main Deck has only ${you.toMain.length} playable Main-Deck cards (needs 40–60).${why.length ? " " + why.join("; ") + "." : " Add more Main Deck cards in the Deck Editor."}`);
        setStatus("error"); return;
      }
      if (them.toMain.length < 40) {
        setErr(`The opponent deck "${oppLabel}" has only ${them.toMain.length} playable cards (needs 40+). ${rep.oppMissing.length ? "Missing from the engine database: " + rep.oppMissing.slice(0, 10).join(", ") : "Pick a different opponent deck."}`);
        setStatus("error"); return;
      }

      setPrep("");
      c.startDuel(h);
      setStatus("playing");
      logLine("duel started — you are Player 1");
      drive();
    } catch (e) { setErr(String(e?.message || e)); setStatus("error"); }
  };

  // ---- prompt → buttons ------------------------------------------------
  const promptButtons = () => {
    const m = mod.current, p = prompt;
    const RT = m.OcgResponseType, IA = m.SelectIdleCMDAction, BA = m.SelectBattleCMDAction, MT = m.OcgMessageType;
    const B = [];
    const push = (label, resp, tone) => B.push({ label, resp, tone });
    if (p.type === MT.SELECT_IDLECMD) {
      p.summons?.forEach((c, i) => push(`Summon ${nameOf(c.code)}`, { type: RT.SELECT_IDLECMD, action: IA.SELECT_SUMMON, index: i }, "good"));
      p.special_summons?.forEach((c, i) => push(`Special Summon ${nameOf(c.code)}`, { type: RT.SELECT_IDLECMD, action: IA.SELECT_SPECIAL_SUMMON, index: i }, "good"));
      p.monster_sets?.forEach((c, i) => push(`Set (monster) ${nameOf(c.code)}`, { type: RT.SELECT_IDLECMD, action: IA.SELECT_MONSTER_SET, index: i }));
      p.spell_sets?.forEach((c, i) => push(`Set ${nameOf(c.code)}`, { type: RT.SELECT_IDLECMD, action: IA.SELECT_SPELL_SET, index: i }));
      p.activates?.forEach((c, i) => push(`Activate ${nameOf(c.code)}`, { type: RT.SELECT_IDLECMD, action: IA.SELECT_ACTIVATE, index: i }, "gold"));
      p.pos_changes?.forEach((c, i) => push(`Change position: ${nameOf(c.code)}`, { type: RT.SELECT_IDLECMD, action: IA.SELECT_POS_CHANGE, index: i }));
      if (p.to_bp) push("Go to Battle Phase ⚔", { type: RT.SELECT_IDLECMD, action: IA.TO_BP, index: null }, "gold");
      if (p.to_ep) push("End Turn", { type: RT.SELECT_IDLECMD, action: IA.TO_EP, index: null }, "bad");
    } else if (p.type === MT.SELECT_BATTLECMD) {
      p.attacks?.forEach((c, i) => push(`Attack with ${nameOf(c.code)}${c.can_direct ? " (direct OK)" : ""}`, { type: RT.SELECT_BATTLECMD, action: BA.SELECT_BATTLE, index: i }, "good"));
      p.chains?.forEach((c, i) => push(`Activate ${nameOf(c.code)}`, { type: RT.SELECT_BATTLECMD, action: BA.SELECT_CHAIN, index: i }, "gold"));
      if (p.to_m2) push("Go to Main Phase 2", { type: RT.SELECT_BATTLECMD, action: BA.TO_M2, index: null });
      if (p.to_ep) push("End Turn", { type: RT.SELECT_BATTLECMD, action: BA.TO_EP, index: null }, "bad");
    } else if (p.type === MT.SELECT_CHAIN) {
      p.selects?.forEach((c, i) => push(`Chain ${nameOf(c.code)}`, { type: RT.SELECT_CHAIN, index: i }, "gold"));
      if (!p.forced) push("No response", { type: RT.SELECT_CHAIN, index: null }, "bad");
    } else if (p.type === MT.SELECT_EFFECTYN || p.type === MT.SELECT_YESNO) {
      const rt = p.type === MT.SELECT_EFFECTYN ? RT.SELECT_EFFECTYN : RT.SELECT_YESNO;
      push("Yes", { type: rt, yes: true }, "good"); push("No", { type: rt, yes: false }, "bad");
    } else if (p.type === MT.SELECT_OPTION) {
      p.options?.forEach((o, i) => push(`Option ${i + 1}`, { type: RT.SELECT_OPTION, index: i }));
    } else if (p.type === MT.SELECT_POSITION) {
      [[1, "Face-up ATK"], [4, "Face-up DEF"], [8, "Face-down DEF"], [2, "Face-down ATK"]].forEach(([bit, lab]) => (p.positions & bit) && push(lab, { type: RT.SELECT_POSITION, position: bit }));
    } else if (p.type === MT.SELECT_PLACE) {
      push("Auto-place", { type: RT.SELECT_PLACE, places: firstPlaces(p) }, "good");
    }
    return B;
  };

  if (!main.length) return <Center>Build a deck first — the Deck Editor tab.</Center>;

  if (status === "idle" || status === "loading" || status === "error") return (
    <div style={{ height: "calc(100vh - 60px)", display: "grid", placeItems: "center", padding: 24 }}>
      <div style={{ textAlign: "center", maxWidth: 520 }}>
        <p className="disp" style={{ color: C.gold, fontSize: 18 }}>Duel</p>
        <p style={{ color: C.mute, fontSize: 13, lineHeight: 1.6, margin: "10px 0 14px" }}>
          Plays under the real, current Master Rules with the EDOPro engine — card effects resolve
          automatically, draws and summons are enforced. You pilot <b style={{ color: C.text }}>your</b> deck
          ({main.length} main / {extra.length} extra); the AI pilots the <b style={{ color: C.text }}>separate</b> deck
          you choose below, so you can playtest your build against real opposition. First load fetches
          the engine + card database.
        </p>
        {/* opponent deck picker — a DIFFERENT deck for the AI to pilot */}
        <div style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: 8, marginBottom: 18, flexWrap: "wrap" }}>
          <span style={{ color: C.mute, fontSize: 12 }}>Opponent plays:</span>
          <select value={oppChoice} onChange={(e) => setOppChoice(e.target.value)} disabled={status === "loading"}
            style={{ background: C.panel2, color: C.text, border: `1px solid ${C.line}`, borderRadius: 6, padding: "6px 10px", fontSize: 12, maxWidth: 260 }}>
            <optgroup label="Built-in decks">
              {Object.keys(OPP_DECKS).map((n) => <option key={n} value={n}>{n}</option>)}
            </optgroup>
            {oppNames.length > 0 && <optgroup label="Your saved decks">
              {oppNames.map((n) => <option key={n} value={n}>{n}</option>)}
            </optgroup>}
            <optgroup label="Other">
              <option value="__mirror">Mirror (your own deck)</option>
            </optgroup>
          </select>
        </div>
        {status === "error" && <p className="mono" style={{ color: C.bad, fontSize: 12, marginBottom: 14, wordBreak: "break-word", textAlign: "left", lineHeight: 1.5 }}>❌ {err}</p>}
        <button onClick={start} disabled={status === "loading"} className="disp" style={{ ...btn(), background: C.gold, color: "#1a1206", border: "none", padding: "12px 30px", fontSize: 14, opacity: status === "loading" ? 0.6 : 1 }}>
          {status === "loading" ? "Loading engine…" : status === "error" ? "Try Again" : "Start Duel"}
        </button>
        {status === "loading" && prep && <p className="mono" style={{ color: C.mute, fontSize: 11, marginTop: 10 }}>{prep}</p>}
        {report && <DeckLoadReport rep={report} />}
        <div style={{ marginTop: 16 }}>
          <button onClick={() => setDiag((d) => !d)} style={{ ...miniBar(), fontSize: 10 }}>{diag ? "hide" : "show"} engine diagnostics</button>
        </div>
        {diag && <div style={{ marginTop: 12 }}><EngineBeta main={main} extra={extra} /></div>}
        {log.length > 0 && <div className="mono" style={{ marginTop: 14, textAlign: "left", fontSize: 11, color: C.mute, maxHeight: 160, overflowY: "auto" }}>{log.map((l, i) => <div key={i}>{l}</div>)}</div>}
      </div>
    </div>
  );

  /* one Master Duel zone: an octagonal stone pad; the card (if any) sits on it
     with the MD-style ★level + ATK/DEF readout underneath */
  const Zone = ({ card, faceDown, size = 66, hand = false, opp = false }) => {
    const w = size, h = Math.round(size / 0.686);
    const showBack = !hand && card && (faceDown || (card.position & 10)); // FACEDOWN only on the field, never your hand
    const def = !hand && card && (card.position & 4);
    if (hand) {
      return (
        <div title={card ? nameOf(card.code) : undefined} style={{ width: w, height: h, borderRadius: 5, overflow: "hidden", flexShrink: 0, boxShadow: "0 4px 12px rgba(0,0,0,.5)", background: C.panel2 }}>
          {card && <CardImg id={card.code} variant="small" name={nameOf(card.code)} style={{ width: "100%", height: "100%", objectFit: "cover" }} />}
        </div>
      );
    }
    return (
      <div title={card && !showBack ? nameOf(card.code) : undefined}
        style={{ width: w + 16, height: w + 16, position: "relative", flexShrink: 0, display: "grid", placeItems: "center" }}>
        {/* the stone pad */}
        <div className="octpad stonepad" style={{ position: "absolute", inset: 0, opacity: card ? 0.95 : 0.85 }} />
        {/* the card on the pad */}
        {card && (
          <div key={card.code} className="dcard" style={{ position: "relative", zIndex: 2, width: Math.round(w * 0.74), height: Math.round((w * 0.74) / 0.686), borderRadius: 3, overflow: "hidden", transform: def ? "rotate(90deg) scale(.92)" : "none", boxShadow: "0 3px 10px rgba(0,0,0,.55)", background: C.panel2 }}>
            {showBack
              ? <div style={{ width: "100%", height: "100%", background: `repeating-linear-gradient(45deg,#6e3f16 0 4px,#3c2008 4px 8px)`, display: "grid", placeItems: "center" }}><div style={{ width: "42%", height: "42%", transform: "rotate(45deg)", background: "radial-gradient(circle at 40% 35%, #caa24a, #7a5a18)", borderRadius: 3 }} /></div>
              : <CardImg id={card.code} variant="small" name={nameOf(card.code)} style={{ width: "100%", height: "100%", objectFit: "cover" }} />}
          </div>
        )}
        {/* MD-style ★level + ATK/DEF plate below (above for the opponent) */}
        {card && !showBack && card.attack != null && (
          <div className="mono atkplate" style={{ position: "absolute", zIndex: 3, left: 0, right: 0, [opp ? "top" : "bottom"]: -4 }}>
            {card.level ? <span className="lv">★{card.level} </span> : null}
            <u>{card.attack}</u>/{def ? <b>{card.defense ?? 0}</b> : (card.defense ?? 0)}
          </div>
        )}
      </div>
    );
  };
  const b = board;
  const btns = prompt ? promptButtons() : [];

  const row = (arr, { opp = false } = {}) => (
    <div style={{ display: "flex", gap: 12, justifyContent: "center" }}>
      {Array.from({ length: 5 }, (_, i) => <Zone key={i} card={arr[i]} size={70} opp={opp} />)}
    </div>
  );
  const lastLine = log.length ? log[log.length - 1].replace(/^[•⚠] ?/, "") : "";

  return (
    <div style={{ display: "grid", gridTemplateColumns: "1fr 300px", height: "calc(100vh - 60px)" }}>
      <div style={{ padding: 14, display: "flex", flexDirection: "column", justifyContent: "center", overflow: "auto", background: "#0b0d10" }}>
        <div className={"mdArena" + (shaking ? " shake" : "")} style={{ maxWidth: 980, width: "100%", margin: "0 auto", padding: "42px 56px 36px" }}>
          {flare && <div key={flare.n} className={"flarelayer " + (flare.kind === "red" ? "flare-red" : "flare-gold")} />}

          {/* floating damage number — appears on the side that took the hit */}
          {dmgFloat && (
            <div key={dmgFloat.n} className="dmgfloat"
              style={{ top: dmgFloat.who === 0 ? "70%" : "22%", color: "#ff5566", fontSize: 40 }}>
              −{dmgFloat.amt}
            </div>
          )}

          {/* corner LP plates — opponent top-right, you bottom-left (as in MD) */}
          <div className="lpplateOpp">
            <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end" }}>
              <span className="lpname disp">Duel Partner</span>
              <span className="mono lpnumplate"><span style={{ fontSize: 10, color: "#9aa2b1", marginRight: 6 }}>LP</span><span key={b?.opp.lp} className="lpnum">{b?.opp.lp ?? 8000}</span></span>
            </div>
            <div className="avhex disp">P2</div>
          </div>
          <div className="lpplateMe">
            <div className="avhex disp">P1</div>
            <span className="mono lpnumplate"><span style={{ fontSize: 10, color: "#9aa2b1", marginRight: 6 }}>LP</span><span key={b?.me.lp} className="lpnum">{b?.me.lp ?? 8000}</span></span>
          </div>

          {/* turn chip — red hex, right of the EMZ row like MD */}
          {turnInfo.n > 0 && (
            <div style={{ position: "absolute", right: 26, top: "46%", zIndex: 20, textAlign: "center" }}>
              <div className="turnhex disp"><span>Turn {turnInfo.n}<br /><span style={{ fontSize: 8, color: "#ffceb0" }}>{turnInfo.phase}</span></span></div>
            </div>
          )}

          {/* right rail — MD's circular blue buttons: ⓘ toggles the info band, 🗒 the field log */}
          <div style={{ position: "absolute", right: 22, bottom: "20%", zIndex: 20, display: "flex", flexDirection: "column", gap: 10 }}>
            <button className={"railbtn" + (showBand ? "" : " off")} title="Toggle info band" onClick={() => setShowBand((v) => !v)}>ⓘ</button>
            <button className={"railbtn" + (arenaLog ? "" : " off")} title="Toggle duel log overlay" onClick={() => setArenaLog((v) => !v)}>🗒</button>
          </div>

          {summonSpot && (
            <div key={summonSpot.n} style={{ position: "absolute", inset: 0, zIndex: 24, display: "grid", placeItems: "center", pointerEvents: "none" }}>
              <div className="summonring" />
              <div className="summonpop" style={{ filter: "drop-shadow(0 0 32px rgba(240,210,110,.75))" }}>
                <PopCard card={summonSpot.card} size={190} />
              </div>
            </div>
          )}

          {/* TURN CHANGE — the blue band sweep */}
          {turnFlash > 0 && turnInfo.n > 1 && <div key={turnFlash} className="turnchange"><span>Turn Change</span></div>}

          {b && (
            <div className="mdField" style={{ display: "flex", flexDirection: "column", gap: 10 }}>
              {/* opponent hand — a fanned spread of card-backs, like a real hand held across the table */}
              <div style={{ display: "flex", justifyContent: "center", alignItems: "flex-start", minHeight: 54, perspective: 500 }}>
                <div style={{ display: "flex", justifyContent: "center" }}>
                  {(() => {
                    const cnt = b.opp.hand.length, mid = (cnt - 1) / 2;
                    return Array.from({ length: cnt }, (_, i) => {
                      const off = i - mid;
                      return <div key={i} className="cardback" style={{
                        marginLeft: i === 0 ? 0 : -14,
                        transform: `rotate(${off * 4}deg) translateY(${Math.abs(off) * 3}px)`,
                        transformOrigin: "bottom center", zIndex: i,
                      }} />;
                    });
                  })()}
                </div>
              </div>
              {/* opponent side — red-tinted edge like MD marks enemy territory */}
              <div className="redrow" style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                {row(b.opp.st, { opp: true })}
                {row(b.opp.mon, { opp: true })}
              </div>
              {/* middle band: field spells left/right + the two shared EMZs */}
              <div style={{ display: "flex", gap: 12, justifyContent: "center", alignItems: "center", padding: "2px 0" }}>
                <Zone card={b.opp.fieldZone} size={58} opp />
                <div style={{ flex: 1 }} />
                <Zone card={b.opp.emz[0] || b.me.emz[0]} size={66} />
                <Zone card={b.opp.emz[1] || b.me.emz[1]} size={66} />
                <div style={{ flex: 1 }} />
                <Zone card={b.me.fieldZone} size={58} />
              </div>
              {/* your side — the blue glow along your edge, exactly like MD */}
              <div className="bluerow" style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                {row(b.me.mon)}
                {row(b.me.st)}
              </div>
              {/* deck / GY / extra counters, small and out of the way */}
              <div className="mono" style={{ display: "flex", justifyContent: "space-between", fontSize: 9.5, color: "rgba(40,44,26,.85)", fontWeight: 700, padding: "0 6px" }}>
                <span>P1 · deck {b.me.deck} · GY {b.me.grave} · extra {b.me.extra}</span>
                <span>P2 · deck {b.opp.deck} · GY {b.opp.grave} · extra {b.opp.extra}</span>
              </div>
              {/* your hand — face-up along your edge */}
              <div style={{ display: "flex", gap: 6, justifyContent: "center", flexWrap: "nowrap", overflowX: "auto", minHeight: 118, padding: "6px 2px 2px", alignItems: "flex-end" }}>
                {b.me.hand.map((c, i) => <Zone key={i} card={c} hand size={76} />)}
                {b.me.hand.length === 0 && <span className="mono" style={{ fontSize: 11, color: "rgba(40,44,26,.8)", alignSelf: "center" }}>empty hand</span>}
              </div>
            </div>
          )}
          {!b && <p className="mono" style={{ position: "relative", zIndex: 1, color: "#d9d6c2", fontSize: 12, textAlign: "center" }}>setting up field…</p>}

          {/* MD's dark tutorial/info band across the field */}
          {showBand && lastLine && (
            <div className="mdBand" style={{ position: "absolute", left: 0, right: 0, top: "38%", zIndex: 18, pointerEvents: "none" }}>{lastLine}</div>
          )}
          {/* recent-log overlay (🗒) */}
          {arenaLog && (
            <div className="mono" style={{ position: "absolute", left: 14, top: 46, zIndex: 18, background: "rgba(6,8,10,.78)", border: "1px solid rgba(255,255,255,.14)", borderRadius: 8, padding: "8px 12px", fontSize: 10.5, color: "#e8e6da", maxWidth: 260 }}>
              {log.slice(-6).map((l, i) => <div key={i} style={{ opacity: 0.55 + (i / 12) }}>{l}</div>)}
            </div>
          )}
        </div>
      </div>

      {/* right: prompt + log */}
      <div style={{ borderLeft: `1px solid ${C.line}`, display: "flex", flexDirection: "column", minHeight: 0 }}>
        <div style={{ padding: 12, borderBottom: `1px solid ${C.line}`, minHeight: 180 }}>
          {(() => {
            const meta = prompt ? promptMeta(prompt) : null;
            return (
              <div style={{ marginBottom: 10 }}>
                <div className="disp" style={{ fontSize: 12.5, color: prompt ? C.gold : C.mute, letterSpacing: ".05em" }}>
                  {status === "ended" ? "Duel over" : meta ? `▶ ${meta.title}` : "Engine resolving…"}
                </div>
                {meta && meta.hint && <div className="mono" style={{ fontSize: 11, color: C.text, marginTop: 5, lineHeight: 1.45, opacity: .85 }}>{meta.hint}</div>}
                {!prompt && status !== "ended" && <div className="mono" style={{ fontSize: 10.5, color: C.mute, marginTop: 4 }}>Resolving effects — no input needed.</div>}
              </div>
            );
          })()}
          {status === "ended" && <button onClick={start} className="disp" style={{ ...btn(), background: C.gold, color: "#1a1206", border: "none" }}>New duel</button>}
          {prompt && isMultiSel(prompt) && (
            <div style={{ display: "flex", flexDirection: "column", gap: 5 }}>
              <p className="mono" style={{ fontSize: 11, color: C.gold }}>Select {prompt.min}{prompt.max > prompt.min ? `–${prompt.max}` : ""} card{prompt.max > 1 ? "s" : ""}:</p>
              {(prompt.selects || []).map((c, i) => {
                const on = pick.includes(i);
                return (
                  <button key={i} onClick={() => setPick((p) => p.includes(i) ? p.filter((x) => x !== i) : (p.length < prompt.max ? [...p, i] : p))}
                    style={{ textAlign: "left", background: on ? "rgba(232,184,75,.15)" : C.panel2, border: `1px solid ${on ? C.gold : C.line}`, color: on ? C.gold : C.text, borderRadius: 6, padding: "7px 10px", fontSize: 12 }}>
                    {on ? "✓ " : ""}{nameOf(c.code)}
                  </button>
                );
              })}
              <button disabled={pick.length < prompt.min || pick.length > prompt.max} onClick={() => confirmSelect(false)}
                style={{ ...btn(), marginTop: 4, background: (pick.length >= prompt.min && pick.length <= prompt.max) ? C.good : C.panel2, color: (pick.length >= prompt.min && pick.length <= prompt.max) ? "#07120b" : C.mute, border: "none" }}>
                Confirm ({pick.length})
              </button>
              {prompt.can_cancel && <button onClick={() => confirmSelect(true)} style={{ ...btn(), color: C.bad, borderColor: C.bad }}>Cancel</button>}
              <button onClick={autoResolveCurrent} style={{ ...btn(), color: C.mute, fontSize: 11 }}>⚡ Let the engine choose</button>
            </div>
          )}
          {prompt && isPlace(prompt) && (() => {
            const places = availablePlaces(prompt);
            const need = prompt.count || 1;
            return (
              <div style={{ display: "flex", flexDirection: "column", gap: 5 }}>
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 5 }}>
                  {places.map((pl, i) => {
                    const on = placeSel.some((x) => x.location === pl.location && x.sequence === pl.sequence);
                    return (
                      <button key={i} onClick={() => setPlaceSel((s) => on ? s.filter((x) => !(x.location === pl.location && x.sequence === pl.sequence)) : (need === 1 ? [{ player: pl.player, location: pl.location, sequence: pl.sequence }] : (s.length < need ? [...s, { player: pl.player, location: pl.location, sequence: pl.sequence }] : s)))}
                        style={{ textAlign: "left", background: on ? "rgba(232,184,75,.15)" : C.panel2, border: `1px solid ${on ? C.gold : C.line}`, color: on ? C.gold : C.text, borderRadius: 6, padding: "7px 9px", fontSize: 11.5 }}>
                        {on ? "✓ " : ""}{pl.label}
                      </button>
                    );
                  })}
                </div>
                <button disabled={placeSel.length !== need} onClick={confirmPlace}
                  style={{ ...btn(), marginTop: 4, background: placeSel.length === need ? C.good : C.panel2, color: placeSel.length === need ? "#07120b" : C.mute, border: "none" }}>
                  Confirm zone{need > 1 ? ` (${placeSel.length}/${need})` : ""}
                </button>
                <button onClick={autoResolveCurrent} style={{ ...btn(), color: C.mute, fontSize: 11 }}>⚡ Let the engine pick a zone</button>
              </div>
            );
          })()}
          {prompt && !isMultiSel(prompt) && !isPlace(prompt) && (
            <div style={{ display: "flex", flexDirection: "column", gap: 5 }}>
              {btns.length === 0 && <p className="mono" style={{ fontSize: 11, color: C.mute }}>(no options — the engine may be mid-resolution)</p>}
              {btns.map((x, i) => (
                <button key={i} onClick={() => respond(x.resp)} style={{ textAlign: "left", background: C.panel2, border: `1px solid ${x.tone === "good" ? C.good : x.tone === "bad" ? C.bad : x.tone === "gold" ? C.gold : C.line}`, color: x.tone === "good" ? C.good : x.tone === "bad" ? C.bad : x.tone === "gold" ? C.gold : C.text, borderRadius: 6, padding: "8px 10px", fontSize: 12 }}>{x.label}</button>
              ))}
            </div>
          )}
        </div>
        {/* card text + currently-usable effects (the engine log now runs in the background) */}
        <div style={{ padding: "10px 12px", flex: 1, overflowY: "auto", minHeight: 0 }}>
          <div className="disp" style={{ fontSize: 10, color: C.gold, marginBottom: 8 }}>Card Text &amp; Effects</div>
          {(() => {
            const cards = effectCards();
            if (!cards.length) return (
              <p className="mono" style={{ fontSize: 11, color: C.mute, lineHeight: 1.5 }}>
                {prompt ? "This decision has no card effects to read." : "Cards you can act on — and the effects you can use right now — appear here, highlighted."}
              </p>
            );
            return cards.map((ec) => {
              const usable = ec.tags.length > 0;
              return (
                <div key={ec.code} style={{ marginBottom: 8, borderRadius: 8, border: `1px solid ${usable ? C.gold : C.line}`, background: usable ? hexA(C.gold, 0.08) : C.panel, padding: "8px 10px" }}>
                  <div style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap", marginBottom: 4 }}>
                    <span style={{ fontSize: 12, fontWeight: 700, color: usable ? C.gold : C.text }}>{ec.name}</span>
                    {ec.tags.map((t) => (
                      <span key={t} className="mono" style={{ fontSize: 8.5, fontWeight: 700, color: "#1a1206", background: C.gold, borderRadius: 4, padding: "1px 5px", letterSpacing: ".04em" }}>{t}</span>
                    ))}
                  </div>
                  <div style={{ fontSize: 11, color: "#c8cee0", lineHeight: 1.5, whiteSpace: "pre-wrap" }}>{ec.desc || "(no card text available)"}</div>
                </div>
              );
            });
          })()}
        </div>
        {/* engine log — kept running in the background, expand to peek */}
        <div style={{ borderTop: `1px solid ${C.line}`, flexShrink: 0 }}>
          <button onClick={() => setLogOpen((v) => !v)} className="disp"
            style={{ width: "100%", textAlign: "left", background: "transparent", border: "none", color: C.mute, fontSize: 10, padding: "7px 12px", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <span>{logOpen ? "▾" : "▸"} Engine Log</span>
            <span className="mono" style={{ fontSize: 9 }}>{log.length} events</span>
          </button>
          {logOpen && (
            <div style={{ padding: "0 12px 8px", maxHeight: 180, overflowY: "auto" }}>
              {[...log].reverse().map((l, i) => <div key={i} className="mono" style={{ fontSize: 10.5, color: l[0] === "⚠" ? C.bad : C.text, opacity: 0.9, padding: "1px 0" }}>{l}</div>)}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

/* ---- tiny ui atoms ---------------------------------------------------- */
function Center({ children }) {
  return <div style={{ height: "calc(100vh - 60px)", display: "grid", placeItems: "center", color: C.mute, fontSize: 14 }}>{children}</div>;
}
const inp = (grow, minW) => ({
  background: C.panel2, border: `1px solid ${C.line}`, color: C.text,
  borderRadius: 6, padding: "8px 10px", fontSize: 13, outline: "none",
  flex: grow ? 1 : "0 0 auto", minWidth: minW || "auto",
});
const btn = () => ({
  background: C.panel2, border: `1px solid ${C.line}`, color: C.text,
  borderRadius: 6, padding: "7px 12px", fontSize: 12.5,
});
const miniBtn = () => ({
  background: "transparent", border: `1px solid ${C.line}`, color: C.text,
  borderRadius: 4, width: 22, height: 22, fontSize: 14, lineHeight: 1, padding: 0,
});

/* fisher–yates */
function shuffle(a) {
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}
