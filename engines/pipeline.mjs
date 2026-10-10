import fs from "node:fs";
import path from "node:path";
import { detect, scoreAll, ENGINE_LIST, isLuraph15, findEngine } from "./detect.mjs";
import {
  fetchScript,
  looksLikeUrl,
  peelToPayload,
  isHtmlSplash,
  looksLikeProtectedLua,
  isLoaderStub,
} from "./fetch-source.mjs";
import { reconstructLogic, dumpReport } from "./static-lift.mjs";
import { logUi } from "./logui.mjs";
import { genvLog } from "./genvlog.mjs";
import { stampSource, fiveLinePreview, looksTruncated, STAMP } from "./stamp.mjs";
import { peelLuarmor, extractScriptKey, isLuarmorBootstrapper, isLuarmorClientBlob } from "./luarmor-peel.mjs";
import { runPlaybook } from "./playbook.mjs";
import {
  VENDOR,
  makeWorkDir,
  writeInput,
  spawnLogged,
  timeoutForSize,
  firstExisting,
  findNewestLua,
  readIfExists,
  toolEnv,
} from "./run-external.mjs";

function repairSource(source) {
  let s = String(source ?? "").replace(/^\uFEFF/, "");
  s = s.replace(/\r\n/g, "\n");
  const header = /^\s*--[ \t]*This file was protected using Luraph Obfuscator v[\d.]+[ \t]*\[https?:\/\/lura\.ph\/?\]/;
  const m = header.exec(s);
  if (m && s[m[0].length] && s[m[0].length] !== "\n") {
    s = s.slice(0, m[0].length) + "\n" + s.slice(m[0].length).replace(/^[ \t]+/, "");
  }
  if (s.charCodeAt(0) === 0 && s.charCodeAt(1) !== 0) {
    try {
      s = Buffer.from(s, "latin1").toString("utf16le").replace(/^\uFEFF/, "");
    } catch {
      /* keep */
    }
  }
  return s;
}

function etaLabel(bytes) {
  const s = Math.round(timeoutForSize(bytes) / 1000);
  const kb = Math.round(bytes / 1024);
  return `~${s}s budget for ${kb} KB`;
}

function stripLuraphProbes(body) {
  let s = String(body || "");
  if (/harness\.luau:\d+|input\.deobf\.luau\.harness/.test(s) && s.length < 800) return "";
  s = s.replace(/^\s*\d+:\d+(?:,\d+:\d+)*\s*$/gm, "");
  s = s.replace(/^\s*\d+:\d+(?:,\d+:\d+)*\s+/gm, "");
  s = s.replace(
    /local connection\d*\s*=\s*(?:game|workspace|Folder\d*|HttpService|RunService)\.(?:AttributeChanged|Destroying):Connect\([\s\S]*?connection\d*:Disconnect\(\)\s*\n?/g,
    "",
  );
  s = s.replace(/local Folder\d*\s*=\s*Instance\.new\("Folder"[^)]*\)\s*\n?/g, "");
  s = s.replace(/Folder\d*:(?:GetChildren|Destroy|WaitForChild)\([^)]*\)\s*\n?/g, "");
  s = s.replace(/Folder\d*\.Name\s*=\s*"[^"]*"\s*\n?/g, "");
  s = s.replace(/\n{3,}/g, "\n\n").trim();
  return s;
}

function isProbeOnlyTrace(body) {
  const cleaned = stripLuraphProbes(body);
  if (!cleaned || cleaned.length < 40) return true;
  const probes = (String(body || "").match(/AttributeChanged|Destroying:Connect|Folder:Destroy/g) || []).length;
  const useful = (cleaned.match(/GetService|loadstring|RemoteEvent|ScreenGui|function /g) || []).length;
  return probes >= 8 && useful < 2;
}

function adiRepo() {
  return path.join(VENDOR, "Deobfuscator-Luraph-V15-adi");
}

