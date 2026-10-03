/**
 * 表格时间线视图（官方表格视图插件）。
 *
 * 字段驱动（无硬编码模式）：
 * - 取第一个 `duration` 字段决定卡片宽度（60px/秒，最短 120px）与播放时长；无该字段 → 等宽卡片 + 固定 3s/行
 * - 取第一个 `image` 字段供缩略图/大图；无图镜头显示首个 text 字段摘要文字卡片
 * - 点击卡片 = 跳选该行（经 ctx.table.selectRow 与表格视图 selectedRowId 联动，停止播放）
 *
 * 预演：上方预览区（当前行大图/文字卡片）+ 控制条（播放/暂停/停止、当前时间/总时长）+
 * 时间轴（卡片流 + 刻度尺 + 播放头）。rAF 驱动播放头，纯前端零依赖；
 * 播放中当前卡片自动滚入视野；组件卸载（切视图/关窗）自动停止。
 *
 * 数据来源：ctx.table.snapshot() + `table:changed` 事件订阅当前表格快照（含行/字段/选中行/协作远端选中行用户色）；
 * 图片条目经 ctx.table.resolveImage 解析为 dataURL（失败走文字摘要兜底）。
 *
 * 入口自包含（无运行时 import；`import type` 为类型注解，转译时擦除）；JSX 经转译引用
 * React.createElement（宿主提供 React 全局）；样式只用 inline style + CSS 变量，颜色/字阶/
 * 动效/圆角一律取宿主主题 token（Tailwind 类不可依赖，伪类不可写，交互态经组件状态驱动）。
 */
import type { Context } from "@atelyx/cordis";

/** 表格字段（插件侧最小声明，与宿主 PluginTableSnapshot 契约同构）。 */
interface Field {
  id: string;
  type: string;
}
/** 单元格样式（可映射子集：粗斜下划删/文字色/背景/字号）。 */
interface CellStyle {
  b?: boolean;
  i?: boolean;
  u?: boolean;
  s?: boolean;
  color?: string;
  bg?: string;
  size?: number;
}
/** 表格行（插件侧最小声明；values 按字段 id 取值，styles 为单元格样式表）。 */
interface Row {
  id: string;
  values: Record<string, unknown>;
  styles?: Record<string, CellStyle>;
}
/** 表格快照（ctx.table.snapshot 返回；结构即契约）。 */
interface TableSnapshot {
  tableFile: string | null;
  fields: Field[];
  rows: Row[];
  selectedRowId: string | null;
  peerColorByRowId: Record<string, string>;
}

/** React 全局（宿主注入）最小声明。 */
interface ReactApi {
  useState<T>(init: T): [T, (value: T | ((prev: T) => T)) => void];
  useEffect(effect: () => void | (() => void), deps?: readonly unknown[]): void;
  useMemo<T>(fn: () => T, deps: readonly unknown[]): T;
  useRef<T>(init: T): { current: T };
  useCallback<T extends (...args: never[]) => unknown>(fn: T, deps: readonly unknown[]): T;
  memo<T>(fn: T): T;
  Fragment: unknown;
  createElement: (type: unknown, props?: Record<string, unknown> | null, ...children: unknown[]) => unknown;
}

/** Atelyx 宿主服务面（插件侧最小声明；宿主侧完整契约见宿主 ctx API 文档）。 */
interface AtelyxCtx extends Context {
  events: {
    on(type: "table:changed", cb: () => void): () => boolean;
  };
  table: {
    snapshot(): TableSnapshot;
    selectRow(rowId: string | null): void;
    resolveImage(entry: string): Promise<string>;
  };
  slots: {
    registerTableView(opts: { kind: string; label: string; component: unknown }): () => void;
  };
}

const React = (globalThis as { React?: ReactApi }).React as ReactApi;

