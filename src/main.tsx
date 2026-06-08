import React, { useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { Plus, Download, Trash2, RotateCcw, Save, PlayCircle } from "lucide-react";
import "./styles.css";

if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("./sw.js").catch(() => {
      // Service worker registration is best-effort.
    });
  });
}

type StepStatus = "pending" | "running" | "paused" | "done" | "skipped";

type EventAction =
  | "experiment_created"
  | "experiment_reset"
  | "protocol_preset_saved"
  | "step_added"
  | "step_started"
  | "step_paused"
  | "step_resumed"
  | "step_finished"
  | "step_skipped"
  | "step_reset"
  | "timer_alarm"
  | "step_extended"
  | "step_shortened"
  | "note_added";

type ProtocolEvent = {
  id: string;
  experimentId: string;
  stepId?: string;
  timestamp: string;
  action: EventAction;
  detail: string;
};

type Step = {
  id: string;
  name: string;
  plannedDurationSec: number;
  status: StepStatus;
  order: number;

  startedAt?: string;
  endedAt?: string;

  pauseStartedAt?: string;
  totalPausedSec: number;

  adjustmentSec: number;
  notes: string;
};

type ProtocolStepTemplate = {
  name: string;
  plannedDurationSec: number;
};

type ProtocolPreset = {
  id: string;
  name: string;
  createdAt: string;
  steps: ProtocolStepTemplate[];
};

type AudioOutputDevice = {
  deviceId: string;
  label: string;
};

type AlarmType = "beep" | "chime" | "urgent" | "soft";

type ExperimentRun = {
  id: string;
  name: string;
  protocolPresetId?: string;
  createdAt: string;
  steps: Step[];
  events: ProtocolEvent[];
};

const RUNS_STORAGE_KEY = "protocol-timer-runs-v2";
const PRESETS_STORAGE_KEY = "protocol-timer-presets-v2";

function id() {
  return crypto.randomUUID();
}

function nowIso() {
  return new Date().toISOString();
}