async function runLuraphV15(inputPath, source, onLog, { reconstruct } = {}) {
  const deobJs = path.join(VENDOR, "luraph-v15-node", "deob.js");
  const out = inputPath.replace(/\.lua$/i, "") + ".deobf.lua";
  const timeoutMs = timeoutForSize(Buffer.byteLength(source, "latin1"));
  const args = [deobJs, inputPath, "-o", out, "--timeout", String(Math.max(1, Math.round(timeoutMs / 1000)))];
  onLog(`[*] luraph v15 — ${etaLabel(Buffer.byteLength(source, "latin1"))}`);
  const res = await spawnLogged(process.execPath, args, {
    cwd: path.join(VENDOR, "luraph-v15-node"),
    timeoutMs: timeoutMs + 15_000,
    onLog,
    env: toolEnv(),
  });
  const produced = firstExisting([out, inputPath.replace(/\.lua$/i, "") + ".deobf.luau", findNewestLua(path.dirname(out))]);
  let body = readIfExists(produced);

  if (body && body.length > 40 && !/Expected identifier when parsing/.test(body) && !isProbeOnlyTrace(body)) {
    return { ok: true, text: stampSource(body, ["engine: luraph v15"]) };
  }
  if (/Expected identifier when parsing expression, got '\{'/.test(res.stderr + res.stdout)) {
    onLog("[!] luau-ast rejected the file (truncated paste or damaged header)");
  }
  if (/Key validation failed/.test(res.stderr + (body || ""))) {
    onLog("[!] key check fired — stubbing script_key");
  }
  if (reconstruct || !body) {
    onLog("[*] falling back to logic remake");
    return { ok: true, text: reconstructLogic(body || source, { obfuscatorLabel: "Luraph v15" }), partial: true };
  }
  return { ok: false, error: (res.stderr || res.stdout || "luraph v15 failed").slice(-800) };
}

async function runPythonDeob(inputPath, source, onLog, obfuscator) {
  const py = path.join(VENDOR, "Deobfuscator", "deobf", "deob.py");
  const timeoutMs = timeoutForSize(Buffer.byteLength(source, "latin1"));
  const out = inputPath + ".out.lua";
  const args = ["python3", py, inputPath, "-o", out, "--timeout", String(Math.round(timeoutMs / 1000)), "--no-pypy"];
  if (obfuscator) args.push("--obfuscator", obfuscator);
  onLog(`[*] python deobf plugin ${obfuscator || "auto"} — ${etaLabel(Buffer.byteLength(source, "latin1"))}`);
  const res = await spawnLogged(args[0], args.slice(1), {
    cwd: path.dirname(py),
    timeoutMs: timeoutMs + 20_000,
    onLog,
  });
  const body = readIfExists(out) || readIfExists(findNewestLua(path.join(path.dirname(out), "output")));
  if (body && body.length > 40) return { ok: true, text: stampSource(body, [`engine: python ${obfuscator || "auto"}`]) };
  return { ok: false, error: (res.stderr || res.stdout || "python deobf failed").slice(-800) };
}

async function runLuauVmpFull(inputPath, source, onLog, label) {
  const timeoutMs = timeoutForSize(Buffer.byteLength(source, "latin1"));
  const outdir = path.join(path.dirname(inputPath), "vmp-out");
  fs.mkdirSync(outdir, { recursive: true });
  onLog(`[*] luau-vmp luraph-full (${label})`);
  const env = toolEnv();
  const res = await spawnLogged(
    "python3",
    ["-m", "luauvmp", "luraph-full", inputPath, "-o", outdir, "--no-lua-expert", "--force", "--timeout", String(Math.round(timeoutMs / 1000))],
    {
      cwd: path.join(VENDOR, "luau-vmp-deobf"),
      timeoutMs: timeoutMs + 30_000,
      onLog,
      env,
    },
  );
  const cand = firstExisting([
    path.join(outdir, "program.luaexpert.luau"),
    path.join(outdir, "program.decompiled.luau"),
    path.join(outdir, "program.pseudo.lua"),
    path.join(outdir, "embedded_main.luau"),
    findNewestLua(outdir),
  ]);
  const body = readIfExists(cand);
  if (body && body.length > 40 && !/dispatcher loop was not found/i.test(body)) {
    return { ok: true, text: stampSource(body, [`engine: luau-vmp / ${label}`]) };
  }
  const err = (res.stderr || res.stdout || "luau-vmp failed").slice(-800);
  return { ok: false, error: err };
}

