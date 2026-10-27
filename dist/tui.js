// src/tui.tsx
import "@opentui/solid";
import { createSignal, onCleanup, onMount, Show } from "solid-js";
import { Plugin } from "@opencode/plugin/tui";

// src/rpc.ts
import { Rpc } from "@opencode/plugin/rpc";
var EnsembleRpc = Rpc.define({
  id: "ensemble",
  methods: {
    summary: {
      input: {
        type: "object",
        properties: { team: { type: "string" } },
        required: ["team"],
        additionalProperties: false
      },
      output: {
        type: "object",
        properties: { text: { type: "string" } },
        required: ["text"],
        additionalProperties: false
      }
    },
    teamContext: {
      input: {
        type: "object",
        properties: { sessionID: { type: "string" } },
        required: ["sessionID"],
        additionalProperties: false
      },
      output: {
        type: "object",
        properties: {
          team: { type: ["string", "null"] },
          members: {
            type: "array",
            items: {
              type: "object",
              properties: { name: { type: "string" }, status: { type: "string" } },
              required: ["name", "status"],
              additionalProperties: false
            }
          },
          tasks: {
            type: "object",
            properties: {
              pending: { type: "number" },
              done: { type: "number" }
            },
            required: ["pending", "done"],
            additionalProperties: false
          }
        },
        required: ["team", "members", "tasks"],
        additionalProperties: false
      }
    }
  },
  events: {
    member: {
      schema: {
        type: "object",
        properties: {
          memberName: { type: "string" },
          teamId: { type: "string" },
          from: { type: "string" },
          to: { type: "string" }
        },
        required: ["memberName", "teamId", "from", "to"],
        additionalProperties: false
      }
    },
    notice: {
      schema: {
        type: "object",
        properties: {
          title: { type: "string" },
          message: { type: "string" },
          variant: { type: "string" }
        },
        required: ["message"],
        additionalProperties: false
      }
    },
    view: {
      schema: {
        type: "object",
        properties: {
          sessionID: { type: "string" },
          memberName: { type: "string" }
        },
        required: ["sessionID"],
        additionalProperties: false
      }
    }
  }
});

// src/tui.tsx
import { jsx, jsxs } from "@opentui/solid/jsx-runtime";
function TeamSidebar(props) {
  const [state, setState] = createSignal(null);
  const load = async () => {
    try {
      setState(await props.fetchContext());
    } catch {
    }
  };
  onMount(() => {
    void load();
    const off = props.onEvent(() => void load());
    onCleanup(off);
    const tick = setInterval(() => void load(), 1e4);
    onCleanup(() => clearInterval(tick));
  });
  return /* @__PURE__ */ jsx(Show, { when: state()?.team, fallback: /* @__PURE__ */ jsx("text", { children: "Ensemble: no active team" }), children: /* @__PURE__ */ jsxs("box", { flexDirection: "column", children: [
    /* @__PURE__ */ jsxs("text", { children: [
      "Ensemble: ",
      state()?.team
    ] }),
    (state()?.members ?? []).map((member) => /* @__PURE__ */ jsxs("text", { children: [
      member.status === "busy" ? "\u25CF" : member.status === "ready" ? "\u25CB" : "\u25A0",
      " ",
      member.name,
      " (",
      member.status,
      ")"
    ] })),
    /* @__PURE__ */ jsxs("text", { children: [
      "tasks: ",
      state()?.tasks.pending ?? 0,
      " open / ",
      state()?.tasks.done ?? 0,
      " done"
    ] })
  ] }) });
}
var tui_default = Plugin.define({
  id: "ensemble.tui",
  setup(context) {
    const rpc = context.client.rpc(EnsembleRpc);
    const offView = rpc.events.on("view", (event) => {
      const data = event.data;
      if (!data.sessionID) return;
      if (context.ui.tabs.enabled()) {
        void context.ui.tabs.focus(data.sessionID);
      } else {
        void context.ui.router.navigate({ type: "session", sessionID: data.sessionID });
      }
    });
    const onEvent = (cb) => rpc.events.on("member", cb);
    const offSidebar = context.ui.slot({
      append: "sidebar.content",
      render: (panel) => /* @__PURE__ */ jsx(
        TeamSidebar,
        {
          fetchContext: async () => {
            if (!panel.sessionID) return null;
            return await rpc.teamContext({ sessionID: panel.sessionID });
          },
          onEvent
        }
      )
    });
    return () => {
      offView();
      offSidebar();
    };
  }
});
export {
  tui_default as default
};
