import { useMemo } from "react";

type ServerEntry = {
  name: string;
  address: string;
  icon?: string;
  hidden?: boolean;
};

type ServersPayload = {
  servers: ServerEntry[];
};

function parsePayload(raw: string): ServersPayload {
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      return {
        servers: parsed.map((item) => ({
          name: String((item as any)?.name ?? ""),
          address: String((item as any)?.address ?? ""),
          icon: String((item as any)?.icon ?? ""),
          hidden: Boolean((item as any)?.hidden),
        })),
      };
    }
    const list = Array.isArray((parsed as any)?.servers) ? (parsed as any).servers : [];
    return {
      servers: list.map((item: any) => ({
        name: String(item?.name ?? ""),
        address: String(item?.address ?? ""),
        icon: String(item?.icon ?? ""),
        hidden: Boolean(item?.hidden),
      })),
    };
  } catch {
    return { servers: [] };
  }
}

function stringifyPayload(payload: ServersPayload): string {
  return JSON.stringify(payload, null, 2);
}

export default function ServersDatSimpleEditor({
  value,
  onChange,
  onSelectField,
  readOnly,
}: {
  value: string;
  onChange: (next: string) => void;
  onSelectField: (selection: { path: string; value: string; type: string } | null) => void;
  readOnly?: boolean;
}) {
  const payload = useMemo(() => parsePayload(value), [value]);

  return (
    <div className="configSimpleEditor">
      <div className="configSimpleToolbar">
        <span className="chip subtle">{payload.servers.length} server{payload.servers.length === 1 ? "" : "s"}</span>
        <button
          className="btn"
          type="button"
          disabled={readOnly}
          onClick={() => {
            const next: ServersPayload = {
              servers: [...payload.servers, { name: "New Server", address: "play.example.net", icon: "", hidden: false }],
            };
            onChange(stringifyPayload(next));
          }}
        >
          Add server
        </button>
      </div>
      {payload.servers.length === 0 ? (
        <div className="configSimpleEmpty">
          <div className="settingTitle">No servers saved</div>
          <div className="muted">Add a server entry to start building your list.</div>
        </div>
      ) : (
        <div className="configSimpleRows">
          {payload.servers.map((server, idx) => (
            <div key={`${idx}:${server.name}`} className="configSimpleRow">
              <div className="configSimpleRowHead">
                <button
                  type="button"
                  className="configFieldPathBtn"
                  onClick={() => onSelectField({ path: `servers[${idx}]`, value: JSON.stringify(server), type: "object" })}
                >
                  Server {idx + 1}
                </button>
                <button
                  className="btn danger"
                  type="button"
                  disabled={readOnly}
                  onClick={() => {
                    const next: ServersPayload = {
                      servers: payload.servers.filter((_, rowIdx) => rowIdx !== idx),
                    };
                    onChange(stringifyPayload(next));
                    onSelectField(null);
                  }}
                >
                  Remove
                </button>
              </div>
              <input
                className="input"
                value={server.name}
                placeholder="Server name"
                readOnly={readOnly}
                onChange={(event) => {
                  const next = { ...server, name: event.target.value };
                  const updated = [...payload.servers];
                  updated[idx] = next;
                  onChange(stringifyPayload({ servers: updated }));
                  onSelectField({ path: `servers[${idx}].name`, value: event.target.value, type: "string" });
                }}
              />
              <input
                className="input"
                value={server.address}
                placeholder="play.example.net"
                readOnly={readOnly}
                onChange={(event) => {
                  const next = { ...server, address: event.target.value };
                  const updated = [...payload.servers];
                  updated[idx] = next;
                  onChange(stringifyPayload({ servers: updated }));
                  onSelectField({ path: `servers[${idx}].address`, value: event.target.value, type: "string" });
                }}
              />
              <input
                className="input"
                value={server.icon ?? ""}
                placeholder="Icon URL or base64"
                readOnly={readOnly}
                onChange={(event) => {
                  const next = { ...server, icon: event.target.value };
                  const updated = [...payload.servers];
                  updated[idx] = next;
                  onChange(stringifyPayload({ servers: updated }));
                  onSelectField({ path: `servers[${idx}].icon`, value: event.target.value, type: "string" });
                }}
              />
              <label className="toggleRow">
                <input
                  type="checkbox"
                  checked={Boolean(server.hidden)}
                  disabled={readOnly}
                  onChange={(event) => {
                    const next = { ...server, hidden: event.target.checked };
                    const updated = [...payload.servers];
                    updated[idx] = next;
                    onChange(stringifyPayload({ servers: updated }));
                    onSelectField({
                      path: `servers[${idx}].hidden`,
                      value: event.target.checked ? "true" : "false",
                      type: "boolean",
                    });
                  }}
                />
                <span className="togglePill" />
                <span>Hide from server list</span>
              </label>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