async function runMoonveil145(inputPath, source, onLog) {
  const timeoutMs = timeoutForSize(Buffer.byteLength(source, "latin1"));
  const outDir = path.join(path.dirname(inputPath), "mv-out");
  fs.mkdirSync(outDir, { recursive: true });
  const py = path.join(VENDOR, "moonveilvro", "moonveil_decompile.py");
  const pyAlt = path.join(process.cwd(), "moonveilvro", "moonveil_decompile.py");
  const script = fs.existsSync(py) ? py : pyAlt;
  if (fs.existsSync(script)) {
    onLog("[*] moonveil 1.4.5 decoder (moonveilvro)");
    const outLua = path.join(outDir, "moonveil_decompiled.lua");
    const res = await spawnLogged("python3", [script, inputPath, outLua], {
      cwd: path.dirname(script),
      timeoutMs: Math.min(timeoutMs + 20_000, 240_000),
      onLog,
      env: { ...toolEnv(), MOONVEIL_OUT_DIR: outDir },
    });
    const body =
      readIfExists(outLua) ||
      readIfExists(path.join(outDir, "moonveil_structured.lua")) ||
      readIfExists(findNewestLua(outDir));
    if (body && body.length > 40 && !/Traceback/i.test(body.slice(0, 200))) {
      return { ok: true, text: stampSource(body, ["engine: moonveil 1.4.5"]) };
    }
    if (res.stdout && /reconstruction/.test(res.stdout)) {
      const fallback = readIfExists(path.join(outDir, "moonveil_strings.txt"));
      if (fallback && fallback.length > 40) {
        return { ok: true, text: reconstructLogic(fallback + "\n" + source, { obfuscatorLabel: "MoonVeil 1.4.5" }), partial: true };
      }
    }
  }
  const profile = path.join(VENDOR, "luau-vmp-deobf", "profiles", "moonveil-1.4.5.json");
  if (fs.existsSync(profile)) {
    onLog("[*] moonveil 1.4.5 via luau-vmp profile");
    const outBase = inputPath.replace(/\.lua$/i, "") + ".mv";
    await spawnLogged(
      "python3",
      ["-m", "luauvmp", "deobf", inputPath, "-o", outBase, "-p", profile, "--strings"],
      {
        cwd: path.join(VENDOR, "luau-vmp-deobf"),
        timeoutMs: timeoutMs + 20_000,
        onLog,
        env: toolEnv(),
      },
    );
    const body = readIfExists(outBase + ".deobf.lua") || readIfExists(outBase + ".lua");
    if (body && body.length > 40 && !/incomplete VM spec/i.test(body.slice(0, 400))) {
      return { ok: true, text: stampSource(body, ["engine: moonveil 1.4.5 (luau-vmp)"]) };
    }
  }
  onLog("[!] moonveil decoder incomplete on this build — logic remake from recovered strings");
  return { ok: true, text: reconstructLogic(source, { obfuscatorLabel: "MoonVeil 1.4.5" }), partial: true };
}

async function runHercules(inputPath, onLog) {
  const py = path.join(VENDOR, "hercules-deobfuscator-main", "hercules", "deobfhercules_fixed", "deobfhercules.py");
  const out = path.join(path.dirname(inputPath), "hercules.deobf.lua");
  onLog("[*] hercules decoder");
  const res = await spawnLogged("python3", [py, inputPath, out, "--timeout", "45"], { timeoutMs: 60_000, onLog });
  const body = readIfExists(out) || readIfExists(inputPath + ".hercules.lua");
  if (body && body.length > 20) return { ok: true, text: stampSource(body, ["engine: hercules decoder"]) };
  return { ok: false, error: (res.stderr || res.stdout || "hercules decoder failed").slice(-800) };
}

async function runPrometheus(inputPath, onLog) {
  const py = path.join(VENDOR, "Prometheus-WeAre-Devs-Dumper-main", "deobfuscator.py");
  onLog("[*] prometheus / wearedevs decoder");
  const cwd = path.dirname(py);
  const lua51 = firstExisting([
    path.join(VENDOR, "MoonSecV3DeobfuscatorDiscordBot-main", "bin", "lua5.1"),
    path.join(VENDOR, "bin", "lua5.1"),
  ]);
  const res = await spawnLogged("python3", [py, inputPath], {
    cwd,
    timeoutMs: 180_000,
    onLog,
    env: { ...toolEnv(), LUA51_EXECUTABLE: lua51 || "lua5.1" },
  });
  const body =
    readIfExists(inputPath + ".deobf.lua") ||
    readIfExists(inputPath.replace(/\.lua$/i, "") + ".deobf.lua") ||
    readIfExists(findNewestLua(path.join(cwd, "deobfuscated_scripts_complex"))) ||
    readIfExists(findNewestLua(path.dirname(inputPath)));
  if (body && body.length > 20 && body !== fs.readFileSync(inputPath, "utf8")) {
    return { ok: true, text: stampSource(body, ["engine: prometheus / wearedevs decoder"]) };
  }
  const report = readIfExists(inputPath + ".report.txt");
  if (report && report.length > 80) {
    return { ok: true, text: stampSource(report, ["engine: prometheus / wearedevs report"]), partial: true };
  }
  if (res.stdout && res.stdout.length > 80 && !/Traceback/i.test(res.stdout.slice(0, 200))) {
    return { ok: true, text: stampSource(res.stdout, ["engine: prometheus stdout"]) };
  }
  return { ok: false, error: (res.stderr || res.stdout || "prometheus decoder failed").slice(-800) };
}

