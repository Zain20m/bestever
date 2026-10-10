const slice = (s, n) => String(s ?? "").slice(0, n);

const ENGINES = [
  {
    id: "luarmor",
    label: "Luarmor Fetch",
    real: true,
    detect(s) {
      const head = slice(s, 8000);
      let c = 0;
      if (/api\.luarmor\.net\/files\/v\d+\/(?:loaders|l)\//i.test(s)) c += 0.85;
      if (/cdn\.luarmor\.net\/v4_init/i.test(s)) c += 0.55;
      if (/script_key/.test(head) && /luarmor\.net/i.test(s) && /loadstring/i.test(head) && s.length < 5000) c += 0.7;
      if (/Luarmor V4 bootstrapper/i.test(head)) c += 0.75;
      if (/superflow_bytecode/.test(s) && /Luarmor/i.test(head)) c += 0.55;
      if (/static_content_\d+/.test(head) && /init-[\w-]+/.test(head)) c += 0.45;
      if (/ce_like_loadstring_fn/.test(s)) c += 0.25;
      if (/roblox-auth\.luarmor\.net/.test(s)) c += 0.35;
      if (/LUARMOR_/i.test(s)) c += 0.15;
      if (/_bsdata0\s*=/.test(head) && /luarmor|static_content/i.test(head)) c += 0.4;
      return Math.min(1, c);
    },
  },
  {
    id: "luraph_v15_1",
    label: "Luraph v15.1",
    real: true,
    detect(s) {
      const head = slice(s, 2500);
      if (/Luraph Obfuscator v15\.1/i.test(head)) return 1;
      if (/protected using Luraph Obfuscator v15\.1/i.test(head)) return 1;
      return 0;
    },
  },
  {
    id: "luraph_v15",
    label: "Luraph v15",
    real: true,
    detect(s) {
      const head = slice(s, 2500);
      const m = /This file was protected using Luraph Obfuscator v(\d+)(?:\.(\d+))?/i.exec(head);
      if (m) {
        if (m[1] === "15" && m[2] === "1") return 0.35;
        return m[1] === "15" ? 1 : 0.15;
      }
      if (/Luraph Obfuscator v15(?!\.1)/i.test(s)) return 1;
      const start = s.trimStart().slice(0, 2000);
      if (
        start.startsWith("return setmetatable({") &&
        (/\[\d+\]=(bit32|buffer|string|table|math)\.\w+/.test(start) || slice(s, 200000).includes("LPH"))
      ) {
        return 0.86;
      }
      if (/\bLPH_ENCSTR\b|\bLPH_CRASH\b|\bLPH_ENCFUNC\b/.test(s) && /setmetatable\s*\(\s*\{/.test(slice(s, 5000))) {
        return 0.72;
      }
      return 0;
    },
  },
  {
    id: "luraph_v14_8",
    label: "Luraph v14.8",
    real: true,
    detect(s) {
      const head = slice(s, 4000);
      if (/Luraph Obfuscator v14\.8/i.test(head)) return 1;
      if (/Luraph Obfuscator v14\.8/i.test(s)) return 0.98;
      return 0;
    },
  },
  {
    id: "luraph_v14_7",
    label: "Luraph v14.7",
    real: true,
    detect(s) {
      const head = slice(s, 4000);
      if (/Luraph Obfuscator v14\.7/i.test(head)) return 1;
      if (/LPH%V/.test(s) || /LPH\\%V/.test(s)) return 0.82;
      if (s.includes("52200625") && s.includes("LPH") && /v14/i.test(head)) return 0.7;
      if (/\[=\[LPH/.test(s) && /v14\.7/i.test(head)) return 0.9;
      return 0;
    },
  },
  {
    id: "luau_vmp",
    label: "Luau VMP",
    real: true,
    detect(s) {
      let c = 0;
      if (/luau-vmp|LuauVM|vmprotect/i.test(slice(s, 2000))) c += 0.5;
      if (/buffer\.fromstring/.test(s) && /bit32\.rrotate/.test(s) && /getfenv/.test(s)) c += 0.2;
      return Math.min(1, c);
    },
  },
  {
    id: "moonveil",
    label: "MoonVeil 1.4.5",
    real: true,
    detect(s) {
      const head = slice(s, 2500);
      if (/This script is obfuscated with MoonVeil/i.test(head)) return 1;
      if (/MoonVeil/i.test(head) && /getpolsec\.com|moonveil/i.test(head)) return 0.99;
      if (/getpolsec\.com\/scripts\/hosted/i.test(s)) return s.length < 8000 ? 0.95 : 0.7;
      if (/script_key/.test(head) && /getpolsec\.com/i.test(s) && /loadstring/i.test(head)) return 0.94;
      if (/repeat if\s*\(\s*\w+\s*>=/.test(slice(s, 4000)) && /until\s*\(\s*false\s*\)/.test(s) && /bit32/.test(s) && /getpolsec|MoonVeil/i.test(s)) {
        return 0.8;
      }
      return 0;
    },
  },
  {
    id: "moonsec_v3",
    label: "MoonSec v3",
    real: true,
    detect(s) {
      const head = slice(s, 3000);
      if (/MoonSec/i.test(head) || /Moonsec/i.test(head)) return 0.95;
      if (/=_ENV;[\w.]+='/.test(s)) return 0.8;
      if (/MoonSec_StringsHiddenAttr/.test(s)) return 0.9;
      if (/\[\["\\.+MoonSec/.test(head)) return 0.7;
      return 0;
    },
  },
  {
    id: "prometheus",
    label: "Prometheus / WeAreDevs",
    real: true,
    detect(s) {
      const head = slice(s, 2500);
      if (/wearedevs\.net\/obfuscator/i.test(head)) return 0.98;
      if (/Prometheus/i.test(head) && /obfuscat/i.test(head)) return 0.9;
      if (/return\s*\(\s*function\s*\(\s*\.\.\.\s*\)/.test(head) && /\\0\d{2}\\0\d{2}\\0\d{2}/.test(slice(s, 4000))) {
        return 0.45;
      }
      return 0;
    },
  },
  {
    id: "hercules",
    label: "Hercules",
    real: true,
    detect(s) {
      if (/Obfuscated by Hercules/i.test(slice(s, 2000))) return 1;
      if (/hercules-obfuscator/i.test(s)) return 0.9;
      if (/WrapState\s*\(\s*BcToState\s*\(/.test(s)) return 0.85;
      return 0;
    },
  },
  {
    id: "ironbrew1",
    label: "IronBrew 1",
    real: true,
    detect(s) {
      const head = slice(s, 3000);
      if (/IronBrew/i.test(head) && !/IronBrew2|IB2/i.test(head)) return 0.95;
      if (/return\s*\(\s*function\s*\(\s*byte\s*,\s*bit\s*,\s*env/.test(head)) return 0.7;
      if (/\bIB_DECODE\b|\bWrapState\b/.test(s) && /Deserialize/.test(s)) return 0.5;
      return 0;
    },
  },
  {
    id: "luaobfuscator",
    label: "LuaObfuscator",
    real: true,
    detect(s) {
      if (/luaobfuscator\.com/i.test(slice(s, 2500))) return 0.98;
      if (/This file was generated by LuaObfuscator/i.test(s)) return 1;
      if (/This file was obfuscated using LuaObfuscator/i.test(s)) return 1;
      return 0;
    },
  },
  {
    id: "goofyscator",
    label: "Goofyscator",
    real: true,
    detect(s) {
      if (/Goofyscator|goofy.?scator/i.test(slice(s, 2500))) return 0.98;
      if (/vmseed/i.test(s) && /Goofy/i.test(s)) return 0.8;
      return 0;
    },
  },
  {
    id: "flowauth",
    label: "FlowAuth",
    real: true,
    detect(s) {
      const head = slice(s, 4000);
      if (/flowauth\.net\/v1\/loaders/i.test(s)) return 0.99;
      if (/X-FlowAuth-Protocol/i.test(s)) return 0.95;
      if (/launch_ticket/i.test(head) && /flowauth/i.test(s)) return 0.92;
      if (/FlowAuthRuntime/i.test(s) && /flowauth\.net/i.test(s)) return 0.88;
      return 0;
    },
  },
  {
    id: "luast",
    label: "Luast",
    real: true,
    detect(s) {
      const head = slice(s, 2500);
      if (/generated by luast/i.test(head)) return 1;
      if (/^--\s*luast/im.test(head) && /while true do/.test(head)) return 0.9;
      if (/\bluast\b/i.test(head) && /bit32\.bxor/.test(s) && /buffer\.readu32/.test(s)) return 0.78;
      if (/Ouroboros/i.test(head) && /luast/i.test(s)) return 0.7;
      return 0;
    },
  },
];

export const ENGINE_LIST = ENGINES.map(({ id, label, real, beta }) => ({
  id,
  label,
  real: !!real,
  beta: !!beta,
}));

export function scoreAll(source) {
  const s = String(source ?? "");
  const scores = ENGINES.map((e) => {
    let confidence = 0;
    try {
      confidence = Number(e.detect(s)) || 0;
    } catch {
      confidence = 0;
    }
    return {
      id: e.id,
      label: e.label,
      real: !!e.real,
      beta: !!e.beta,
      confidence: Math.max(0, Math.min(1, confidence)),
    };
  }).sort((a, b) => b.confidence - a.confidence);
  return scores;
}

export function detect(source) {
  const scores = scoreAll(source);
  const best = scores[0];
  const unknown = !best || best.confidence < 0.45;
  return {
    unknown,
    best: unknown
      ? { id: "unknown", label: "unknown obfuscator", real: true, beta: false, confidence: best?.confidence ?? 0.01 }
      : best,
    scores,
  };
}

export function findEngine(id) {
  if (id === "auto" || id === "choose") return { id: "auto", label: "Auto-detect" };
  if (id === "unknown") return { id: "unknown", label: "Hard lift / unknown" };
  return ENGINE_LIST.find((e) => e.id === id) || null;
}

export function isLuraph15(source) {
  const head = String(source ?? "").slice(0, 2500);
  return /Luraph Obfuscator v15/i.test(head) || /This file was protected using Luraph Obfuscator v15/i.test(head);
}
