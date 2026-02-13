import { useEffect, useMemo, useRef, useState } from "react";

type InstanceOption = {
  id: string;
  name: string;
};

export default function InstancePickerDropdown({
  instances,
  value,
  onChange,
  placeholder,
}: {
  instances: InstanceOption[];
  value: string | null;
  onChange: (instanceId: string) => void;
  placeholder?: string;
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const onDoc = (event: MouseEvent) => {
      if (!open) return;
      const el = rootRef.current;
      const target = event.target as Node;
      if (el?.contains(target)) return;
      setOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onEsc = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      setOpen(false);
    };
    window.addEventListener("keydown", onEsc);
    return () => window.removeEventListener("keydown", onEsc);
  }, [open]);

  const selected = useMemo(
    () => instances.find((item) => item.id === value) ?? instances[0] ?? null,
    [instances, value]
  );

  const disabled = instances.length === 0;

  return (
    <div className={`dropdown ${open ? "open" : ""}`} ref={rootRef}>
      <button
        type="button"
        className="dropBtn value"
        onClick={() => !disabled && setOpen((prev) => !prev)}
        disabled={disabled}
      >
        <span>{selected ? selected.name : placeholder ?? "No instances"}</span>
        <span style={{ opacity: 0.7 }}>{disabled ? "" : "▾"}</span>
      </button>
      {open ? (
        <div className="dropPanel">
          {instances.map((item) => (
            <div
              key={item.id}
              className={`menuItem ${item.id === selected?.id ? "active" : ""}`}
              onClick={() => {
                onChange(item.id);
                setOpen(false);
              }}
            >
              <span>{item.name}</span>
              <span className="menuCheck">{item.id === selected?.id ? "✓" : ""}</span>
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}