async function runLuaObf(inputPath, onLog) {
  const cli = path.join(VENDOR, "lua-deobfuscators", "luaobfuscator", "src", "cli.js");
  const outDir = path.join(path.dirname(inputPath), "luaobf-out");
  fs.mkdirSync(outDir, { recursive: true });
  onLog("[*] luaobfuscator decoder");
  const res = await spawnLogged(process.execPath, [cli, inputPath, "--out", outDir, "--stdout"], {
    cwd: path.dirname(cli),
    timeoutMs: 120_000,
    onLog,
  });
  const body = readIfExists(findNewestLua(outDir));
  if (body && body.length > 20) return { ok: true, text: stampSource(body, ["engine: luaobfuscator decoder"]) };
  if (res.stdout && res.stdout.length > 40 && !/Usage:/i.test(res.stdout.slice(0, 40))) {
    return { ok: true, text: stampSource(res.stdout, ["engine: luaobfuscator decoder"]) };
  }
  return { ok: false, error: (res.stderr || res.stdout || "luaobfuscator decoder failed").slice(-800) };
}

async function runGoofy(inputPath, onLog) {
  const cli = path.join(VENDOR, "lua-deobfuscators", "goofyscator", "src", "cli.js");
  const out = inputPath + ".goofy.lua";
  onLog("[*] goofyscator engine");
  const res = await spawnLogged(process.execPath, [cli, inputPath, "-o", out], {
    cwd: path.dirname(cli),
    timeoutMs: 180_000,
    onLog,
  });
  const body = readIfExists(out);
  if (body && body.length > 20) return { ok: true, text: stampSource(body, ["engine: goofyscator"]) };
  return { ok: false, error: (res.stderr || res.stdout || "goofyscator failed").slice(-800) };
}

async function runMoonsec(inputPath, source, onLog) {
  const lua = path.join(VENDOR, "MoonSecV3DeobfuscatorDiscordBot-main", "bin", "lua5.1");
  const decom = path.join(VENDOR, "MoonSecV3DeobfuscatorDiscordBot-main", "decom.lua");
  if (fs.existsSync(lua) && fs.existsSync(decom)) {
    try {
      fs.chmodSync(lua, 0o755);
    } catch {
      /* ignore */
    }
    onLog("[*] moonsec v3 decoder");
    const outLua = path.join(path.dirname(inputPath), "moonsec.deobf.lua");
    const res = await spawnLogged(lua, [decom, inputPath, outLua], {
      cwd: path.dirname(decom),
      timeoutMs: 120_000,
      onLog,
    });
    const body = readIfExists(outLua) || readIfExists(findNewestLua(path.dirname(inputPath)));
    if (body && body !== source && body.length > 40) {
      return { ok: true, text: stampSource(body, ["engine: moonsec v3 decoder"]) };
    }
    if (res.stdout && res.stdout.length > 80 && !/error/i.test(res.stdout.slice(0, 80))) {
      return { ok: true, text: stampSource(res.stdout, ["engine: moonsec v3 decoder"]) };
    }
  }
  onLog("[!] moonsec decoder incomplete on this build — logic remake");
  return { ok: true, text: reconstructLogic(source, { obfuscatorLabel: "MoonSec v3" }), partial: true };
}

async function runUnknown(inputPath, source, onLog, opts) {
  onLog("[*] unknown obfuscator — hard lift / logic remake");
  return {
    ok: true,
    text: reconstructLogic(source, { obfuscatorLabel: opts.reconstruct ? "unknown remake" : "unknown" }),
    partial: true,
  };
}