/** 入口：注册表格视图 + 订阅表格变更；随插件启停经 fiber 生命周期撤销。 */
export default function apply(ctx: AtelyxCtx): void {
  const table = ctx.table;
  const h = React.createElement;
  // ctx.events.on 为 fiber 级注册（卸载随插件停用撤销）；返回退订函数供组件卸载时调用。
  const onTableChanged = (cb: () => void): (() => boolean) => ctx.events.on("table:changed", cb);

  // ===== 共享样式（inline style + CSS 变量；宿主 Tailwind 类对插件无效）=====
  // 全部颜色/字号/圆角/时长取宿主主题 token：浅深两套主题与应用级「字体大小」设置自动跟随。
  // 内联样式写不了伪类（:hover/:focus），交互态一律经组件状态驱动。

  type Style = Record<string, string | number>;

  /** 交互动效：统一取宿主 fast 档时长与曲线（悬停/聚焦反馈档）。 */
  const EASE = "var(--dur-fast) var(--ease)";

  /** 字阶与行高（成对取用；rem 档，随应用「字体大小」设置缩放）。 */
  const FS = { body: "var(--fs-body)", ui: "var(--fs-ui)", caption: "var(--fs-caption)", micro: "var(--fs-micro)" } as const;
  const LH = { body: "var(--lh-body)", ui: "var(--lh-ui)", caption: "var(--lh-caption)", micro: "var(--lh-micro)" } as const;

  /** 圆角刻度：xs 4 / sm 6 / md 10。 */
  const RADIUS = { xs: "var(--radius-xs)", sm: "var(--radius-sm)", md: "var(--radius-md)" } as const;

  /** 键盘焦点环（内联样式写不了 :focus-visible：事件 + matches 检测，鼠标点击不亮环）。 */
  function useFocusRing(): [boolean, { onFocus: (e: { currentTarget: Element }) => void; onBlur: () => void }] {
    const [on, setOn] = React.useState(false);
    return [on, { onFocus: (e) => setOn(e.currentTarget.matches(":focus-visible")), onBlur: () => setOn(false) }];
  }

  /** 图标按钮变体（对齐宿主 Button 基元）：底色/文字色 + hover 反馈。 */
  type IconVariant = "secondary" | "ghost" | "subtle";
  const ICON_VARIANT: Record<IconVariant, { background: string; color: string; hoverBackground: string; hoverColor: string }> = {
    secondary: { background: "var(--bg-tertiary)", color: "var(--text-primary)", hoverBackground: "var(--hover)", hoverColor: "var(--text-primary)" },
    ghost: { background: "transparent", color: "var(--text-secondary)", hoverBackground: "var(--hover)", hoverColor: "var(--text-primary)" },
    subtle: { background: "transparent", color: "var(--text-muted)", hoverBackground: "transparent", hoverColor: "var(--text-primary)" },
  };

  /** 方形图标按钮档（含内边距的整边长）：sm 24 工具条默认 / md 28 主行动；圆角随档走。 */
  const ICON_BUTTON_SIZE: Record<"sm" | "md", Style> = {
    sm: { width: 24, height: 24, borderRadius: RADIUS.sm },
    md: { width: 28, height: 28, borderRadius: RADIUS.sm },
  };

  /** 图标按钮（自带 hover/焦点态；`label` 必填作无障碍名，兼作悬停提示）。 */
  function IconButton(props: {
    variant?: IconVariant;
    size?: "sm" | "md";
    label: string;
    icon: unknown;
    style?: Style;
    onClick?: () => void;
  }) {
    const [hovered, setHovered] = React.useState(false);
    const [ring, ringProps] = useFocusRing();
    const v = ICON_VARIANT[props.variant || "ghost"];
    return h(
      "button",
      {
        type: "button",
        "aria-label": props.label,
        title: props.label,
        onClick: props.onClick,
        onMouseEnter: () => setHovered(true),
        onMouseLeave: () => setHovered(false),
        ...ringProps,
        style: {
          display: "inline-flex",
          alignItems: "center",
          justifyContent: "center",
          flexShrink: 0,
          border: "none",
          outline: "none",
          cursor: "pointer",
          ...ICON_BUTTON_SIZE[props.size || "sm"],
          background: hovered ? v.hoverBackground : v.background,
          color: hovered ? v.hoverColor : v.color,
          transition: "background " + EASE + ", color " + EASE + ", box-shadow " + EASE,
          boxShadow: ring ? "var(--focus-ring)" : "none",
          ...props.style,
        },
      },
      props.icon,
    );
  }

  /** 空态（对齐宿主 EmptyState 形态）：图标底座 + 标题 + 说明，说明承载「为什么空 / 下一步做什么」。 */
  function EmptyState(props: { icon?: unknown; title: string; description?: string }) {
    return h(
      "div",
      {
        style: {
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          textAlign: "center",
          gap: 8,
          padding: "40px 24px",
        },
      },
      [
        props.icon
          ? h(
              "div",
              {
                key: "icon",
                style: {
                  width: 40,
                  height: 40,
                  borderRadius: RADIUS.md,
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  flexShrink: 0,
                  background: "var(--bg-tertiary)",
                  color: "var(--text-muted)",
                },
              },
              props.icon,
            )
          : null,
        h("div", { key: "title", style: { fontSize: FS.body, lineHeight: LH.body, fontWeight: 500, color: "var(--text-primary)" } }, props.title),
        props.description
          ? h("div", { key: "desc", style: { fontSize: FS.ui, lineHeight: LH.ui, color: "var(--text-muted)", maxWidth: "42ch" } }, props.description)
          : null,
      ],
    );
  }

  // ===== 时间线视图参数 =====
  const PX_PER_SEC = 60; // 卡片宽度：每秒时长对应 px
  const MIN_CARD_WIDTH = 120; // 时长过短/缺失兜底
  const EQUAL_CARD_WIDTH = 160; // 无 duration 字段时的等宽卡片宽
  const CARD_GAP = 6; // 卡片间距
  const DEFAULT_DURATION = 3; // 无 duration 字段或值为空时每行播放秒数
  const EMPTY_ROWS: Row[] = []; // 无快照时的稳定空兜底（保持引用稳定，扰动下游 hook 依赖）
  const EMPTY_FIELDS: Field[] = [];

  // ===== 纯函数 =====

  /** 单行播放时长：duration 字段值（>0 才有效），缺省 3s。 */
  function rowDuration(row: Row, durationFieldId: string | undefined): number {
    if (!durationFieldId) return DEFAULT_DURATION;
    const v = row.values[durationFieldId];
    return typeof v === "number" && v > 0 ? v : DEFAULT_DURATION;
  }

  /** 卡片宽度：有时长字段 = max(时长×比例, 最短宽)；无 = 等宽。 */
  function cardWidthAt(duration: number, hasDurationField: boolean): number {
    return hasDurationField ? Math.max(duration * PX_PER_SEC, MIN_CARD_WIDTH) : EQUAL_CARD_WIDTH;
  }

  /** 行图片值（ImageCellValue.images；非图片值/缺省 → 空数组）。 */
  function imagesOf(row: Row, field: Field | undefined): string[] {
    const v = field ? row.values[field.id] : undefined;
    return v !== undefined && typeof v === "object" && v !== null ? (v as { images?: unknown }).images as string[] : [];
  }

  /** 单元格样式 → CSS（只映射可直接表达的子集：粗斜下划删/文字色/背景/字号；字体预设键为宿主内部映射，不复制）。 */
  function cellStyleCss(st: CellStyle | undefined): Record<string, string | number> | null {
    if (!st) return null;
    const out: Record<string, string | number> = {};
    if (st.b) out.fontWeight = 700;
    if (st.i) out.fontStyle = "italic";
    if (st.u) out.textDecoration = "underline";
    if (st.s) out.textDecoration = (out.textDecoration ? out.textDecoration + " " : "") + "line-through";
    if (st.color) out.color = st.color;
    if (st.bg) out.background = st.bg;
    if (st.size) out.fontSize = st.size + "px";
    return Object.keys(out).length > 0 ? out : null;
  }

  function formatTime(t: number): string {
    const m = Math.floor(t / 60);
    const s = Math.floor(t % 60);
    return m + ":" + (s < 10 ? "0" : "") + s;
  }

  // ===== 内联 SVG 图标（播放/暂停/停止 14±1px 常规档；空态线性图标置 40px 底座中央） =====

  function PlayIcon() {
    return h("svg", { width: 14, height: 14, viewBox: "0 0 24 24", fill: "currentColor", style: { marginLeft: 2 } }, h("path", { d: "M8 5v14l11-7z" }));
  }
  function PauseIcon() {
    return h("svg", { width: 14, height: 14, viewBox: "0 0 24 24", fill: "currentColor" }, h("path", { d: "M6 5h4v14H6zM14 5h4v14h-4z" }));
  }
  function StopIcon() {
    return h("svg", { width: 13, height: 13, viewBox: "0 0 24 24", fill: "currentColor" }, h("path", { d: "M6 6h12v12H6z" }));
  }
  function TableIcon() {
    return h("svg", { width: 20, height: 20, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 1.5, strokeLinecap: "round" }, [
      h("rect", { key: "frame", x: 3, y: 4, width: 18, height: 16, rx: 2 }),
      h("path", { key: "lines", d: "M3 9.5h18M9.5 9.5V20" }),
    ]);
  }
  function RowsIcon() {
    return h("svg", { width: 20, height: 20, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 1.5, strokeLinecap: "round" }, [
      h("path", { key: "lines", d: "M4 6h16M4 12h16M4 18h10" }),
    ]);
  }

  // ===== 图片解析 hook（等价于宿主内 useTableImageSrc） =====

  function useTableImageSrc(entry: string): { src: string | null; failed: boolean } {
    const [st, setSt] = React.useState({ src: null as string | null, failed: false });
    React.useEffect(() => {
      let alive = true;
      if (!entry) {
        setSt({ src: null, failed: false });
        return;
      }
      if (entry.startsWith("data:")) {
        setSt({ src: entry, failed: false }); // 遗留内嵌 dataURL：同步透传
        return;
      }
      setSt({ src: null, failed: false });
      table
        .resolveImage(entry)
        .then((url) => {
          if (alive) setSt({ src: url, failed: false });
        })
        .catch(() => {
          if (alive) setSt({ src: null, failed: true });
        });
      return () => {
        alive = false;
      };
    }, [entry]);
    return st;
  }

  // ===== 子组件（memo 隔离；播放中 playhead 不参与 props，仅换行时重渲染） =====

  function CardThumb(props: { entry: string; summary: string }) {
    const src = useTableImageSrc(props.entry).src;
    if (!src) {
      return h(
        "div",
        {
          style: {
            width: "100%",
            height: "100%",
            padding: "6px",
            fontSize: FS.micro,
            lineHeight: LH.micro,
            overflow: "hidden",
            whiteSpace: "pre-wrap",
            wordBreak: "break-word",
            color: "var(--text-muted)",
          },
        },
        props.summary || "…",
      );
    }
    return h("img", { src, alt: "", style: { width: "100%", height: "100%", objectFit: "cover" }, draggable: false });
  }

  /** 单张卡片（memo 隔离；hover 态自持，悬停/换当前卡只重渲染涉及的那几张）。 */
  const TimelineCard = React.memo(function TimelineCard(props: {
    row: Row;
    index: number;
    isSelected: boolean;
    isCurrent: boolean;
    width: number;
    duration: number;
    imageField: Field | undefined;
    textField: Field | undefined;
    peerColor: string | undefined;
    onJump: (index: number) => void;
  }) {
    const [hovered, setHovered] = React.useState(false);
    const images = imagesOf(props.row, props.imageField);
    const summary =
      props.textField && typeof props.row.values[props.textField.id] === "string" ? String(props.row.values[props.textField.id]) : "";
    const cellStyle = props.textField && props.row.styles ? cellStyleCss(props.row.styles[props.textField.id]) : null;
    return h(
      "div",
      {
        "data-row-id": props.row.id,
        "data-shot-id": props.index,
        onClick: () => props.onJump(props.index),
        onMouseEnter: () => setHovered(true),
        onMouseLeave: () => setHovered(false),
        title: "行 " + (props.index + 1) + " · " + props.duration + " 秒",
        style: {
          display: "flex",
          flexDirection: "column",
          borderRadius: RADIUS.xs,
          cursor: "pointer",
          overflow: "hidden",
          flexShrink: 0,
          width: props.width,
          border: "1px solid " + (props.isCurrent ? "var(--accent)" : props.peerColor || "var(--border)"),
          background: props.isSelected
            ? "color-mix(in srgb, var(--accent) 12%, transparent)"
            : hovered
              ? "var(--hover)"
              : "var(--bg-secondary)",
          outline: props.isCurrent ? "1px solid var(--accent)" : undefined,
          transition: "background " + EASE + ", border-color " + EASE,
        },
      },
      [
        h(
          "div",
          {
            key: "thumb",
            style: {
              height: 80,
              overflow: "hidden",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              background: "var(--bg-tertiary)",
            },
          },
          images.length > 0
            ? h(CardThumb, { entry: images[0], summary })
            : h(
                "div",
                {
                  style: {
                    width: "100%",
                    height: "100%",
                    padding: "6px",
                    fontSize: FS.micro,
                    lineHeight: LH.micro,
                    overflow: "hidden",
                    whiteSpace: "pre-wrap",
                    wordBreak: "break-word",
                    color: "var(--text-muted)",
                    ...cellStyle,
                  },
                },
                summary || "行 " + (props.index + 1),
              ),
        ),
        h(
          "div",
          {
            key: "meta",
            style: {
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              padding: "4px 6px",
              fontSize: FS.micro,
              lineHeight: LH.micro,
              color: "var(--text-muted)",
            },
          },
          [h("span", { key: "idx" }, props.index + 1), h("span", { key: "dur" }, props.duration + "s")],
        ),
      ],
    );
  });

  const TimelineCards = React.memo(function TimelineCards(props: {
    rows: Row[];
    selectedRowId: string | null;
    shotIndex: number;
    durations: number[];
    hasDurationField: boolean;
    imageField: Field | undefined;
    textField: Field | undefined;
    peerColorByRowId: Record<string, string>;
    onJump: (index: number) => void;
  }) {
    const cards: unknown[] = [];
    for (let i = 0; i < props.rows.length; i++) {
      cards.push(
        h(TimelineCard, {
          key: props.rows[i].id,
          row: props.rows[i],
          index: i,
          isSelected: props.rows[i].id === props.selectedRowId,
          isCurrent: i === props.shotIndex,
          width: cardWidthAt(props.durations[i], props.hasDurationField),
          duration: props.durations[i],
          imageField: props.imageField,
          textField: props.textField,
          peerColor: props.peerColorByRowId[props.rows[i].id],
          onJump: props.onJump,
        }),
      );
    }
    return h(React.Fragment, null, cards);
  });

  /** 刻度尺：memo 隔离——播放中 totalDuration 不变则跳过每帧重建。 */
  const TimelineRuler = React.memo(function TimelineRuler(props: { totalDuration: number }) {
    const marks: unknown[] = [];
    const count = Math.floor(props.totalDuration / 5) + 1;
    for (let k = 0; k < count; k++) {
      const t = k * 5;
      marks.push(
        h(
          "div",
          {
            key: t,
            style: {
              position: "absolute",
              top: 0,
              display: "flex",
              flexDirection: "column",
              alignItems: "flex-start",
              left: t * PX_PER_SEC,
            },
          },
          [
            h("div", { key: "tick", style: { width: 1, height: 12, background: "var(--text-muted)", opacity: 0.5 } }),
            h("span", { key: "label", style: { fontSize: FS.micro, lineHeight: LH.micro, marginTop: 2, color: "var(--text-muted)" } }, t + "s"),
          ],
        ),
      );
    }
    return h("div", { style: { position: "relative", height: 20 } }, marks);
  });

  /** 预览区（当前行大图/文字卡片）：memo 隔离——播放中仅换行（currentRow 引用变化）时重渲染。 */
  const TimelinePreview = React.memo(function TimelinePreview(props: {
    currentRow: Row;
    shotIndex: number;
    imageField: Field | undefined;
    textField: Field | undefined;
    cover: { src: string | null; failed: boolean };
    durationSec: number;
  }) {
    const images = imagesOf(props.currentRow, props.imageField);
    const textValue =
      props.textField && typeof props.currentRow.values[props.textField.id] === "string"
        ? String(props.currentRow.values[props.textField.id])
        : "";
    const cellStyle = props.textField && props.currentRow.styles ? cellStyleCss(props.currentRow.styles[props.textField.id]) : null;
    let content: unknown;
    if (images.length > 0 && !props.cover.failed) {
      content = props.cover.src
        ? h("img", {
            src: props.cover.src,
            alt: "行 " + (props.shotIndex + 1),
            style: { maxHeight: "55vh", maxWidth: "100%", objectFit: "contain", borderRadius: RADIUS.md, border: "1px solid var(--border)" },
            draggable: false,
          })
        : h(
            "div",
            {
              style: {
                width: 288,
                aspectRatio: "16 / 9",
                borderRadius: RADIUS.md,
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                fontSize: FS.caption,
                lineHeight: LH.caption,
                background: "var(--bg-secondary)",
                color: "var(--text-muted)",
                border: "1px dashed var(--border)",
              },
            },
            "图片加载中…",
          );
    } else if (textValue) {
      content = h(
        "div",
        {
          style: {
            maxWidth: 576,
            maxHeight: "55vh",
            overflow: "auto",
            padding: 16,
            borderRadius: RADIUS.md,
            whiteSpace: "pre-wrap",
            fontSize: FS.body,
            lineHeight: LH.body,
            background: "var(--bg-secondary)",
            color: "var(--text-primary)",
            border: "1px solid var(--border)",
            ...cellStyle,
          },
        },
        textValue,
      );
    } else {
      content = h(
        "div",
        {
          style: {
            padding: "12px 24px",
            borderRadius: RADIUS.md,
            fontSize: FS.caption,
            lineHeight: LH.caption,
            background: "var(--bg-secondary)",
            color: "var(--text-muted)",
            border: "1px dashed var(--border)",
          },
        },
        "行 " + (props.shotIndex + 1) + "（无图片与文本内容）",
      );
    }
    return h(
      "div",
      {
        style: {
          flex: 1,
          minHeight: 0,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          padding: 16,
          position: "relative",
        },
      },
      h(
        "div",
        { style: { display: "flex", flexDirection: "column", alignItems: "center", gap: 8, maxWidth: "100%" } },
        content,
        h("div", { style: { fontSize: FS.caption, lineHeight: LH.caption, color: "var(--text-muted)" } }, "行 " + (props.shotIndex + 1) + " · " + props.durationSec + " 秒"),
      ),
    );
  });

  /** 播放头进度线：left 每帧都变，memo 比较必然失效，直接普通函数组件。 */
  function PlayheadLine(props: { visible: boolean; left: number }) {
    if (!props.visible) return null;
    return h("div", {
      style: {
        position: "absolute",
        top: 0,
        bottom: 0,
        width: 2,
        pointerEvents: "none",
        zIndex: 10,
        left: 12 + props.left,
        background: "var(--accent)",
      },
    });
  }

  // ===== 主组件 =====

  function TimelineView() {
    const [snap, setSnap] = React.useState<TableSnapshot | null>(null);
    React.useEffect(() => {
      // 初次快照 + 变更订阅（退订 = 组件卸载 + 插件停用双路径）
      const push = () => setSnap(table.snapshot());
      push();
      return onTableChanged(push);
    }, []);

    // 空态兜底引用 apply 作用域的稳定常量（EMPTY_ROWS/EMPTY_FIELDS），避免下游 hook 依赖每次渲染变化。
    const rows = snap ? snap.rows : EMPTY_ROWS;
    const fields = snap ? snap.fields : EMPTY_FIELDS;
    const selectedRowId = snap ? snap.selectedRowId : null;
    const tableFile = snap ? snap.tableFile : null;
    const peerColorByRowId = snap ? snap.peerColorByRowId : {};

    const durationField = fields.find((f) => f.type === "duration");
    const imageField = fields.find((f) => f.type === "image");
    const textField = fields.find((f) => f.type === "text");

    const durations = React.useMemo(
      () => rows.map((r) => rowDuration(r, durationField ? durationField.id : undefined)),
      [rows, durationField],
    );
    const totalDuration = durations.reduce((a, b) => a + b, 0);
    const hasDurationField = !!durationField;
    const totalWidth =
      rows.reduce((acc, _r, i) => acc + cardWidthAt(durations[i], hasDurationField), 0) +
      Math.max(0, rows.length - 1) * CARD_GAP;

    // ===== 播放状态：播放头 = 时间轴绝对秒数 =====
    const [playing, setPlaying] = React.useState(false);
    const [playhead, setPlayhead] = React.useState(0);
    const playheadRef = React.useRef(0);
    const finished = rows.length > 0 && playhead >= totalDuration;

    const shotIndex = React.useMemo(() => {
      if (rows.length === 0) return -1;
      let acc = 0;
      for (let i = 0; i < durations.length; i++) {
        acc += durations[i];
        if (playhead < acc) return i;
      }
      return durations.length - 1;
    }, [rows.length, durations, playhead]);

    // 切表格复位播放（宿主按文件 key 重挂载已复位，此处兜底双保险）
    const prevFileRef = React.useRef(tableFile);
    React.useEffect(() => {
      if (prevFileRef.current !== tableFile) {
        prevFileRef.current = tableFile;
        setPlaying(false);
        playheadRef.current = 0;
        setPlayhead(0);
      }
    }, [tableFile]);

    // rAF 播放
    React.useEffect(() => {
      if (!playing) return;
      let raf = 0;
      let last = performance.now();
      const tick = (now: number) => {
        playheadRef.current += (now - last) / 1000;
        last = now;
        if (playheadRef.current >= totalDuration) {
          playheadRef.current = totalDuration;
          setPlayhead(totalDuration);
          setPlaying(false);
          return;
        }
        setPlayhead(playheadRef.current);
        raf = requestAnimationFrame(tick);
      };
      raf = requestAnimationFrame(tick);
      return () => cancelAnimationFrame(raf);
    }, [playing, totalDuration]);

    // 播放中当前卡片滚入视野
    const cardsRef = React.useRef<{ querySelector(sel: string): { scrollIntoView(opts: unknown): void } | null } | null>(null);
    React.useEffect(() => {
      if (!playing || shotIndex < 0) return;
      const el = cardsRef.current && cardsRef.current.querySelector('[data-shot-id="' + shotIndex + '"]');
      if (el) el.scrollIntoView({ behavior: "smooth", inline: "center", block: "nearest" });
    }, [playing, shotIndex]);

    /** 各卡片起点时间（前缀和一次计算，播放头定位 / 跳选共用）。 */
    const shotStarts = React.useMemo(() => {
      const starts: number[] = [];
      let acc = 0;
      for (let i = 0; i < durations.length; i++) {
        starts.push(acc);
        acc += durations[i];
      }
      return starts;
    }, [durations]);

    /** 播放头像素位置：累计前序卡片宽度 + 当前卡内比例。 */
    const playheadPx = React.useMemo(() => {
      if (rows.length === 0 || shotIndex < 0) return 0;
      let acc = 0;
      for (let i = 0; i < shotIndex; i++) acc += cardWidthAt(durations[i], hasDurationField) + CARD_GAP;
      const shotStart = shotStarts[shotIndex] || 0;
      const frac = durations[shotIndex] > 0 ? (playhead - shotStart) / durations[shotIndex] : 0;
      return acc + Math.min(1, Math.max(0, frac)) * cardWidthAt(durations[shotIndex], hasDurationField);
    }, [rows.length, shotIndex, durations, shotStarts, playhead, hasDurationField]);

    /** 跳选行：停止播放并定位到该行起点（与表格视图选中联动）。 */
    const jumpTo = React.useCallback((index: number) => {
      setPlaying(false);
      playheadRef.current = shotStarts[index] || 0;
      setPlayhead(playheadRef.current);
      table.selectRow(rows[index] ? rows[index].id : null);
    }, [shotStarts, rows]);

    // 预览区大图条目（当前播放行首个 image）→ dataURL；失败时 failed 供预览回落文字摘要
    const coverEntry =
      shotIndex >= 0 && imageField && rows[shotIndex] ? imagesOf(rows[shotIndex], imageField)[0] : undefined;
    const cover = useTableImageSrc(coverEntry || "");

    // ===== 空态 =====
    if (!tableFile) {
      return h(
        "div",
        { style: { height: "100%", width: "100%", display: "flex", alignItems: "center", justifyContent: "center", background: "var(--bg-primary)" } },
        h(EmptyState, {
          icon: h(TableIcon),
          title: "未打开表格",
          description: "打开一个表格文件后，这里会按行排布时间线并预演。",
        }),
      );
    }
    if (rows.length === 0) {
      return h(
        "div",
        { style: { height: "100%", width: "100%", display: "flex", alignItems: "center", justifyContent: "center", background: "var(--bg-primary)" } },
        h(EmptyState, {
          icon: h(RowsIcon),
          title: "暂无行数据",
          description: "请先在表格视图添加行。",
        }),
      );
    }

    const currentRow = rows[shotIndex];

    return h(
      "div",
      { style: { height: "100%", display: "flex", flexDirection: "column", background: "var(--bg-primary)" } },
      [
        h(TimelinePreview, {
          key: "preview",
          currentRow,
          shotIndex,
          imageField,
          textField,
          cover,
          durationSec: durations[shotIndex],
        }),
        // 控制条
        h(
          "div",
          {
            key: "controls",
            style: {
              flexShrink: 0,
              display: "flex",
              alignItems: "center",
              gap: 12,
              padding: "6px 12px",
              borderTop: "1px solid var(--border)",
              fontSize: FS.caption,
              lineHeight: LH.caption,
              color: "var(--text-secondary)",
            },
          },
          [
            // 主行动 = md(28) 档 + secondary 底，图标取强调色；停止为次要动作 = sm(24) ghost。
            h(IconButton, {
              key: "play",
              variant: "secondary",
              size: "md",
              label: playing ? "暂停" : finished ? "重播" : "播放",
              onClick: () => {
                if (finished) {
                  playheadRef.current = 0;
                  setPlayhead(0);
                  setPlaying(true);
                } else {
                  setPlaying((v) => !v);
                }
              },
              icon: playing ? h(PauseIcon) : h(PlayIcon),
              style: { color: "var(--accent)" },
            }),
            h(IconButton, {
              key: "stop",
              size: "sm",
              label: "停止（回到开头）",
              onClick: () => {
                setPlaying(false);
                playheadRef.current = 0;
                setPlayhead(0);
              },
              icon: h(StopIcon),
            }),
            h("span", { key: "time", style: { fontFamily: "var(--font-mono)" } }, formatTime(playhead) + " / " + formatTime(totalDuration)),
          ],
        ),
        // 时间轴：刻度尺 + 卡片流 + 播放头
        h(
          "div",
          { key: "timeline", style: { flexShrink: 0, borderTop: "1px solid var(--border)", overflowX: "auto" } },
          h(
            "div",
            { style: { position: "relative", width: totalWidth + 24, padding: "0 12px 10px" } },
            [
              durationField ? h(TimelineRuler, { key: "ruler", totalDuration }) : null,
              h(
                "div",
                { key: "cards", ref: cardsRef, style: { display: "flex", alignItems: "stretch", gap: CARD_GAP } },
                h(TimelineCards, {
                  rows,
                  selectedRowId,
                  shotIndex,
                  durations,
                  hasDurationField,
                  imageField,
                  textField,
                  peerColorByRowId,
                  onJump: jumpTo,
                }),
              ),
              h(PlayheadLine, { key: "playhead", left: playheadPx, visible: playing }),
            ],
          ),
        ),
      ],
    );
  }

  ctx.slots.registerTableView({ kind: "com.atelyx.table-timeline", label: "时间线", component: TimelineView });
}
