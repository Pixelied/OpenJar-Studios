import { useLayoutEffect, useMemo, useRef, useState, type MutableRefObject } from "react";
import {
  applySuggestionAtCursor,
  getSuggestions,
  type ConfigSuggestion,
} from "../lib/configSuggestions";

function measureTextWidth(text: string, font: string) {
  const canvas = document.createElement("canvas");
  const ctx = canvas.getContext("2d");
  if (!ctx) return text.length * 7;
  ctx.font = font;
  return ctx.measureText(text).width;
}

function caretPopoverPosition(textarea: HTMLTextAreaElement, cursorIndex: number) {
  const style = window.getComputedStyle(textarea);
  const font = style.font || `${style.fontSize} ${style.fontFamily}`;
  const lineHeightRaw = Number.parseFloat(style.lineHeight);
  const lineHeight = Number.isFinite(lineHeightRaw) ? lineHeightRaw : 20;
  const paddingLeft = Number.parseFloat(style.paddingLeft || "0") || 0;
  const paddingTop = Number.parseFloat(style.paddingTop || "0") || 0;

  const before = textarea.value.slice(0, cursorIndex);
  const lines = before.split("\n");
  const lineText = lines[lines.length - 1] ?? "";
  const left = paddingLeft + measureTextWidth(lineText, font) - textarea.scrollLeft + 12;
  const top = paddingTop + (lines.length - 1) * lineHeight - textarea.scrollTop + lineHeight + 6;

  return {
    left: Math.max(8, Math.min(left, textarea.clientWidth - 230)),
    top: Math.max(8, Math.min(top, textarea.clientHeight - 130)),
  };
}