async function runLuast(inputPath, source, onLog) {
  const py = path.join(VENDOR, "Luast", "deobfuscate.py");
  const out = path.join(path.dirname(inputPath), "luast.deobf.luau");
  onLog("[*] luast (Aditya-lua) — control-flow + L3 emulator");
  const res = await spawnLogged("python3", [py, inputPath, "-o", out], {
    cwd: path.dirname(py),
    timeoutMs: Math.min(timeoutForSize(Buffer.byteLength(source, "latin1")) + 30_000, 300_000),
    onLog,
    env: toolEnv(),
  });
  const body = readIfExists(out) || readIfExists(findNewestLua(path.dirname(out)));
  if (body && body.length > 40 && body !== source) {
    return { ok: true, text: stampSource(body, ["engine: luast"]) };
  }
  if (res.stdout && res.stdout.length > 80 && !/Traceback|usage:/i.test(res.stdout.slice(0, 80))) {
    return { ok: true, text: stampSource(res.stdout, ["engine: luast stdout"]) };
  }
  onLog("[!] luast did not emit source — logic remake");
  return { ok: true, text: reconstructLogic(source, { obfuscatorLabel: "Luast" }), partial: true };
}

async function runFlowAuth(inputPath, source, onLog) {
  const url = String(source).match(/https?:\/\/flowauth\.net\/v1\/loaders\/[A-Fa-f0-9]+\.lua/i)?.[0];
  const crack = path.join(VENDOR, "FlowAuth-Deobfuscator", "flowauth_crack");
  const twoPhase = path.join(crack, "flowauth_two_phase.py");
  const loaderPy = path.join(crack, "flowauth_loader.py");
  const work = path.join(crack, "work");
  const env = toolEnv();
  fs.mkdirSync(work, { recursive: true });

  if (url) {
    onLog("[*] flowauth two-phase (Aditya-lua) " + url);
    await spawnLogged("python3", [twoPhase, "--loader-url", url, "--repo", adiRepo()], {
      cwd: crack,
      timeoutMs: 240_000,
      onLog,
      env,
    });
    const md5 = url.match(/([A-Fa-f0-9]{16,})\.lua/i)?.[1];
    const produced = firstExisting([
      md5 ? path.join(work, `${md5}.payload.lua`) : null,
      path.join(work, "payload_source.lua"),
      findNewestLua(work),
    ]);
    const body = readIfExists(produced);
    if (body && body.length > 80) {
      return { ok: true, text: stampSource(body, ["engine: flowauth", "dumped payload — pick Luraph v15 to deobf"]) };
    }
  }

  onLog("[*] flowauth loader inspect");
  const runtimeOut = path.join(path.dirname(inputPath), "flowauth-runtime.lua");
  const target = url || inputPath;
  await spawnLogged("python3", [loaderPy, target, "-o", runtimeOut], {
    cwd: crack,
    timeoutMs: 90_000,
    onLog,
    env,
  });
  const runtime = readIfExists(runtimeOut);
  if (runtime && runtime.length > 80) {
    return { ok: true, text: stampSource(runtime, ["engine: flowauth", "stage-2 runtime dump"]) };
  }
  onLog("[!] flowauth chain incomplete — logic remake");
  return { ok: true, text: reconstructLogic(source, { obfuscatorLabel: "FlowAuth" }), partial: true };
}

