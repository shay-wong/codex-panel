import { useEffect, useMemo, useRef, useState, type PointerEvent } from "react";
import { Progress } from "@radix-ui/themes";
import "./NativeAdapterGraph.css";

type AdapterFeature = { feature: string; phase: string; message: string };
type Presentation = "active" | "collecting" | "success" | "hidden";

export type NativeAdapterGraphProps = {
  enabled: boolean;
  phase: string;
  message: string;
  progress?: number | null;
  features: AdapterFeature[];
};

const featureLabels: Record<string, string> = {
  quota: "API 发送限制", ultrafast: "Ultrafast", dot: "Dot 入口", tabs: "会话菜单",
  queue: "排队消息", pets: "宠物", projectlessChat: "无项目聊天",
  repositoryBranchPrefix: "仓库分支前缀", nativeUpdate: "Codex 更新", nativeServices: "原生服务",
  settingsPresentation: "设置界面",
  terminal: "底部终端",
};
const phaseLabels: Record<string, string> = {
  waiting: "等待适配", loading: "适配中", applying: "启用中", prepared: "待应用", ready: "已启用", failed: "适配失败",
};
const activePhases = new Set(["reading", "adapting", "prepared", "applying"]);
const stageLabels: Record<string, string> = {
  reading: "读取资源", adapting: "适配中", prepared: "等待应用", applying: "正在应用",
};