export default function AdvancedEditor({
  value,
  filePath,
  siblingContents,
  jumpTo,
  onChange,
  readOnly,
}: {
  value: string;
  filePath: string;
  siblingContents?: Array<{ path: string; content: string }>;
  jumpTo?: { start: number; end: number; token: number } | null;
  onChange: (next: string) => void;
  readOnly?: boolean;
}) {
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const pendingCursorRef = useRef<number | null>(null);
  const [suggestionsOpen, setSuggestionsOpen] = useState(false);
  const [suggestions, setSuggestions] = useState<ConfigSuggestion[]>([]);
  const [activeSuggestionIndex, setActiveSuggestionIndex] = useState(0);
  const [cursorIndex, setCursorIndex] = useState(0);

  const popoverPos = useMemo(() => {
    const textarea = textareaRef.current;
    if (!textarea) return { left: 10, top: 10 };
    return caretPopoverPosition(textarea, cursorIndex);
  }, [cursorIndex, value, suggestionsOpen]);

  function refreshSuggestions(forceOpen = false) {
    if (readOnly) {
      setSuggestionsOpen(false);
      setSuggestions([]);
      return;
    }
    const textarea = textareaRef.current;
    const idx = textarea?.selectionStart ?? cursorIndex;
    setCursorIndex(idx);
    const next = getSuggestions({
      filePath,
      content: value,
      cursorIndex: idx,
      mode: "advanced",
      siblingContents,
      limit: 14,
    });
    setSuggestions(next);
    if (forceOpen) {
      setSuggestionsOpen(next.length > 0);
      setActiveSuggestionIndex(0);
      return;
    }
    setSuggestionsOpen((prev) => (prev ? next.length > 0 : false));
    setActiveSuggestionIndex((prev) => Math.max(0, Math.min(prev, Math.max(0, next.length - 1))));
  }

  function acceptSuggestion(index?: number) {
    const targetIndex = index ?? activeSuggestionIndex;
    const suggestion = suggestions[targetIndex];
    if (!suggestion) return;
    const applied = applySuggestionAtCursor({
      content: value,
      cursorIndex,
      value: suggestion.value,
    });
    pendingCursorRef.current = applied.cursor;
    onChange(applied.content);
    setSuggestionsOpen(false);
  }

  useLayoutEffect(() => {
    if (!jumpTo) return;
    const textarea = textareaRef.current;
    if (!textarea) return;
    const start = Math.max(0, Math.min(jumpTo.start, value.length));
    const end = Math.max(start, Math.min(jumpTo.end, value.length));
    textarea.focus();
    textarea.selectionStart = start;
    textarea.selectionEnd = end;
    setCursorIndex(end);
    const before = value.slice(0, start);
    const line = before.split("\n").length;
    const lineHeight = Number.parseFloat(window.getComputedStyle(textarea).lineHeight || "20") || 20;
    const targetTop = Math.max(0, (line - 3) * lineHeight);
    textarea.scrollTop = targetTop;
  }, [jumpTo?.token, value, jumpTo]);

  return (
    <div className="configAdvancedEditorWrap">
      <textarea
        ref={textareaRef}
        className="configAdvancedEditor"
        spellCheck={false}
        value={value}
        onChange={(event) => {
          onChange(event.target.value);
          const idx = event.target.selectionStart ?? 0;
          setCursorIndex(idx);
          if (suggestionsOpen) {
            queueMicrotask(() => refreshSuggestions(false));
          }
        }}
        onClick={(event) => {
          setCursorIndex(event.currentTarget.selectionStart ?? 0);
          if (suggestionsOpen) queueMicrotask(() => refreshSuggestions(false));
        }}
        onKeyUp={(event) => {
          if (event.key === "ArrowDown" || event.key === "ArrowUp" || event.key === "Escape") return;
          setCursorIndex(event.currentTarget.selectionStart ?? 0);
          if (suggestionsOpen) queueMicrotask(() => refreshSuggestions(false));
        }}
        onScroll={() => {
          if (suggestionsOpen) {
            const textarea = textareaRef.current;
            if (textarea) {
              setCursorIndex(textarea.selectionStart ?? cursorIndex);
            }
          }
        }}
        onKeyDown={(event) => {
          const metaSpace = (event.ctrlKey || event.metaKey) && event.key === " ";
          if (metaSpace) {
            event.preventDefault();
            refreshSuggestions(true);
            return;
          }
          if (!suggestionsOpen) return;
          if (event.key === "ArrowDown") {
            event.preventDefault();
            setActiveSuggestionIndex((prev) => Math.min(prev + 1, suggestions.length - 1));
            return;
          }
          if (event.key === "ArrowUp") {
            event.preventDefault();
            setActiveSuggestionIndex((prev) => Math.max(0, prev - 1));
            return;
          }
          if (event.key === "Enter" || event.key === "Tab") {
            event.preventDefault();
            acceptSuggestion();
            return;
          }
          if (event.key === "Escape") {
            event.preventDefault();
            setSuggestionsOpen(false);
          }
        }}
        onBlur={() => {
          window.setTimeout(() => setSuggestionsOpen(false), 90);
        }}
        readOnly={readOnly}
      />
      {suggestionsOpen && suggestions.length > 0 ? (
        <div
          className="configSuggestMenu"
          style={{ left: `${popoverPos.left}px`, top: `${popoverPos.top}px` }}
        >
          {suggestions.map((item, idx) => (
            <button
              key={`${item.value}:${idx}`}
              type="button"
              className={`configSuggestItem ${idx === activeSuggestionIndex ? "active" : ""}`}
              onMouseDown={(event) => {
                event.preventDefault();
                acceptSuggestion(idx);
              }}
            >
              <span className="configSuggestLabel">{item.label}</span>
              <span className="configSuggestMeta">{item.detail || item.kind}</span>
            </button>
          ))}
        </div>
      ) : null}
      {pendingCursorRef.current != null ? (
        <CursorSync
          textareaRef={textareaRef}
          cursor={pendingCursorRef.current}
          onDone={() => {
            pendingCursorRef.current = null;
          }}
        />
      ) : null}
    </div>
  );
}

function CursorSync({
  textareaRef,
  cursor,
  onDone,
}: {
  textareaRef: MutableRefObject<HTMLTextAreaElement | null>;
  cursor: number;
  onDone: () => void;
}) {
  useLayoutEffect(() => {
    const textarea = textareaRef.current;
    if (textarea) {
      textarea.focus();
      textarea.selectionStart = cursor;
      textarea.selectionEnd = cursor;
    }
    onDone();
  }, [cursor, onDone, textareaRef]);
  return null;
}