async function runLuarmor(inputPath, source, onLog) {
  const key = extractScriptKey(source);
  onLog("[*] luarmor fetch — save every loadstringN file, skip the shared client");
  const peeled = await peelLuarmor(source, onLog, {});
  const dumps = Array.isArray(peeled.dumps) ? peeled.dumps : [];
  const files = [];
  dumps.forEach((d, i) => {
    const name = d.client ? `loadstring${i}-luarmor-client.lua` : d.name || `loadstring${i}.lua`;
    files.push({ name, text: d.body });
  });

  let payload = String(peeled.source || "");
  if (!payload || isLuarmorClientBlob(payload)) {
    const real = dumps.find((d) => !d.client);
    payload = real?.body || "";
  }

  if (payload && isLuraph15(payload)) {
    onLog("[*] real chunk looks like luraph — deobfuscating that file");
    const tmp = path.join(path.dirname(inputPath), "luarmor-payload.lua");
    fs.writeFileSync(tmp, payload, "latin1");
    const deob = await runLuraphV15(tmp, payload, onLog, {});
    if (deob?.ok && deob.text && !isLuarmorClientBlob(deob.text)) {
      files.push({ name: "cleaned.deobf.lua", text: deob.text });
      return {
        ok: true,
        text: deob.text,
        files,
        engine: "luarmor fetch",
      };
    }
    if (deob?.text) files.push({ name: "luraph-pass.lua", text: deob.text });
  }

  if (payload && !isLuarmorClientBlob(payload)) {
    return {
      ok: true,
      text: stampSource(payload, [
        "engine: luarmor fetch",
        "loadstring dump (not the shared client)",
        key ? "script_key was present" : "no script_key",
        `${files.length} file(s) attached`,
      ]),
      files,
      engine: "luarmor fetch",
    };
  }

  const note = [
    "-- deobf by 6.5mz",
    "-- engine: luarmor fetch",
    "-- the hook only captured the Luarmor whitelist client",
    "-- that client is the same file for every script",
    "-- the real script is the next loadstring, after a valid script_key",
    `-- chunks saved: ${files.length}`,
    key ? "-- a script_key was present but auth did not return a second chunk" : "-- paste script_key = \"...\" above the loader and run again",
    "",
    "return { captured = " + files.length + ", client_only = true }",
    "",
  ].join("\n");
  return {
    ok: true,
    partial: true,
    text: note,
    files,
    engine: "luarmor fetch",
  };
}

async function runEngine(id, inputPath, source, onLog, opts) {
  switch (id) {
    case "luraph_v15":
    case "luraph_v15_1":
      return runLuraphV15(inputPath, source, onLog, opts);
    case "ironbrew1":
      return runPythonDeob(inputPath, source, onLog, "ironbrew1");
    case "luraph_v14_7":
      return runLuauVmpFull(inputPath, source, onLog, "luraph 14.7");
    case "luraph_v14_8": {
      const r = await runLuauVmpFull(inputPath, source, onLog, "luraph 14.8");
      if (r.ok) return r;
      onLog("[!] luraph 14.8 dispatcher missing — logic remake");
      return { ok: true, text: reconstructLogic(source, { obfuscatorLabel: "Luraph v14.8" }), partial: true };
    }
    case "luau_vmp":
      return runLuauVmpFull(inputPath, source, onLog, "luau-vmp");
    case "hercules":
      return runHercules(inputPath, onLog);
    case "prometheus":
      return runPrometheus(inputPath, onLog);
    case "luaobfuscator":
      return runLuaObf(inputPath, onLog);
    case "goofyscator":
      return runGoofy(inputPath, onLog);
    case "moonveil":
      return runMoonveil145(inputPath, source, onLog);
    case "moonsec_v3":
      return runMoonsec(inputPath, source, onLog);
    case "luarmor":
      return runLuarmor(inputPath, source, onLog);
    case "luast":
      return runLuast(inputPath, source, onLog);
    case "flowauth":
      return runFlowAuth(inputPath, source, onLog);
    case "unknown":
    default:
      return runUnknown(inputPath, source, onLog, opts);
  }
}

export { ENGINE_LIST, detect, scoreAll, fiveLinePreview, STAMP, findEngine };