function formatClock(iso?: string) {
  if (!iso) return "-";
  return new Date(iso).toLocaleTimeString("ja-JP", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

function formatDateTime(iso?: string) {
  if (!iso) return "";
  return new Date(iso).toLocaleString("ja-JP", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

function formatDuration(sec: number) {
  const sign = sec < 0 ? "-" : "";
  const abs = Math.abs(Math.round(sec));
  const h = Math.floor(abs / 3600);
  const m = Math.floor((abs % 3600) / 60);
  const s = abs % 60;
  if (h > 0) {
    return `${sign}${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  }
  return `${sign}${m}:${String(s).padStart(2, "0")}`;
}

function parseDurationToSeconds(input: string): number | undefined {
  const raw = input.trim().toLowerCase();
  if (!raw) return undefined;

  // Colon formats:
  // 90        -> 90 minutes
  // 1:30      -> 1 minute 30 seconds
  // 1:02:30   -> 1 hour 2 minutes 30 seconds
  if (/^\d+(\.\d+)?$/.test(raw)) {
    return Math.round(Number(raw) * 60);
  }

  if (/^\d+:\d{1,2}(:\d{1,2})?$/.test(raw)) {
    const parts = raw.split(":").map(Number);
    if (parts.length === 2) {
      const [minutes, seconds] = parts;
      return minutes * 60 + seconds;
    }
    const [hours, minutes, seconds] = parts;
    return hours * 3600 + minutes * 60 + seconds;
  }

  // Unit formats:
  // 1h 30m 15s, 2 hours, 45 min, 90s, 1.5h
  const unitPattern = /(\d+(?:\.\d+)?)\s*(h|hr|hrs|hour|hours|時間|m|min|mins|minute|minutes|分|s|sec|secs|second|seconds|秒)/g;
  let total = 0;
  let matched = false;
  let match: RegExpExecArray | null;

  while ((match = unitPattern.exec(raw)) !== null) {
    matched = true;
    const value = Number(match[1]);
    const unit = match[2];

    if (["h", "hr", "hrs", "hour", "hours", "時間"].includes(unit)) {
      total += value * 3600;
    } else if (["m", "min", "mins", "minute", "minutes", "分"].includes(unit)) {
      total += value * 60;
    } else if (["s", "sec", "secs", "second", "seconds", "秒"].includes(unit)) {
      total += value;
    }
  }

  return matched ? Math.round(total) : undefined;
}

function promptDurationSeconds(message: string, defaultValue = "1m"): number | undefined {
  const raw = prompt(
    `${message}\n\n入力例:\n  90        = 90分\n  1:30      = 1分30秒\n  1:02:30   = 1時間2分30秒\n  2h 30m 10s\n  45s\n  30分`,
    defaultValue
  );

  if (raw === null) return undefined;

  const seconds = parseDurationToSeconds(raw);
  if (seconds === undefined || !Number.isFinite(seconds) || seconds < 0) {
    alert("時間の形式を認識できませんでした。例: 5m, 30s, 1h 20m, 1:30, 1:02:30");
    return undefined;
  }

  return seconds;
}

function secondsBetween(startIso: string, endIso: string) {
  return Math.max(0, (new Date(endIso).getTime() - new Date(startIso).getTime()) / 1000);
}

function getElapsedSec(step: Step, tick: number) {
  if (!step.startedAt) return 0;

  const endMs =
    step.status === "done" || step.status === "skipped"
      ? new Date(step.endedAt ?? nowIso()).getTime()
      : tick;

  let elapsed = Math.max(0, (endMs - new Date(step.startedAt).getTime()) / 1000);
  elapsed -= step.totalPausedSec;

  if (step.status === "paused" && step.pauseStartedAt) {
    elapsed -= Math.max(0, (tick - new Date(step.pauseStartedAt).getTime()) / 1000);
  }

  return Math.max(0, elapsed);
}

function getTargetDurationSec(step: Step) {
  return Math.max(0, step.plannedDurationSec + step.adjustmentSec);
}

function getActualDurationSec(step: Step) {
  if (!step.startedAt || !step.endedAt) return undefined;
  return Math.max(0, secondsBetween(step.startedAt, step.endedAt) - step.totalPausedSec);
}

function csvEscape(value: unknown) {
  const s = String(value ?? "");
  const needsQuote =
    s.includes(",") || s.includes('"') || s.includes("\n") || s.includes("\r");
  if (needsQuote) return `"${s.replaceAll('"', '""')}"`;
  return s;
}

function downloadText(filename: string, content: string) {
  // Add UTF-8 BOM so Japanese text opens correctly in Windows Excel.
  const utf8Bom = "\ufeff";
  const blob = new Blob([utf8Bom + content], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

function downloadJson(filename: string, data: unknown) {
  const content = JSON.stringify(data, null, 2);
  const blob = new Blob([content], { type: "application/json;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

function htmlEscape(value: unknown) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function downloadHtml(filename: string, html: string) {
  const blob = new Blob([html], { type: "text/html;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

function readJsonFile<T>(file: File): Promise<T> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      try {
        resolve(JSON.parse(String(reader.result)) as T);
      } catch (error) {
        reject(error);
      }
    };
    reader.onerror = () => reject(reader.error);
    reader.readAsText(file, "utf-8");
  });
}

function safeFileName(name: string) {
  return name
    .replace(/[\\/:*?"<>|]/g, "_")
    .replace(/\s+/g, "_")
    .slice(0, 80);
}

async function saveProtocolFileToAppFolder(protocol: ProtocolPreset) {
  const response = await fetch("/api/protocols/save", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(protocol),
  });

  if (!response.ok) {
    throw new Error("Failed to save protocol file");
  }

  return (await response.json()) as { ok: boolean; filename: string; path: string };
}

async function saveAllProtocolFilesToAppFolder(protocols: ProtocolPreset[]) {
  const response = await fetch("/api/protocols/save-all", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(protocols),
  });

  if (!response.ok) {
    throw new Error("Failed to save protocol files");
  }

  return (await response.json()) as { ok: boolean; count: number; directory: string };
}

async function loadProtocolFilesFromAppFolder() {
  const response = await fetch("/api/protocols/list");
  if (!response.ok) {
    throw new Error("Failed to load protocol files");
  }

  return (await response.json()) as ProtocolPreset[];
}

function resetStepRuntime(step: Step): Step {
  return {
    ...step,
    status: "pending",
    startedAt: undefined,
    endedAt: undefined,
    pauseStartedAt: undefined,
    totalPausedSec: 0,
    adjustmentSec: 0,
    notes: "",
  };
}


function makeStepSeconds(name: string, seconds: number, order: number): Step {
  return {
    id: id(),
    name,
    plannedDurationSec: Math.max(0, seconds),
    status: "pending",
    order,
    totalPausedSec: 0,
    adjustmentSec: 0,
    notes: "",
  };
}

function makeStep(name: string, minutes: number, order: number): Step {
  return {
    id: id(),
    name,
    plannedDurationSec: Math.max(0, minutes * 60),
    status: "pending",
    order,
    totalPausedSec: 0,
    adjustmentSec: 0,
    notes: "",
  };
}

function makeStepFromTemplate(template: ProtocolStepTemplate, order: number): Step {
  return {
    id: id(),
    name: template.name,
    plannedDurationSec: template.plannedDurationSec,
    status: "pending",
    order,
    totalPausedSec: 0,
    adjustmentSec: 0,
    notes: "",
  };
}

function stepToTemplate(step: Step): ProtocolStepTemplate {
  return {
    name: step.name,
    plannedDurationSec: step.plannedDurationSec,
  };
}

function addEvent(
  run: ExperimentRun,
  action: EventAction,
  detail: string,
  stepId?: string,
  timestamp = nowIso()
): ExperimentRun {
  return {
    ...run,
    events: [
      ...run.events,
      {
        id: id(),
        experimentId: run.id,
        stepId,
        timestamp,
        action,
        detail,
      },
    ],
  };
}

function createDefaultPresets(): ProtocolPreset[] {
  return [
    {
      id: id(),
      name: "Basic incubation",
      createdAt: nowIso(),
      steps: [
        { name: "サンプル準備", plannedDurationSec: 3 * 60 },
        { name: "試薬添加", plannedDurationSec: 5 * 60 },
        { name: "インキュベート", plannedDurationSec: 30 * 60 },
        { name: "洗浄", plannedDurationSec: 3 * 60 },
      ],
    },
    {
      id: id(),
      name: "Quick spin-down",
      createdAt: nowIso(),
      steps: [
        { name: "チューブ確認", plannedDurationSec: 1 * 60 },
        { name: "遠心", plannedDurationSec: 10 * 60 },
        { name: "上清回収", plannedDurationSec: 2 * 60 },
      ],
    },
  ];
}

function createExperimentFromPreset(preset: ProtocolPreset, name?: string): ExperimentRun {
  const createdAt = nowIso();
  const run: ExperimentRun = {
    id: id(),
    name: name || `${preset.name} run`,
    protocolPresetId: preset.id,
    createdAt,
    steps: preset.steps.map((s, index) => makeStepFromTemplate(s, index + 1)),
    events: [],
  };
  return addEvent(
    run,
    "experiment_created",
    `Created ${run.name} from preset ${preset.name}`,
    undefined,
    createdAt
  );
}

function App() {
  const [presets, setPresets] = useState<ProtocolPreset[]>(() => {
    const saved = localStorage.getItem(PRESETS_STORAGE_KEY);
    if (!saved) return createDefaultPresets();
    try {
      const parsed = JSON.parse(saved) as ProtocolPreset[];
      return parsed.length > 0 ? parsed : createDefaultPresets();
    } catch {
      return createDefaultPresets();
    }
  });

  const [runs, setRuns] = useState<ExperimentRun[]>(() => {
    const saved = localStorage.getItem(RUNS_STORAGE_KEY);
    if (!saved) return [];
    try {
      return JSON.parse(saved);
    } catch {
      return [];
    }
  });

  const [selectedPresetId, setSelectedPresetId] = useState("");
  const [activeScreen, setActiveScreen] = useState<"run" | "protocol">("run");
  const [tick, setTick] = useState(Date.now());
  const [alarmedStepIds, setAlarmedStepIds] = useState<string[]>([]);
  const [alarmMessage, setAlarmMessage] = useState("");
  const [audioOutputDevices, setAudioOutputDevices] = useState<AudioOutputDevice[]>([]);
  const [selectedAudioOutputId, setSelectedAudioOutputId] = useState("default");
  const [alarmType, setAlarmType] = useState<AlarmType>("beep");
  const [alarmVolume, setAlarmVolume] = useState(1.2);
  const [isAlarmRinging, setIsAlarmRinging] = useState(false);
  const [warnedStepIds, setWarnedStepIds] = useState<string[]>([]);
  const [notificationPermission, setNotificationPermission] = useState(
    typeof Notification === "undefined" ? "unsupported" : Notification.permission
  );
  const audioContextRef = useRef<AudioContext | null>(null);
  const alarmAudioRef = useRef<HTMLAudioElement | null>(null);
  const alarmIntervalRef = useRef<number | null>(null);
  const currentAlarmSourceRef = useRef<MediaStreamAudioDestinationNode | null>(null);

  useEffect(() => {
    if (!selectedPresetId && presets[0]) setSelectedPresetId(presets[0].id);
  }, [presets, selectedPresetId]);

  useEffect(() => {
    const t = setInterval(() => setTick(Date.now()), 500);
    return () => clearInterval(t);
  }, []);

  useEffect(() => {
    for (const run of runs) {
      for (const step of run.steps) {
        if (step.status !== "running") continue;
        if (warnedStepIds.includes(step.id)) continue;
        if (getTargetDurationSec(step) < 10 * 60) continue;

        const remaining = getTargetDurationSec(step) - getElapsedSec(step, tick);
        if (remaining > 60 || remaining <= 0) continue;

        setWarnedStepIds((prev) => (prev.includes(step.id) ? prev : [...prev, step.id]));
        showOneMinuteNotification(run.name, step.name);

        return;
      }
    }
  }, [runs, tick, warnedStepIds]);

  useEffect(() => {
    for (const run of runs) {
      for (const step of run.steps) {
        if (step.status !== "running") continue;
        if (alarmedStepIds.includes(step.id)) continue;

        const remaining = getTargetDurationSec(step) - getElapsedSec(step, tick);
        if (remaining > 0) continue;

        const message = `${run.name}: ${step.name} の予定時間が終了しました`;
        setAlarmedStepIds((prev) => (prev.includes(step.id) ? prev : [...prev, step.id]));
        setAlarmMessage(message);
        scrollToStep(step.id);
        startAlarmSound();

        setRuns((prev) =>
          prev.map((r) =>
            r.id === run.id
              ? addEvent(r, "timer_alarm", `Timer alarm: ${step.name}`, step.id, nowIso())
              : r
          )
        );

        return;
      }
    }
  }, [runs, tick, alarmedStepIds]);

  useEffect(() => {
    localStorage.setItem(RUNS_STORAGE_KEY, JSON.stringify(runs));
  }, [runs]);

  useEffect(() => {
    localStorage.setItem(PRESETS_STORAGE_KEY, JSON.stringify(presets));
  }, [presets]);


  useEffect(() => {
    return () => {
      if (alarmIntervalRef.current !== null) {
        window.clearInterval(alarmIntervalRef.current);
      }

      if (alarmAudioRef.current) {
        alarmAudioRef.current.pause();
        alarmAudioRef.current.srcObject = null;
      }
    };
  }, []);
  function initAudio() {
    try {
      const AudioContextClass = window.AudioContext || (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!AudioContextClass) return;
      if (!audioContextRef.current) audioContextRef.current = new AudioContextClass();
      if (audioContextRef.current.state === "suspended") void audioContextRef.current.resume();
    } catch {
      // Audio is best-effort only.
    }
  }

  async function requestAudioDevicePermission() {
    try {
      if (!navigator.mediaDevices?.getUserMedia) {
        alert("このブラウザでは音声デバイス許可を取得できません。");
        return;
      }

      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      stream.getTracks().forEach((track) => track.stop());
      await loadAudioOutputDevices();
      alert("音声デバイス情報を更新しました。");
    } catch {
      alert("音声デバイスの許可が得られませんでした。ブラウザまたはWindowsの設定を確認してください。");
    }
  }

  async function loadAudioOutputDevices() {
    try {
      if (!navigator.mediaDevices?.enumerateDevices) {
        alert("このブラウザでは音声出力デバイス一覧を取得できません。");
        return;
      }

      const devices = await navigator.mediaDevices.enumerateDevices();
      const outputs = devices
        .filter((device) => device.kind === "audiooutput")
        .map((device, index) => ({
          deviceId: device.deviceId,
          label: device.label || `Audio output ${index + 1}`,
        }));

      setAudioOutputDevices(outputs);
    } catch {
      alert("音声出力デバイスの取得に失敗しました。");
    }
  }

  function getAlarmPattern(type: AlarmType) {
    if (type === "chime") {
      return [
        { start: 0.0, freq: 660, duration: 0.18, volume: 0.55 },
        { start: 0.22, freq: 880, duration: 0.22, volume: 0.55 },
        { start: 0.50, freq: 1320, duration: 0.35, volume: 0.45 },
      ];
    }

    if (type === "urgent") {
      return [
        { start: 0.0, freq: 1200, duration: 0.16, volume: 0.80 },
        { start: 0.22, freq: 1200, duration: 0.16, volume: 0.80 },
        { start: 0.44, freq: 1200, duration: 0.16, volume: 0.80 },
        { start: 0.76, freq: 900, duration: 0.16, volume: 0.80 },
        { start: 0.98, freq: 900, duration: 0.16, volume: 0.80 },
        { start: 1.20, freq: 900, duration: 0.16, volume: 0.80 },
      ];
    }

    if (type === "soft") {
      return [
        { start: 0.0, freq: 523.25, duration: 0.35, volume: 0.35 },
        { start: 0.42, freq: 659.25, duration: 0.35, volume: 0.35 },
        { start: 0.84, freq: 783.99, duration: 0.45, volume: 0.30 },
      ];
    }

    return [
      { start: 0.0, freq: 880, duration: 0.22, volume: 0.70 },
      { start: 0.35, freq: 880, duration: 0.22, volume: 0.70 },
      { start: 0.70, freq: 880, duration: 0.22, volume: 0.70 },
      { start: 1.05, freq: 880, duration: 0.22, volume: 0.70 },
    ];
  }

  function playAlarmSoundOnce() {
    try {
      initAudio();
      const ctx = audioContextRef.current;
      if (!ctx) return;

      const destination = ctx.createMediaStreamDestination();
      currentAlarmSourceRef.current = destination;

      const pattern = getAlarmPattern(alarmType);
      const startAt = ctx.currentTime + 0.03;
      const totalDuration = Math.max(...pattern.map((p) => p.start + p.duration)) + 0.2;

      for (const tone of pattern) {
        const oscillator = ctx.createOscillator();
        const gain = ctx.createGain();

        const targetVolume = Math.max(0.0001, Math.min(3, tone.volume * alarmVolume));

        oscillator.type = alarmType === "urgent" ? "square" : "sine";
        oscillator.frequency.setValueAtTime(tone.freq, startAt + tone.start);
        gain.gain.setValueAtTime(0.0001, startAt + tone.start);
        gain.gain.exponentialRampToValueAtTime(targetVolume, startAt + tone.start + 0.02);
        gain.gain.exponentialRampToValueAtTime(0.0001, startAt + tone.start + tone.duration);

        oscillator.connect(gain);
        gain.connect(destination);
        oscillator.start(startAt + tone.start);
        oscillator.stop(startAt + tone.start + tone.duration + 0.03);
      }

      const audio = new Audio();
      alarmAudioRef.current = audio;
      audio.srcObject = destination.stream;
      audio.volume = 1;

      const audioWithSink = audio as HTMLAudioElement & {
        setSinkId?: (sinkId: string) => Promise<void>;
      };

      const play = () => {
        void audio.play();
        window.setTimeout(() => {
          audio.pause();
          audio.srcObject = null;
          if (currentAlarmSourceRef.current === destination) {
            currentAlarmSourceRef.current = null;
          }
        }, totalDuration * 1000 + 250);
      };

      if (audioWithSink.setSinkId && selectedAudioOutputId) {
        audioWithSink
          .setSinkId(selectedAudioOutputId)
          .then(play)
          .catch(play);
      } else {
        play();
      }
    } catch {
      // Ignore audio failures.
    }
  }

  function stopAlarmSound() {
    if (alarmIntervalRef.current !== null) {
      window.clearInterval(alarmIntervalRef.current);
      alarmIntervalRef.current = null;
    }

    if (alarmAudioRef.current) {
      alarmAudioRef.current.pause();
      alarmAudioRef.current.srcObject = null;
      alarmAudioRef.current = null;
    }

    currentAlarmSourceRef.current = null;
    setIsAlarmRinging(false);
    setAlarmMessage("");
  }

  function startAlarmSound() {
    stopAlarmSound();
    setIsAlarmRinging(true);
    playAlarmSoundOnce();

    alarmIntervalRef.current = window.setInterval(() => {
      playAlarmSoundOnce();
    }, alarmType === "urgent" ? 1800 : 2400);
  }

  function testAlarmSound() {
    initAudio();
    startAlarmSound();
  }

  function scrollToStep(stepId: string) {
    window.setTimeout(() => {
      const element = document.getElementById(`step-${stepId}`);
      if (!element) return;

      element.scrollIntoView({
        behavior: "smooth",
        block: "center",
      });

      element.classList.add("stepFlash");
      window.setTimeout(() => element.classList.remove("stepFlash"), 2200);
    }, 100);
  }

  async function requestNotificationPermission() {
    if (typeof Notification === "undefined") {
      alert("このブラウザではPC通知を利用できません。");
      setNotificationPermission("unsupported");
      return;
    }

    const permission = await Notification.requestPermission();
    setNotificationPermission(permission);

    if (permission === "granted") {
      alert("PC通知を有効にしました。");
    } else {
      alert("PC通知が許可されませんでした。ブラウザのサイト設定を確認してください。");
    }
  }

  function showOneMinuteNotification(runName: string, stepName: string) {
    if (typeof Notification === "undefined") return;
    if (Notification.permission !== "granted") return;

    try {
      new Notification("Protocol Timer: 1分前", {
        body: `${runName}: ${stepName} は約1分後に終了します。`,
        silent: false,
      });
    } catch {
      // Ignore notification failures.
    }
  }

  function updateRun(runId: string, updater: (run: ExperimentRun) => ExperimentRun) {
    setRuns((prev) => prev.map((r) => (r.id === runId ? updater(r) : r)));
  }

  function startExperimentFromPreset() {
    const preset = presets.find((p) => p.id === selectedPresetId);
    if (!preset) {
      alert("プリセットを選択してください。");
      return;
    }

    const name = prompt("この実験ランの名前", `${preset.name} ${runs.length + 1}`);
    if (!name) return;

    setRuns((prev) => [...prev, createExperimentFromPreset(preset, name)]);
  }

  function createBlankExperiment() {
    const name = prompt("空の実験名", `Experiment ${runs.length + 1}`);
    if (!name) return;

    const emptyPreset: ProtocolPreset = {
      id: "",
      name: "Blank",
      createdAt: nowIso(),
      steps: [],
    };

    setRuns((prev) => [...prev, createExperimentFromPreset(emptyPreset, name)]);
  }

  function saveRunAsPreset(runId: string) {
    const run = runs.find((r) => r.id === runId);
    if (!run) return;

    const presetName = prompt("保存するプリセット名", `${run.name} preset`);
    if (!presetName) return;

    const preset: ProtocolPreset = {
      id: id(),
      name: presetName,
      createdAt: nowIso(),
      steps: run.steps.map(stepToTemplate),
    };

    setPresets((prev) => [...prev, preset]);
    updateRun(runId, (r) =>
      addEvent(r, "protocol_preset_saved", `Saved current protocol as preset ${presetName}`)
    );
  }

  function deletePreset() {
    const preset = presets.find((p) => p.id === selectedPresetId);
    if (!preset) return;

    if (presets.length <= 1) {
      alert("プリセットは最低1つ必要です。");
      return;
    }

    if (!confirm(`プリセット「${preset.name}」を削除しますか？既存の実験ログは削除されません。`)) return;

    setPresets((prev) => prev.filter((p) => p.id !== selectedPresetId));
    const next = presets.find((p) => p.id !== selectedPresetId);
    setSelectedPresetId(next?.id ?? "");
  }

  function deleteExperiment(runId: string) {
    if (!confirm("この実験を削除しますか？")) return;
    setRuns((prev) => prev.filter((r) => r.id !== runId));
  }

  function renameExperiment(runId: string) {
    const run = runs.find((r) => r.id === runId);
    if (!run) return;
    const name = prompt("実験名", run.name);
    if (!name) return;
    updateRun(runId, (r) => ({ ...r, name }));
  }

  function resetExperiment(runId: string) {
    const run = runs.find((r) => r.id === runId);
    if (!run) return;

    if (!confirm(`「${run.name}」の全ステップを未開始に戻しますか？イベントログにはリセット操作が残ります。`)) return;

    const stepIds = run.steps.map((step) => step.id);
    setAlarmedStepIds((prev) => prev.filter((id) => !stepIds.includes(id)));
    setWarnedStepIds((prev) => prev.filter((id) => !stepIds.includes(id)));
    stopAlarmSound();

    updateRun(runId, (r) => {
      const ts = nowIso();
      const updated: ExperimentRun = {
        ...r,
        steps: r.steps.map(resetStepRuntime),
      };
      return addEvent(updated, "experiment_reset", `Reset all steps in ${r.name}`, undefined, ts);
    });
  }

  function startStep(runId: string, stepId: string) {
    initAudio();
    setAlarmedStepIds((prev) => prev.filter((id) => id !== stepId));
    setWarnedStepIds((prev) => prev.filter((id) => id !== stepId));
    updateRun(runId, (run) => {
      const ts = nowIso();
      let updated: ExperimentRun = {
        ...run,
        steps: run.steps.map((s) => {
          if (s.id !== stepId) return s;
          if (s.status !== "pending" && s.status !== "paused") return s;
          return {
            ...s,
            status: "running",
            startedAt: s.startedAt ?? ts,
            pauseStartedAt: undefined,
          };
        }),
      };

      const step = run.steps.find((s) => s.id === stepId);
      updated = addEvent(updated, "step_started", `Started ${step?.name ?? "step"}`, stepId, ts);
      return updated;
    });
  }

  function pauseStep(runId: string, stepId: string) {
    updateRun(runId, (run) => {
      const ts = nowIso();
      let stepName = "";
      let updated: ExperimentRun = {
        ...run,
        steps: run.steps.map((s) => {
          if (s.id !== stepId || s.status !== "running") return s;
          stepName = s.name;
          return { ...s, status: "paused", pauseStartedAt: ts };
        }),
      };
      updated = addEvent(updated, "step_paused", `Paused ${stepName}`, stepId, ts);
      return updated;
    });
  }

  function resumeStep(runId: string, stepId: string) {
    updateRun(runId, (run) => {
      const ts = nowIso();
      let stepName = "";
      let updated: ExperimentRun = {
        ...run,
        steps: run.steps.map((s) => {
          if (s.id !== stepId || s.status !== "paused") return s;
          stepName = s.name;
          const pausedFor = s.pauseStartedAt ? secondsBetween(s.pauseStartedAt, ts) : 0;
          return {
            ...s,
            status: "running",
            pauseStartedAt: undefined,
            totalPausedSec: s.totalPausedSec + pausedFor,
          };
        }),
      };
      updated = addEvent(updated, "step_resumed", `Resumed ${stepName}`, stepId, ts);
      return updated;
    });
  }

  function finishStep(runId: string, stepId: string) {
    updateRun(runId, (run) => {
      const ts = nowIso();
      let stepName = "";
      let updated: ExperimentRun = {
        ...run,
        steps: run.steps.map((s) => {
          if (s.id !== stepId || (s.status !== "running" && s.status !== "paused")) return s;
          stepName = s.name;

          const extraPause =
            s.status === "paused" && s.pauseStartedAt ? secondsBetween(s.pauseStartedAt, ts) : 0;

          return {
            ...s,
            status: "done",
            endedAt: ts,
            pauseStartedAt: undefined,
            totalPausedSec: s.totalPausedSec + extraPause,
          };
        }),
      };
      updated = addEvent(updated, "step_finished", `Finished ${stepName}`, stepId, ts);
      return updated;
    });
  }

  function skipStep(runId: string, stepId: string) {
    const reason = prompt("この手順をスキップする理由を入力してください。", "");
    if (reason === null) return;

    updateRun(runId, (run) => {
      const ts = nowIso();
      let stepName = "";
      let updated: ExperimentRun = {
        ...run,
        steps: run.steps.map((s) => {
          if (s.id !== stepId || s.status === "done") return s;
          stepName = s.name;
          return { ...s, status: "skipped", endedAt: ts, notes: s.notes ? `${s.notes}\nSkip reason: ${reason}` : `Skip reason: ${reason}` };
        }),
      };
      updated = addEvent(updated, "step_skipped", `Skipped ${stepName}${reason ? `; reason: ${reason}` : ""}`, stepId, ts);
      return updated;
    });
  }

  function resetSingleStep(runId: string, stepId: string) {
    setAlarmedStepIds((prev) => prev.filter((id) => id !== stepId));
    setWarnedStepIds((prev) => prev.filter((id) => id !== stepId));
    const run = runs.find((r) => r.id === runId);
    const step = run?.steps.find((s) => s.id === stepId);
    if (!run || !step) return;

    if (!confirm(`「${step.name}」を未開始に戻しますか？このステップの開始/終了時刻、調整、メモが消えます。`)) return;

    const reason = prompt("このステップをリセットする理由を入力してください。", "誤って開始したため");
    if (reason === null) return;

    updateRun(runId, (r) => {
      const ts = nowIso();
      const updated: ExperimentRun = {
        ...r,
        steps: r.steps.map((s) => (s.id === stepId ? resetStepRuntime(s) : s)),
      };
      return addEvent(updated, "step_reset", `Reset step ${step.name}${reason ? `; reason: ${reason}` : ""}`, stepId, ts);
    });
  }

  function adjustStep(runId: string, stepId: string, deltaSec: number, reason = "") {
    updateRun(runId, (run) => {
      const ts = nowIso();
      let stepName = "";
      let updated: ExperimentRun = {
        ...run,
        steps: run.steps.map((s) => {
          if (s.id !== stepId || s.status === "done" || s.status === "skipped") return s;
          stepName = s.name;
          return { ...s, adjustmentSec: s.adjustmentSec + deltaSec };
        }),
      };
      const duration = formatDuration(Math.abs(deltaSec));
      const action = deltaSec >= 0 ? "step_extended" : "step_shortened";
      const label = deltaSec >= 0 ? "Extended" : "Shortened";
      updated = addEvent(updated, action, `${label} ${stepName} by ${duration}${reason ? `; reason: ${reason}` : ""}`, stepId, ts);
      return updated;
    });
  }

  function customAdjustStep(runId: string, stepId: string, direction: "extend" | "shorten") {
    const label = direction === "extend" ? "延長" : "短縮";
    const seconds = promptDurationSeconds(`${label}する時間`, "30s");
    if (seconds === undefined) return;

    const reason = prompt(`${label}する理由を入力してください。`, "");
    if (reason === null) return;

    adjustStep(runId, stepId, direction === "extend" ? seconds : -seconds, reason);
  }

  function insertStepAfter(runId: string, afterStepId?: string) {
    const name = prompt("追加する手順名", "追加手順");
    if (!name) return;

    const plannedSeconds = promptDurationSeconds("予定時間", "1m");
    if (plannedSeconds === undefined) return;

    const reason = prompt("実験中にこの手順を追加する理由を入力してください。", "");
    if (reason === null) return;

    updateRun(runId, (run) => {
      const insertIndex = afterStepId
        ? run.steps.findIndex((s) => s.id === afterStepId) + 1
        : run.steps.length;

      const newStep = { ...makeStepSeconds(name, plannedSeconds, insertIndex + 1), notes: reason ? `Add reason: ${reason}` : "" };
      const nextSteps = [...run.steps];
      nextSteps.splice(insertIndex, 0, newStep);

      let updated: ExperimentRun = {
        ...run,
        steps: nextSteps.map((s, i) => ({ ...s, order: i + 1 })),
      };

      updated = addEvent(
        updated,
        "step_added",
        `Inserted ${name}; planned ${formatDuration(plannedSeconds)}${reason ? `; reason: ${reason}` : ""}`,
        newStep.id
      );

      return updated;
    });
  }

  function addNote(runId: string, stepId: string) {
    const note = prompt("メモ");
    if (!note) return;

    updateRun(runId, (run) => {
      const ts = nowIso();
      let stepName = "";
      let updated: ExperimentRun = {
        ...run,
        steps: run.steps.map((s) => {
          if (s.id !== stepId) return s;
          stepName = s.name;
          return { ...s, notes: s.notes ? `${s.notes}\n${note}` : note };
        }),
      };
      updated = addEvent(updated, "note_added", `Note on ${stepName}: ${note}`, stepId, ts);
      return updated;
    });
  }

  function exportStepSummary() {
    const rows = [
      [
        "experiment_id",
        "experiment_name",
        "preset_id",
        "step_order",
        "step_name",
        "status",
        "planned_duration_min",
        "adjustment_min",
        "target_duration_min",
        "actual_duration_min",
        "started_at",
        "ended_at",
        "notes",
      ],
    ];

    for (const run of runs) {
      for (const step of run.steps) {
        const actual = getActualDurationSec(step);
        rows.push([
          run.id,
          run.name,
          run.protocolPresetId ?? "",
          String(step.order),
          step.name,
          step.status,
          (step.plannedDurationSec / 60).toFixed(2),
          (step.adjustmentSec / 60).toFixed(2),
          (getTargetDurationSec(step) / 60).toFixed(2),
          actual === undefined ? "" : (actual / 60).toFixed(2),
          formatDateTime(step.startedAt),
          formatDateTime(step.endedAt),
          step.notes,
        ]);
      }
    }

    const csv = rows.map((r) => r.map(csvEscape).join(",")).join("\n");
    downloadText(`protocol_step_summary_${new Date().toISOString().slice(0, 10)}.csv`, csv);
  }

  function exportEventLog() {
    const rows = [["experiment_id", "experiment_name", "step_id", "timestamp", "action", "detail"]];

    for (const run of runs) {
      for (const ev of run.events) {
        rows.push([
          run.id,
          run.name,
          ev.stepId ?? "",
          formatDateTime(ev.timestamp),
          ev.action,
          ev.detail,
        ]);
      }
    }

    const csv = rows.map((r) => r.map(csvEscape).join(",")).join("\n");
    downloadText(`protocol_event_log_${new Date().toISOString().slice(0, 10)}.csv`, csv);
  }

  function exportRunReportHtml() {
    const generatedAt = new Date().toISOString();
    const allEvents = runs
      .flatMap((run) =>
        run.events.map((event) => ({
          ...event,
          experimentName: run.name,
          stepName: run.steps.find((step) => step.id === event.stepId)?.name ?? "",
        }))
      )
      .sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());

    const runSections = runs
      .map((run) => {
        const rows = run.steps
          .map((step) => {
            const actual = getActualDurationSec(step);
            return `
              <tr>
                <td>${step.order}</td>
                <td>${htmlEscape(step.name)}</td>
                <td>${htmlEscape(step.status)}</td>
                <td>${formatDuration(step.plannedDurationSec)}</td>
                <td>${formatDuration(step.adjustmentSec)}</td>
                <td>${formatDuration(getTargetDurationSec(step))}</td>
                <td>${actual === undefined ? "" : formatDuration(actual)}</td>
                <td>${htmlEscape(formatDateTime(step.startedAt))}</td>
                <td>${htmlEscape(formatDateTime(step.endedAt))}</td>
                <td>${htmlEscape(step.notes).replaceAll("\n", "<br>")}</td>
              </tr>
            `;
          })
          .join("");

        return `
          <section>
            <h2>${htmlEscape(run.name)}</h2>
            <p class="muted">Created: ${htmlEscape(formatDateTime(run.createdAt))}</p>
            <table>
              <thead>
                <tr>
                  <th>#</th>
                  <th>Step</th>
                  <th>Status</th>
                  <th>Planned</th>
                  <th>Adjustment</th>
                  <th>Target</th>
                  <th>Actual</th>
                  <th>Started</th>
                  <th>Ended</th>
                  <th>Notes</th>
                </tr>
              </thead>
              <tbody>${rows}</tbody>
            </table>
          </section>
        `;
      })
      .join("");

    const eventRows = allEvents
      .map(
        (event) => `
          <tr>
            <td>${htmlEscape(formatDateTime(event.timestamp))}</td>
            <td>${htmlEscape(event.experimentName)}</td>
            <td>${htmlEscape(event.stepName)}</td>
            <td>${htmlEscape(event.action)}</td>
            <td>${htmlEscape(event.detail)}</td>
          </tr>
        `
      )
      .join("");

    const html = `<!doctype html>
<html lang="ja">
<head>
  <meta charset="UTF-8" />
  <title>Protocol Timer Run Report</title>
  <style>
    body {
      font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      margin: 24px;
      color: #111827;
    }
    h1 { margin-bottom: 4px; }
    h2 { margin-top: 28px; border-bottom: 1px solid #d1d5db; padding-bottom: 6px; }
    .muted { color: #6b7280; }
    table {
      border-collapse: collapse;
      width: 100%;
      margin: 12px 0 24px;
      font-size: 12px;
    }
    th, td {
      border: 1px solid #d1d5db;
      padding: 6px 8px;
      vertical-align: top;
    }
    th {
      background: #f3f4f6;
      text-align: left;
    }
    @media print {
      body { margin: 12mm; }
      section { break-inside: avoid; }
    }
  </style>
</head>
<body>
  <h1>Protocol Timer Run Report</h1>
  <p class="muted">Generated: ${htmlEscape(formatDateTime(generatedAt))}</p>
  <p>このレポートには、同時並行で進めた実験ランがすべてまとめて含まれます。</p>

  ${runSections}

  <section>
    <h2>Combined Event Timeline</h2>
    <table>
      <thead>
        <tr>
          <th>Time</th>
          <th>Experiment</th>
          <th>Step</th>
          <th>Action</th>
          <th>Detail</th>
        </tr>
      </thead>
      <tbody>${eventRows}</tbody>
    </table>
  </section>
</body>
</html>`;

    downloadHtml(`protocol_run_report_${new Date().toISOString().slice(0, 10)}.html`, html);
  }

  const selectedPreset = presets.find((p) => p.id === selectedPresetId);

  return (
    <main className="app">
      <header className="topbar compactTopbar">
        <div className="brandBlock">
          <h1>Protocol Timer</h1>
        </div>

        <nav className="screenTabs compactTabs">
          <button
            className={activeScreen === "run" ? "tabButton active" : "tabButton"}
            onClick={() => setActiveScreen("run")}
          >
            実行画面
          </button>
          <button
            className={activeScreen === "protocol" ? "tabButton active" : "tabButton"}
            onClick={() => setActiveScreen("protocol")}
          >
            プロトコル作成
          </button>
        </nav>

        <div className="topbarActions">
          <button onClick={exportStepSummary}>
            <Download size={16} />
            Step CSV
          </button>
          <button onClick={exportEventLog}>
            <Download size={16} />
            Event CSV
          </button>
          <button onClick={exportRunReportHtml}>
            <Download size={16} />
            Run Report
          </button>
        </div>
      </header>


      <section className="audioSettings">
        <label>
          <span>Alarm type</span>
          <select value={alarmType} onChange={(e) => setAlarmType(e.target.value as AlarmType)}>
            <option value="beep">Beep</option>
            <option value="chime">Chime</option>
            <option value="urgent">Urgent</option>
            <option value="soft">Soft</option>
          </select>
        </label>

        <label>
          <span>Alarm volume: {Math.round(alarmVolume * 100)}%</span>
          <input
            className="volumeSlider"
            type="range"
            min="0"
            max="300"
            value={Math.round(alarmVolume * 100)}
            onChange={(e) => setAlarmVolume(Number(e.target.value) / 100)}
          />
        </label>

        <label>
          <span>Audio output</span>
          <select value={selectedAudioOutputId} onChange={(e) => setSelectedAudioOutputId(e.target.value)}>
            <option value="default">Default / OS setting</option>
            {audioOutputDevices.map((device) => (
              <option key={device.deviceId} value={device.deviceId}>
                {device.label}
              </option>
            ))}
          </select>
        </label>

        <button onClick={requestAudioDevicePermission}>Allow / Refresh devices</button>
        <button onClick={testAlarmSound}>Test alarm</button>
        <button onClick={requestNotificationPermission}>Allow PC notifications</button>
        <span className="notificationStatus">通知: {notificationPermission}</span>
        {isAlarmRinging && (
          <button className="danger" onClick={stopAlarmSound}>
            Stop alarm
          </button>
        )}
        <div className="audioHint">
          10分以上のステップでは、通知を許可している場合のみ終了1分前にPC通知を表示します。
        </div>
      </section>


      <section className="pwaNotice">
        <strong>スマホ/iPad版</strong>
        <span>Safari/Chromeで開いて、共有 → ホーム画面に追加 でアプリ風に使えます。実験中は画面を開いたまま使うのがおすすめです。</span>
      </section>

      {alarmMessage && (
        <div className="alarmBanner">
          <strong>アラーム</strong>
          <span>{alarmMessage}</span>
          <button onClick={stopAlarmSound}>Stop alarm</button>
        </div>
      )}

      {activeScreen === "protocol" ? (
        <ProtocolBuilder
          presets={presets}
          selectedPresetId={selectedPresetId}
          setSelectedPresetId={setSelectedPresetId}
          setPresets={setPresets}
          goToRunScreen={() => setActiveScreen("run")}
        />
      ) : (
        <>
          <section className="presetPanel">
            <div className="presetMain">
              <label>
                <span>Protocol preset</span>
                <select value={selectedPresetId} onChange={(e) => setSelectedPresetId(e.target.value)}>
                  {presets.map((preset) => (
                    <option key={preset.id} value={preset.id}>
                      {preset.name}
                    </option>
                  ))}
                </select>
              </label>

              <div className="presetPreview">
                {selectedPreset ? (
                  <>
                    <strong>{selectedPreset.name}</strong>
                    <span>
                      {selectedPreset.steps.length} steps / total{" "}
                      {formatDuration(
                        selectedPreset.steps.reduce((sum, step) => sum + step.plannedDurationSec, 0)
                      )}
                    </span>
                  </>
                ) : (
                  <span>プリセットなし</span>
                )}
              </div>
            </div>

            <div className="presetActions">
              <button className="primary" onClick={startExperimentFromPreset}>
                <PlayCircle size={16} />
                Start from Preset
              </button>
              <button onClick={createBlankExperiment}>
                <Plus size={16} />
                Blank Experiment
              </button>
            </div>
          </section>

          {runs.length === 0 ? (
            <section className="emptyState">
              <h2>まだ実験ランがありません</h2>
              <p>上のプリセットを選び、「Start from Preset」を押すと実験を開始できます。</p>
              <p>新しいプロトコルを作る場合は、上の「プロトコル作成」タブを開いてください。</p>
            </section>
          ) : (
            <section className="runs">
              {runs.map((run) => (
                <ExperimentCard
                  key={run.id}
                  run={run}
                  tick={tick}
                  onRename={() => renameExperiment(run.id)}
                  onDelete={() => deleteExperiment(run.id)}
                  onReset={() => resetExperiment(run.id)}
                  onSavePreset={() => saveRunAsPreset(run.id)}
                  onStart={(stepId) => startStep(run.id, stepId)}
                  onPause={(stepId) => pauseStep(run.id, stepId)}
                  onResume={(stepId) => resumeStep(run.id, stepId)}
                  onFinish={(stepId) => finishStep(run.id, stepId)}
                  onSkip={(stepId) => skipStep(run.id, stepId)}
                  onResetStep={(stepId) => resetSingleStep(run.id, stepId)}
                  onAdjust={(stepId, deltaSec, reason) => adjustStep(run.id, stepId, deltaSec, reason)}
                  onCustomAdjust={(stepId, direction) => customAdjustStep(run.id, stepId, direction)}
                  onInsert={(afterStepId) => insertStepAfter(run.id, afterStepId)}
                  onNote={(stepId) => addNote(run.id, stepId)}
                />
              ))}
            </section>
          )}
        </>
      )}
    </main>
  );
}


type ProtocolBuilderProps = {
  presets: ProtocolPreset[];
  selectedPresetId: string;
  setSelectedPresetId: React.Dispatch<React.SetStateAction<string>>;
  setPresets: React.Dispatch<React.SetStateAction<ProtocolPreset[]>>;
  goToRunScreen: () => void;
};

function ProtocolBuilder(props: ProtocolBuilderProps) {
  const { presets, selectedPresetId, setSelectedPresetId, setPresets, goToRunScreen } = props;

  const selectedPreset = presets.find((p) => p.id === selectedPresetId) ?? presets[0];
  const importInputRef = useRef<HTMLInputElement | null>(null);

  const [draftName, setDraftName] = useState(selectedPreset?.name ?? "");
  const [draftSteps, setDraftSteps] = useState<ProtocolStepTemplate[]>(selectedPreset?.steps ?? []);

  useEffect(() => {
    const preset = presets.find((p) => p.id === selectedPresetId) ?? presets[0];
    setDraftName(preset?.name ?? "");
    setDraftSteps(preset ? preset.steps.map((s) => ({ ...s })) : []);
  }, [selectedPresetId, presets]);

  const totalSeconds = draftSteps.reduce((sum, step) => sum + step.plannedDurationSec, 0);

  function createNewProtocol() {
    const name = prompt("新しいプロトコル名", "New protocol");
    if (!name) return;

    const preset: ProtocolPreset = {
      id: id(),
      name,
      createdAt: nowIso(),
      steps: [],
    };

    setPresets((prev) => [...prev, preset]);
    setSelectedPresetId(preset.id);
  }

  function duplicateProtocol() {
    if (!selectedPreset) return;

    const name = prompt("複製後のプロトコル名", `${selectedPreset.name} copy`);
    if (!name) return;

    const preset: ProtocolPreset = {
      id: id(),
      name,
      createdAt: nowIso(),
      steps: draftSteps.map((s) => ({ ...s })),
    };

    setPresets((prev) => [...prev, preset]);
    setSelectedPresetId(preset.id);
  }

  function saveProtocol() {
    if (!selectedPreset) return;

    const name = draftName.trim();
    if (!name) {
      alert("プロトコル名を入力してください。");
      return;
    }

    if (draftSteps.length === 0 && !confirm("ステップが0件です。このまま保存しますか？")) {
      return;
    }

    setPresets((prev) =>
      prev.map((preset) =>
        preset.id === selectedPreset.id
          ? {
              ...preset,
              name,
              steps: draftSteps.map((s) => ({ ...s })),
            }
          : preset
      )
    );

    alert("プロトコルを保存しました。");
  }

  function deleteCurrentProtocol() {
    if (!selectedPreset) return;

    if (presets.length <= 1) {
      alert("プロトコルは最低1つ必要です。");
      return;
    }

    if (!confirm(`プロトコル「${selectedPreset.name}」を削除しますか？既存の実験ログは削除されません。`)) {
      return;
    }

    const nextPreset = presets.find((p) => p.id !== selectedPreset.id);
    setPresets((prev) => prev.filter((p) => p.id !== selectedPreset.id));
    setSelectedPresetId(nextPreset?.id ?? "");
  }

  async function exportCurrentProtocol() {
    if (!selectedPreset) return;

    const protocolToExport: ProtocolPreset = {
      ...selectedPreset,
      name: draftName.trim() || selectedPreset.name,
      steps: draftSteps.map((s) => ({ ...s })),
    };

    try {
      const result = await saveProtocolFileToAppFolder(protocolToExport);
      alert(`プロトコルをアプリフォルダ内に保存しました。\nprotocols/${result.filename}`);
    } catch {
      downloadJson(
        `protocol_${safeFileName(protocolToExport.name)}_${new Date().toISOString().slice(0, 10)}.json`,
        protocolToExport
      );
      alert("アプリフォルダへの保存に失敗したため、通常のダウンロードとして保存しました。");
    }
  }

  async function exportAllProtocols() {
    const allProtocols = presets.map((preset) =>
      preset.id === selectedPreset?.id
        ? { ...preset, name: draftName.trim() || preset.name, steps: draftSteps.map((s) => ({ ...s })) }
        : preset
    );

    try {
      const result = await saveAllProtocolFilesToAppFolder(allProtocols);
      alert(`全プロトコルをアプリフォルダ内に保存しました。\nprotocols/ に ${result.count} 件保存しました。`);
    } catch {
      downloadJson(`protocols_all_${new Date().toISOString().slice(0, 10)}.json`, allProtocols);
      alert("アプリフォルダへの保存に失敗したため、通常のダウンロードとして保存しました。");
    }
  }

  async function loadProtocolsFromAppFolder() {
    try {
      const loaded = await loadProtocolFilesFromAppFolder();

      if (loaded.length === 0) {
        alert("protocols フォルダ内に読み込めるJSONがありません。");
        return;
      }

      const imported = loaded.map((preset) => ({
        ...preset,
        id: id(),
        name: `${preset.name} loaded`,
      }));

      setPresets((prev) => [...prev, ...imported]);
      setSelectedPresetId(imported[0].id);
      alert(`${imported.length}件のプロトコルを protocols フォルダから読み込みました。`);
    } catch {
      alert("protocols フォルダからの読み込みに失敗しました。");
    }
  }

  async function importProtocolsFromFile(file: File) {
    try {
      const data = await readJsonFile<ProtocolPreset | ProtocolPreset[]>(file);
      const incoming = Array.isArray(data) ? data : [data];

      const valid = incoming
        .filter((preset) => preset && typeof preset.name === "string" && Array.isArray(preset.steps))
        .map((preset) => ({
          id: id(),
          name: `${preset.name} imported`,
          createdAt: nowIso(),
          steps: preset.steps
            .filter((step) => step && typeof step.name === "string" && typeof step.plannedDurationSec === "number")
            .map((step) => ({
              name: step.name,
              plannedDurationSec: Math.max(0, Math.round(step.plannedDurationSec)),
            })),
        }));

      if (valid.length === 0) {
        alert("読み込めるプロトコルが見つかりませんでした。");
        return;
      }

      setPresets((prev) => [...prev, ...valid]);
      setSelectedPresetId(valid[0].id);
      alert(`${valid.length}件のプロトコルを読み込みました。`);
    } catch {
      alert("JSONファイルの読み込みに失敗しました。");
    }
  }

  function addProtocolStep() {
    const name = prompt("手順名", "新しい手順");
    if (!name) return;

    const seconds = promptDurationSeconds("予定時間", "1m");
    if (seconds === undefined) return;

    setDraftSteps((prev) => [...prev, { name, plannedDurationSec: seconds }]);
  }

  function updateStepName(index: number, name: string) {
    setDraftSteps((prev) =>
      prev.map((step, i) => (i === index ? { ...step, name } : step))
    );
  }

  function changeStepDuration(index: number) {
    const current = draftSteps[index];
    if (!current) return;

    const seconds = promptDurationSeconds("予定時間", formatDuration(current.plannedDurationSec));
    if (seconds === undefined) return;

    setDraftSteps((prev) =>
      prev.map((step, i) => (i === index ? { ...step, plannedDurationSec: seconds } : step))
    );
  }

  function moveStep(index: number, direction: -1 | 1) {
    setDraftSteps((prev) => {
      const next = [...prev];
      const target = index + direction;
      if (target < 0 || target >= next.length) return prev;

      const tmp = next[index];
      next[index] = next[target];
      next[target] = tmp;
      return next;
    });
  }

  function deleteStep(index: number) {
    const step = draftSteps[index];
    if (!step) return;

    if (!confirm(`「${step.name}」を削除しますか？`)) return;

    setDraftSteps((prev) => prev.filter((_, i) => i !== index));
  }

  return (
    <section className="builderPage">
      <div className="builderHeader">
        <div>
          <h2>プロトコル作成</h2>
          <p>ここで作成・編集したプロトコルを、実行画面で選んで開始できます。</p>
        </div>

        <div className="builderHeaderActions">
          <button onClick={createNewProtocol}>
            <Plus size={16} />
            New Protocol
          </button>
          <button onClick={duplicateProtocol}>Duplicate</button>
          <button className="primary" onClick={saveProtocol}>
            <Save size={16} />
            Save Protocol
          </button>
          <button onClick={exportCurrentProtocol}>Export JSON</button>
          <button onClick={exportAllProtocols}>Export All</button>
          <button onClick={() => importInputRef.current?.click()}>Import JSON</button>
          <button onClick={loadProtocolsFromAppFolder}>Load App Folder</button>
          <input
            ref={importInputRef}
            className="hiddenFileInput"
            type="file"
            accept="application/json,.json"
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) void importProtocolsFromFile(file);
              e.currentTarget.value = "";
            }}
          />
          <button className="danger" onClick={deleteCurrentProtocol}>
            <Trash2 size={16} />
            Delete
          </button>
        </div>
      </div>

      <div className="builderLayout">
        <aside className="protocolList">
          <label>
            <span>編集するプロトコル</span>
            <select value={selectedPresetId} onChange={(e) => setSelectedPresetId(e.target.value)}>
              {presets.map((preset) => (
                <option key={preset.id} value={preset.id}>
                  {preset.name}
                </option>
              ))}
            </select>
          </label>

          <div className="protocolStats">
            <strong>{draftSteps.length}</strong>
            <span>steps</span>
            <strong>{formatDuration(totalSeconds)}</strong>
            <span>total</span>
          </div>

          <button className="primary wideButton" onClick={goToRunScreen}>
            実行画面へ戻る
          </button>
        </aside>

        <section className="protocolEditor">
          <label className="fieldBlock">
            <span>プロトコル名</span>
            <input
              value={draftName}
              onChange={(e) => setDraftName(e.target.value)}
              placeholder="例: 脱パラフィン"
            />
          </label>

          <div className="editorToolbar">
            <button onClick={addProtocolStep}>
              <Plus size={16} />
              Add Step
            </button>
          </div>

          {draftSteps.length === 0 ? (
            <div className="emptyStepList">
              まだステップがありません。Add Step から手順を追加してください。
            </div>
          ) : (
            <div className="protocolStepList">
              {draftSteps.map((step, index) => (
                <div className="protocolStepRow" key={index}>
                  <div className="order">{index + 1}</div>

                  <input
                    className="stepNameInput"
                    value={step.name}
                    onChange={(e) => updateStepName(index, e.target.value)}
                    placeholder="手順名"
                  />

                  <button onClick={() => changeStepDuration(index)}>
                    {formatDuration(step.plannedDurationSec)}
                  </button>

                  <button onClick={() => moveStep(index, -1)} disabled={index === 0}>
                    ↑
                  </button>
                  <button onClick={() => moveStep(index, 1)} disabled={index === draftSteps.length - 1}>
                    ↓
                  </button>
                  <button className="danger" onClick={() => deleteStep(index)}>
                    <Trash2 size={16} />
                  </button>
                </div>
              ))}
            </div>
          )}
        </section>
      </div>
    </section>
  );
}


type ExperimentCardProps = {
  run: ExperimentRun;
  tick: number;
  onRename: () => void;
  onDelete: () => void;
  onReset: () => void;
  onSavePreset: () => void;
  onStart: (stepId: string) => void;
  onPause: (stepId: string) => void;
  onResume: (stepId: string) => void;
  onFinish: (stepId: string) => void;
  onSkip: (stepId: string) => void;
  onResetStep: (stepId: string) => void;
  onAdjust: (stepId: string, deltaSec: number, reason?: string) => void;
  onCustomAdjust: (stepId: string, direction: "extend" | "shorten") => void;
  onInsert: (afterStepId?: string) => void;
  onNote: (stepId: string) => void;
};

function ExperimentCard(props: ExperimentCardProps) {
  const {
    run,
    tick,
    onRename,
    onDelete,
    onReset,
    onSavePreset,
    onStart,
    onPause,
    onResume,
    onFinish,
    onSkip,
    onResetStep,
    onAdjust,
    onCustomAdjust,
    onInsert,
    onNote,
  } = props;

  const runningCount = useMemo(
    () => run.steps.filter((s) => s.status === "running" || s.status === "paused").length,
    [run.steps]
  );

  return (
    <article className="runCard">
      <div className="runHeader">
        <div>
          <div className="runTitleLine">
            <button className="linkButton titleButton" onClick={onRename}>
              {run.name}
            </button>
            <button className="addStepButton" onClick={() => onInsert(undefined)}>
              <Plus size={16} />
              Add Step
            </button>
          </div>
          <div className="muted">Created {formatDateTime(run.createdAt)}</div>
        </div>

        <div className="runHeaderRight">
          <span className={runningCount > 0 ? "badge active" : "badge"}>{runningCount} running</span>
          <button className="iconButton" onClick={onReset} title="Reset this experiment">
            <RotateCcw size={16} />
          </button>
          <button className="iconButton danger" onClick={onDelete} title="Delete experiment">
            <Trash2 size={16} />
          </button>
        </div>
      </div>

      <div className="steps">
        {run.steps.map((step) => (
          <StepRow
            key={step.id}
            step={step}
            tick={tick}
            onStart={() => onStart(step.id)}
            onPause={() => onPause(step.id)}
            onResume={() => onResume(step.id)}
            onFinish={() => onFinish(step.id)}
            onSkip={() => onSkip(step.id)}
            onReset={() => onResetStep(step.id)}
            onAdjust={(delta, reason) => onAdjust(step.id, delta, reason)}
            onCustomAdjust={(direction) => onCustomAdjust(step.id, direction)}
            onInsert={() => onInsert(step.id)}
            onNote={() => onNote(step.id)}
          />
        ))}
      </div>


    </article>
  );
}

type StepRowProps = {
  step: Step;
  tick: number;
  onStart: () => void;
  onPause: () => void;
  onResume: () => void;
  onFinish: () => void;
  onSkip: () => void;
  onReset: () => void;
  onAdjust: (deltaSec: number, reason?: string) => void;
  onCustomAdjust: (direction: "extend" | "shorten") => void;
  onInsert: () => void;
  onNote: () => void;
};

function StepRow(props: StepRowProps) {
  const { step, tick, onStart, onPause, onResume, onFinish, onSkip, onReset, onAdjust, onCustomAdjust, onInsert, onNote } =
    props;

  const elapsed = getElapsedSec(step, tick);
  const target = getTargetDurationSec(step);
  const remaining = Math.max(0, target - elapsed);
  const actual = getActualDurationSec(step);

  return (
    <div id={`step-${step.id}`} className={`step ${step.status}`}>
      <div className="stepMain">
        <div className="stepTop">
          <div className="stepName">
            <span className="order">{step.order}</span>
            <strong>{step.name}</strong>
          </div>
          <StatusPill status={step.status} />
        </div>

        <div className="timerLine">
          {step.status === "done" ? (
            <span>実測 {formatDuration(actual ?? elapsed)}</span>
          ) : step.status === "running" || step.status === "paused" ? (
            <span className="timerText">残り {formatDuration(remaining)}</span>
          ) : (
            <span>予定 {formatDuration(target)}</span>
          )}
        </div>

        <div className="meta">
          <span>開始 {formatClock(step.startedAt)}</span>
          <span>終了 {formatClock(step.endedAt)}</span>
          {step.adjustmentSec !== 0 && <span>調整 {formatDuration(step.adjustmentSec)}</span>}
        </div>

        {step.notes && <pre className="notes">{step.notes}</pre>}
      </div>

      <div className="actions">
        {step.status === "pending" && (
          <>
            <button className="primary" onClick={onStart}>Start</button>
            <button onClick={onSkip}>Skip</button>
          </>
        )}

        {step.status === "running" && (
          <>
            <button onClick={onPause}>Pause</button>
            <button className="primary" onClick={onFinish}>Finish</button>
          </>
        )}

        {step.status === "paused" && (
          <>
            <button onClick={onResume}>Resume</button>
            <button className="primary" onClick={onFinish}>Finish</button>
          </>
        )}

        {(step.status === "pending" || step.status === "running" || step.status === "paused") && (
          <>
            <button onClick={() => onCustomAdjust("extend")}>Extend</button>
            <button onClick={() => onCustomAdjust("shorten")}>Shorten</button>
          </>
        )}

        <button onClick={onReset}>
          <RotateCcw size={14} />
          Reset
        </button>
        <button onClick={onInsert}>Insert After</button>
        <button onClick={onNote}>Note</button>
      </div>
    </div>
  );
}

function StatusPill({ status }: { status: StepStatus }) {
  return <span className={`status ${status}`}>{status}</span>;
}

createRoot(document.getElementById("root")!).render(<App />);