export function NativeAdapterGraph({ enabled, phase, message, progress, features }: NativeAdapterGraphProps) {
  const [presentation, setPresentation] = useState<Presentation>(() => enabled && activePhases.has(phase) ? "active" : "hidden");
  const [selected, setSelected] = useState<string | null>(null);
  const [hovered, setHovered] = useState<string | null>(null);
  const hadActive = useRef(enabled && activePhases.has(phase));
  const rootRef = useRef<HTMLDivElement>(null);
  const spaceRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const buttonRefs = useRef(new Map<string, HTMLButtonElement>());
  const rotation = useRef({ yaw: -.15, pitch: .13, pointer: null as { x: number; y: number } | null });
  const requestDraw = useRef<(() => void) | null>(null);
  const animation = useRef({ presentation, started: 0 });
  const modules = useMemo(() => {
    const statuses = new Map(features.map(feature => [feature.feature, feature]));
    const keys = [...Object.keys(featureLabels), ...features.map(feature => feature.feature).filter(feature => !(feature in featureLabels)).sort()];
    return [...new Set(keys)].map(feature => ({
      feature, label: featureLabels[feature] ?? feature,
      phase: statuses.get(feature)?.phase ?? "waiting", message: statuses.get(feature)?.message ?? "",
    }));
  }, [features]);
  const highlighted = hovered ?? selected;
  const visibleLabels = useMemo(() => {
    const priorities: Record<string, number> = { failed: 1, loading: 2, applying: 2, prepared: 3, waiting: 4, ready: 5 };
    const priority = (module: AdapterFeature) => module.feature === highlighted ? 0 : priorities[module.phase] ?? 4;
    return new Set([...modules].sort((left, right) => priority(left) - priority(right)).slice(0, 10).map(module => module.feature));
  }, [modules, highlighted]);
  const latest = useRef({ modules, presentation, visibleLabels });
  latest.current = { modules, presentation, visibleLabels };
  const visible = enabled && presentation !== "hidden" && (activePhases.has(phase) || phase === "ready");

  useEffect(() => {
    if (enabled && activePhases.has(phase)) {
      hadActive.current = true;
      setPresentation("active");
      return;
    }
    if (enabled && phase === "ready" && hadActive.current) {
      hadActive.current = false;
      if (document.hidden) { setPresentation("hidden"); return; }
      setPresentation("collecting");
      const success = setTimeout(() => setPresentation("success"), 1050);
      const hide = setTimeout(() => setPresentation("hidden"), 1800);
      const finishWhenHidden = () => {
        if (document.hidden) { clearTimeout(success); clearTimeout(hide); setPresentation("hidden"); }
      };
      document.addEventListener("visibilitychange", finishWhenHidden);
      return () => { clearTimeout(success); clearTimeout(hide); document.removeEventListener("visibilitychange", finishWhenHidden); };
    }
    hadActive.current = false;
    setPresentation("hidden");
  }, [enabled, phase]);

  useEffect(() => {
    animation.current = { presentation, started: performance.now() };
    requestDraw.current?.();
  }, [presentation]);

  useEffect(() => {
    requestDraw.current?.();
  }, [modules, selected, hovered]);

  useEffect(() => {
    if (!visible) return;
    const root = rootRef.current!;
    const space = spaceRef.current!;
    const canvas = canvasRef.current!;
    const context = typeof CanvasRenderingContext2D === "undefined" ? null : canvas.getContext("2d");
    if (!context) {
      root.classList.add("no-canvas");
      return;
    }
    const ctx = context;
    const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
    let width = 0;
    const height = 260;
    let frame: number | undefined;
    let colors: string[] = [];
    let labelFont = "";
    let disposed = false;

    function palette() {
      colors = Array.from(root.querySelectorAll<HTMLElement>(".native-adapter-palette span"), element => getComputedStyle(element).color);
      labelFont = `11px ${getComputedStyle(root).fontFamily}`;
    }
    function resize() {
      width = space.clientWidth;
      const ratio = Math.min(window.devicePixelRatio || 1, 2);
      canvas.width = Math.round(width * ratio);
      canvas.height = height * ratio;
      ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
      palette();
      schedule();
    }
    function glow(x: number, y: number, radius: number, color: string, alpha = 1) {
      ctx.save();
      ctx.globalAlpha = alpha;
      ctx.shadowColor = color;
      ctx.shadowBlur = radius * 3;
      ctx.fillStyle = color;
      ctx.beginPath(); ctx.arc(x, y, radius, 0, Math.PI * 2); ctx.fill();
      ctx.restore();
    }
    function draw(time: number) {
      frame = undefined;
      if (disposed || document.hidden || !width) return;
      const { modules: current, presentation: mode, visibleLabels: names } = latest.current;
      const age = Math.max(0, time - animation.current.started);
      const collecting = mode === "collecting";
      const success = mode === "success";
      const expansion = reducedMotion.matches ? 1 : collecting ? Math.max(.06, 1 - Math.pow(Math.min(age / 1050, 1), 2) * .94) : success ? 0 : Math.min(1, 1 - Math.pow(1 - Math.min(age / 700, 1), 3));
      const motion = reducedMotion.matches || rotation.current.pointer ? 0 : Math.sin(time * .00024) * .13;
      const yaw = rotation.current.yaw + motion;
      const pitch = rotation.current.pitch;
      const projected = current.map((module, index) => {
        const angle = index / current.length * Math.PI * 2 - .2;
        const sphereY = 1 - 2 * (index + .5) / current.length;
        const radius = Math.sqrt(1 - sphereY * sphereY);
        const sphereAngle = index * Math.PI * (3 - Math.sqrt(5));
        const x = current.length <= 10 ? Math.cos(angle) : Math.cos(sphereAngle) * radius;
        const y = current.length <= 10 ? Math.sin(angle) * .92 : sphereY * .96;
        const z = current.length <= 10 ? Math.sin(angle * 2 + .5) * .5 : Math.sin(sphereAngle) * radius;
        const xx = x * Math.cos(yaw) + z * Math.sin(yaw);
        const zz = -x * Math.sin(yaw) + z * Math.cos(yaw);
        const yy = y * Math.cos(pitch) - zz * Math.sin(pitch);
        const depth = y * Math.sin(pitch) + zz * Math.cos(pitch);
        const scale = 2.9 / (2.9 - depth * .58);
        return { module, index, x: width / 2 + xx * Math.min(width * .31, 218) * scale * expansion, y: height / 2 + yy * 79 * scale * expansion, depth, scale };
      }).sort((a, b) => a.depth - b.depth);
      ctx.clearRect(0, 0, width, height);
      ctx.font = labelFont;
      const labelPositions = new Map<string, { left: number; top: number; width: number }>();
      const occupied = [{ left: width / 2 - 37, top: height / 2 + 24, width: 74, height: 20 }];
      for (const feature of names) {
        const point = projected.find(point => point.module.feature === feature)!;
        const labelWidth = ctx.measureText(point.module.label).width + 8;
        const left = Math.max(0, Math.min(width - labelWidth, point.x - labelWidth / 2));
        const preferredTop = point.y + (point.y < height / 2 ? -35 : 13);
        let top = preferredTop;
        for (let attempt = 0; attempt <= Math.ceil(height / 20) * 2; attempt++) {
          const offset = Math.ceil(attempt / 2) * 20 * (attempt % 2 ? -1 : 1);
          top = Math.max(0, Math.min(height - 17, preferredTop + offset));
          if (!occupied.some(other => left < other.left + other.width + 5 && left + labelWidth + 5 > other.left
            && top < other.top + other.height + 3 && top + 20 > other.top)) break;
        }
        labelPositions.set(feature, { left, top, width: labelWidth });
        occupied.push({ left, top, width: labelWidth, height: 17 });
      }
      if (!success) {
        ctx.save(); ctx.strokeStyle = colors[2]; ctx.globalAlpha = .17 * expansion; ctx.lineWidth = .65;
        for (const tilt of [-.32, .46]) { ctx.beginPath(); ctx.ellipse(width / 2, height / 2, Math.min(width * .35, 235), 77, tilt, 0, Math.PI * 2); ctx.stroke(); }
        ctx.restore();
      }
      for (const point of projected) {
        const { module, index, x, y, depth, scale } = point;
        const loading = module.phase === "loading" || module.phase === "applying";
        const color = module.phase === "ready" ? colors[1] : module.phase === "failed" ? colors[5] : module.phase === "prepared" ? colors[3] : loading ? colors[0] : colors[2];
        const bend = (index % 2 === 0 ? 1 : -1) * .19;
        const controlX = (width / 2 + x) / 2 - (y - height / 2) * bend;
        const controlY = (height / 2 + y) / 2 + (x - width / 2) * bend;
        if (!success) {
          ctx.save(); ctx.globalAlpha = (.18 + (depth + 1) * .14) * expansion; ctx.strokeStyle = color; ctx.lineWidth = .7 + (depth + 1) * .2;
          ctx.beginPath(); ctx.moveTo(width / 2, height / 2); ctx.quadraticCurveTo(controlX, controlY, x, y); ctx.stroke(); ctx.restore();
          if (!reducedMotion.matches && (loading || collecting)) {
            const progress = (time * .00032 + index * .117) % 1;
            const t = collecting ? 1 - progress : progress, u = 1 - t;
            glow(u * u * width / 2 + 2 * u * t * controlX + t * t * x, u * u * height / 2 + 2 * u * t * controlY + t * t * y, 1.8, color, .85 * expansion);
          }
          const size = (loading ? 4.3 : 3.3) * scale;
          glow(x, y, size, color, (.46 + (depth + 1) * .24) * expansion);
          if (loading || module.phase === "prepared") {
            ctx.save(); ctx.globalAlpha = .35 * expansion; ctx.strokeStyle = color;
            if (module.phase === "prepared") ctx.setLineDash([2, 2]);
            ctx.beginPath(); ctx.arc(x, y, size + 4, 0, Math.PI * 2); ctx.stroke(); ctx.restore();
          }
        }
        const button = buttonRefs.current.get(module.feature);
        if (button) {
          button.style.left = `${x}px`; button.style.top = `${y}px`; button.style.zIndex = String(Math.round((depth + 1) * 10));
          button.style.opacity = success ? "0" : String(expansion);
          button.style.pointerEvents = expansion > .75 && !collecting && !success ? "auto" : "none";
          const label = button.querySelector<HTMLElement>(".native-adapter-node-name")!;
          label.hidden = expansion < .85 || collecting || success || !names.has(module.feature);
          const position = labelPositions.get(module.feature);
          if (position) {
            label.style.left = `calc(50% + ${position.left + position.width / 2 - x}px)`;
            label.style.top = `calc(50% + ${position.top - y}px)`;
          }
        }
      }
      const coreColor = success ? colors[1] : colors[0];
      const pulse = reducedMotion.matches ? 0 : Math.sin(time * .0025) * 2;
      ctx.save(); ctx.globalAlpha = .08; ctx.fillStyle = coreColor; ctx.beginPath(); ctx.arc(width / 2, height / 2, 26 + pulse, 0, Math.PI * 2); ctx.fill(); ctx.restore();
      glow(width / 2, height / 2, success ? 10 : 7, coreColor);
      ctx.save(); ctx.strokeStyle = coreColor; ctx.globalAlpha = .52; ctx.lineWidth = .8; ctx.beginPath(); ctx.arc(width / 2, height / 2, 17, 0, Math.PI * 2); ctx.stroke();
      if (success && age < 750 && !reducedMotion.matches) { ctx.globalAlpha = (1 - age / 750) * .6; ctx.beginPath(); ctx.arc(width / 2, height / 2, 18 + age * .08, 0, Math.PI * 2); ctx.stroke(); }
      ctx.restore();
      if (!reducedMotion.matches) schedule();
    }
    function schedule() { if (!disposed && frame === undefined && !document.hidden) frame = requestAnimationFrame(draw); }
    function visibilityChanged() {
      if (document.hidden && frame !== undefined) { cancelAnimationFrame(frame); frame = undefined; }
      else schedule();
    }
    const resizeObserver = new ResizeObserver(resize);
    const themeObserver = new MutationObserver(() => { palette(); schedule(); });
    const theme = root.closest(".radix-themes");
    if (theme) themeObserver.observe(theme, { attributes: true, attributeFilter: ["class", "style"] });
    resizeObserver.observe(space);
    document.addEventListener("visibilitychange", visibilityChanged);
    reducedMotion.addEventListener("change", schedule);
    requestDraw.current = schedule;
    resize();
    return () => {
      disposed = true;
      if (frame !== undefined) cancelAnimationFrame(frame);
      resizeObserver.disconnect(); themeObserver.disconnect();
      document.removeEventListener("visibilitychange", visibilityChanged);
      reducedMotion.removeEventListener("change", schedule);
      requestDraw.current = null;
    };
  }, [visible]);

  function startDrag(event: PointerEvent<HTMLDivElement>) {
    if ((event.target as Element).closest("button")) return;
    rotation.current.pointer = { x: event.clientX, y: event.clientY };
    event.currentTarget.setPointerCapture(event.pointerId);
  }
  function drag(event: PointerEvent<HTMLDivElement>) {
    const pointer = rotation.current.pointer;
    if (!pointer) return;
    rotation.current.yaw += (event.clientX - pointer.x) * .006;
    rotation.current.pitch = Math.max(-.8, Math.min(.8, rotation.current.pitch + (event.clientY - pointer.y) * .004));
    rotation.current.pointer = { x: event.clientX, y: event.clientY };
    requestDraw.current?.();
  }

  if (!visible) return null;
  const selectedModule = modules.find(module => module.feature === (hovered ?? selected));
  const loading = modules.filter(module => module.phase === "loading" || module.phase === "applying");
  const completed = modules.filter(module => module.phase === "ready").length;
  const stage = presentation === "collecting" ? "正在汇合结果" : presentation === "success" ? "适配成功" : stageLabels[phase] ?? phase;
  const detail = selectedModule ? `${selectedModule.label} · ${phaseLabels[selectedModule.phase] ?? selectedModule.phase}${selectedModule.message ? ` · ${selectedModule.message}` : ""}` : loading.map(module => `${module.label} · ${module.message || phaseLabels[module.phase]}`).join("；");

  return <div ref={rootRef} id="nativeAdaptersComponent" className={`native-adapter-graph ${presentation}`}>
    <div className="native-adapter-graph-heading"><span>功能适配</span><span role="status" aria-live="polite">{stage}{presentation === "active" && phase === "adapting" && loading.length > 0 ? ` · ${loading.length} 项并行` : ""}</span></div>
    <div ref={spaceRef} className="native-adapter-space" aria-label="拖动旋转模块图谱，选择节点查看适配详情" onPointerDown={startDrag} onPointerMove={drag} onPointerUp={() => { rotation.current.pointer = null; }} onPointerCancel={() => { rotation.current.pointer = null; }} onLostPointerCapture={() => { rotation.current.pointer = null; }} onKeyDown={event => { if (event.key === "Escape") { setSelected(null); setHovered(null); } }}>
      <canvas ref={canvasRef} aria-hidden="true" />
      <div className="native-adapter-node-list" role="group" aria-label="原生功能适配状态">{modules.map(module => <button type="button" key={module.feature} disabled={presentation !== "active"} ref={element => { if (element) buttonRefs.current.set(module.feature, element); else buttonRefs.current.delete(module.feature); }} className="native-adapter-node" data-phase={module.phase} aria-label={`${module.label}：${phaseLabels[module.phase] ?? module.phase}`} aria-describedby="nativeAdapterSelection" aria-pressed={selected === module.feature} title={module.message || phaseLabels[module.phase]} onClick={() => setSelected(module.feature)} onFocus={() => setSelected(module.feature)} onMouseEnter={() => setHovered(module.feature)} onMouseLeave={() => setHovered(null)}>
        <span className="native-adapter-node-name" hidden={!visibleLabels.has(module.feature)}>{module.label}</span>
      </button>)}</div>
      <span className="native-adapter-core-label">{presentation === "success" ? "适配成功" : "适配核心"}</span>
    </div>
    <div className="native-adapter-graph-footer"><span>已启用 {completed} / {modules.length}</span><span>拖动旋转 · 选择节点查看详情</span></div>
    <div className="native-adapter-legend" aria-label="适配状态图例">{Object.entries(phaseLabels).filter(([phase]) => phase !== "applying").map(([phase, label]) => <span key={phase} data-phase={phase}><i aria-hidden="true" />{label}</span>)}</div>
    <div id="nativeAdapterSelection" className="native-adapter-selection" title={detail}>{detail || "各模块独立适配，完成后统一应用"}</div>
    <div className="native-adapter-progress-copy">{progress == null ? stage : `${stage} · 阶段进度 ${Math.round(progress)}%`}</div>
    <Progress value={progress ?? null} size="2" aria-label="Codex 当前阶段适配进度" />
    <p id="nativeAdaptersMessage" title={message}>{message.replace(" · ", "\n")}</p>
    <div className="native-adapter-palette" aria-hidden="true"><span /><span /><span /><span /><span /><span /></div>
  </div>;
}