async function peelIncoming(source, onLog) {
  let current = repairSource(source);
  const wantFetch =
    looksLikeUrl(current) ||
    isLoaderStub(current) ||
    /loadstring\s*\(\s*game:HttpGet/i.test(current) ||
    /api\.luarmor\.net\/files|getpolsec\.com\/scripts\/hosted|flowauth\.net\/v1\/loaders/i.test(current);

  if (!wantFetch) return current;

  const peeled = await peelToPayload(current, onLog, { stopAtLuraph: true });
  if (peeled.source && !isHtmlSplash(peeled.source) && (peeled.peeled || looksLikeProtectedLua(peeled.source) || peeled.source !== current)) {
    current = repairSource(peeled.source);
  } else {
    const fetched = await fetchScript(current, onLog);
    if (fetched.ok && fetched.source && !isHtmlSplash(fetched.source)) current = repairSource(fetched.source);
  }
  return current;
}

export async function runJob(options) {
  const logs = [];
  const onLog = (line) => {
    const l = String(line).slice(0, 600);
    logs.push(l);
    options.onLog?.(l);
  };

  let source = repairSource(options.source || "");
  const wantFetch =
    options.mode === "get" ||
    looksLikeUrl(source) ||
    isLoaderStub(source) ||
    options.url ||
    /loadstring\s*\(\s*game:HttpGet/i.test(source);

  if (wantFetch) {
    source = await peelIncoming(options.url || source, onLog);
  }

  if (isHtmlSplash(source)) {
    return {
      ok: false,
      error:
        "Got a website page, not a script. Paste the loadstring (loadstring(game:HttpGet(\"https://api.luarmor.net/files/v3/loaders/….lua\"))()) or a direct .lua URL.",
      logs,
      scores: [],
      preview: "",
    };
  }

  if (options.mode === "get") {
    const text = source.startsWith(STAMP) ? source : stampSource(source, ["command: .get", "fetched payload"]);
    return {
      ok: true,
      text,
      preview: fiveLinePreview(text),
      logs,
      engine: "get",
      detection: detect(source),
      scores: scoreAll(source),
    };
  }

  const trunc = looksTruncated(source);
  if (trunc.truncated && !isLoaderStub(source)) {
    onLog(`[!] ${trunc.reason}`);
    return {
      ok: false,
      error: trunc.reason,
      logs,
      scores: scoreAll(source),
      preview: "",
      damaged: true,
    };
  }

  const detection = detect(source);
  const scores = detection.scores;
  onLog(`[*] obfuscator: ${detection.best.label} (detected, ${detection.best.confidence.toFixed(2)})`);
  for (const sc of scores.filter((s) => s.confidence >= 0.2).slice(0, 6)) {
    onLog(`    ${sc.id === detection.best.id ? ">" : " "} ${sc.label}: ${(sc.confidence * 100).toFixed(0)}%${sc.beta ? " [beta]" : ""}`);
  }

  if (options.mode === "detect") {
    return { ok: true, detection, scores, engines: ENGINE_LIST, logs, sourceSize: source.length, source, preview: fiveLinePreview(source) };
  }

  if (detection.unknown && !options.forceUnknown && options.mode === "deobf" && !options.obfuscator) {
    onLog("[?] unknown obfuscator. would you like to try deobfuscating it anyway?");
    return {
      ok: false,
      needsUnknownConfirm: true,
      detection,
      scores,
      logs,
      sourceSize: source.length,
      source,
    };
  }

  if (options.mode === "l" || options.mode === "playbook") {
    const text = runPlaybook(source).text;
    return { ok: true, text, preview: fiveLinePreview(text), detection, scores, logs, engine: "playbook .l", partial: true };
  }
  if (options.mode === "dump") {
    const text = dumpReport(source, detection.best.label);
    return { ok: true, text, preview: fiveLinePreview(text), detection, scores, logs };
  }
  if (options.mode === "logui") {
    const text = logUi(source);
    return { ok: true, text, preview: fiveLinePreview(text), detection, scores, logs };
  }
  if (options.mode === "genvlog") {
    const text = genvLog(source);
    return { ok: true, text, preview: fiveLinePreview(text), detection, scores, logs };
  }

  const engineId =
    options.obfuscator && options.obfuscator !== "auto" && options.obfuscator !== "choose"
      ? options.obfuscator
      : detection.best.id;
  onLog(`[*] running engine: ${engineId}`);
  onLog(`[~] ${etaLabel(Buffer.byteLength(source, "latin1"))}`);

  const work = makeWorkDir("deobf");
  const inputPath = writeInput(work, source);
  let result;
  try {
    result = await runEngine(engineId, inputPath, source, onLog, { reconstruct: options.reconstruct });
  } catch (e) {
    onLog(`[!] engine crash: ${e.message || e}`);
    result = { ok: false, error: String(e.message || e) };
  }

  if (!result.ok && options.reconstruct) {
    onLog("[*] remaking logic from recovered traces");
    result = {
      ok: true,
      text: reconstructLogic(result.text || source, { obfuscatorLabel: engineId }),
      partial: true,
    };
  }

  if (result.ok && result.text) {
    if (!result.text.startsWith(STAMP)) result.text = stampSource(result.text, [`engine: ${engineId}`]);
    return {
      ok: true,
      text: result.text,
      preview: fiveLinePreview(result.text),
      detection,
      scores,
      logs,
      partial: !!result.partial,
      engine: engineId,
      workdir: work,
      source,
    };
  }

  return {
    ok: false,
    error: result.error || "deobfuscation failed",
    detection,
    scores,
    logs,
    reconstructAvailable: true,
    engine: engineId,
    source,
  };
}
