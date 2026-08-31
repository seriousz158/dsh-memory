window.__ModuleLoader__.load({
  id: "dsh-git-memory",
  factory: (require) => {
    var module = { exports: {} };
    let jsx = require("react/jsx-runtime");
    let react = require("react");
    const strict = (parse) => ({ mode: "strict", typeSymbol: "dsh-memory/types#Memory", schema: { parse } });
    const result = (value) => { if (!value || typeof value !== "object" || typeof value.ok !== "boolean") throw new Error("invalid memory result"); if (!value.ok && typeof value.error?.code !== "string") throw new Error("invalid memory error"); return value; };
    // The typed Remote client returns its transport receipt around the service result.
    // Consume both layers so UI state sees the stable memory service payload.
    const operationResult = (value) => {
      const transport = result(value);
      return transport.ok ? result(transport.value) : transport;
    };
    const enabledRequest = (value) => { if (!value || typeof value !== "object" || typeof value.enabled !== "boolean") throw new Error("invalid memory setting request"); return value; };
    const rollbackRequest = (value) => { if (!value || value.confirmation !== "ROLLBACK_MEMORY" || typeof value.runId !== "string" || value.runId.length === 0) throw new Error("invalid rollback request"); return value; };
    const remote = { package: "dsh-memory", descriptors: [
      { id: "dsh-memory#memory/getSettings", service: "memory", namespace: "memory", method: "getSettings", invocation: { kind: "direct" }, parameters: [], result: strict(result) },
      { id: "dsh-memory#memory/setEnabled", service: "memory", namespace: "memory", method: "setEnabled", invocation: { kind: "direct" }, parameters: [{ name: "request", wire: "request", source: "json", codec: strict(enabledRequest) }], result: strict(result) },
      { id: "dsh-memory#memory/status", service: "memory", namespace: "memory", method: "status", invocation: { kind: "direct" }, parameters: [], result: strict(result) },
      { id: "dsh-memory#memory/health", service: "memory", namespace: "memory", method: "health", invocation: { kind: "direct" }, parameters: [], result: strict(result) },
      { id: "dsh-memory#memory/clear", service: "memory", namespace: "memory", method: "clear", invocation: { kind: "direct" }, parameters: [{ name: "request", wire: "request", source: "json", codec: strict((value) => { if (!value || value.confirmation !== "DELETE_MEMORY") throw new Error("invalid clear request"); return value; }) }], result: strict(result) },
      { id: "dsh-memory#memory/runs", service: "memory", namespace: "memory", method: "runs", invocation: { kind: "direct" }, parameters: [{ name: "request", wire: "request", source: "json", codec: strict((value) => { if (value !== undefined && value !== null && typeof value !== "object") throw new Error("invalid runs request"); return value; }) }], result: strict(result) },
      { id: "dsh-memory#memory/rollback", service: "memory", namespace: "memory", method: "rollback", invocation: { kind: "direct" }, parameters: [{ name: "request", wire: "request", source: "json", codec: strict(rollbackRequest) }], result: strict(result) },
      { id: "dsh-memory#memory/previews", service: "memory", namespace: "memory", method: "previews", invocation: { kind: "direct" }, parameters: [], result: strict(result) },
      { id: "dsh-memory#memory/applyPreview", service: "memory", namespace: "memory", method: "applyPreview", invocation: { kind: "direct" }, parameters: [{ name: "request", wire: "request", source: "json", codec: strict((value) => { if (!value || typeof value.previewId !== "string" || value.previewId.length === 0) throw new Error("invalid apply-preview request"); return value; }) }], result: strict(result) },
      { id: "dsh-memory#memory/discardPreview", service: "memory", namespace: "memory", method: "discardPreview", invocation: { kind: "direct" }, parameters: [{ name: "request", wire: "request", source: "json", codec: strict((value) => { if (!value || typeof value.previewId !== "string" || value.previewId.length === 0) throw new Error("invalid discard-preview request"); return value; }) }], result: strict(result) },
      { id: "dsh-memory#memory/search", service: "memory", namespace: "memory", method: "search", invocation: { kind: "direct" }, parameters: [{ name: "request", wire: "request", source: "json", codec: strict((value) => { if (!value || typeof value.query !== "string" || value.query.length === 0) throw new Error("invalid search request"); return value; }) }], result: strict(result) },
    ] };
    // Accordion row design: the memory block follows the native settings list
    // language (hairline-divided rows, no cards, no tinted panels). Collapsible
    // rows carry a one-line summary and expand inline; every confirmation is
    // inline (no native browser dialogs) so the block stays in the modal idiom.
    const css = `
.dshmu_memory{display:flex;flex-direction:column;padding:2px 0;color:var(--dsw-alias-label-primary,#1f2937)}
.dshmu_groupLabel{font:var(--dsw-font-xs-13,12px sans-serif);color:var(--dsw-alias-label-caption,#6b7280);margin:6px 0 0;letter-spacing:.02em}
.dshmu_row{border-bottom:1px solid var(--dsw-alias-border-l2,#eceef2);padding:6px 0}
.dshmu_row:last-child{border-bottom:none}
.dshmu_head{display:flex;align-items:center;justify-content:space-between;gap:20px;width:100%;box-sizing:border-box;background:none;border:0;font:inherit;color:inherit;text-align:left;padding:7px 8px;margin:0 -8px;border-radius:8px;cursor:pointer}
.dshmu_head:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(127,145,180,.12))}
.dshmu_head--static{cursor:default}
.dshmu_head--static:hover{background:none}
.dshmu_head:focus-visible,.dshmu_textBtn:focus-visible,.dshmu_button:focus-visible,.dshmu_input:focus-visible,.dshmu_switch:focus-visible{outline:2px solid var(--dsw-static-deepseek-500,#4d6bfe);outline-offset:2px}
.dshmu_headMain{min-width:0;flex:1}
.dshmu_side{flex:none;display:flex;align-items:center;gap:8px}
.dshmu_title{font:var(--dsw-font-s-strong-14,14px sans-serif);font-weight:650;letter-spacing:-.01em}
.dshmu_title--danger{color:var(--dsw-alias-state-danger,#b42318)}
.dshmu_desc{display:block;font:var(--dsw-font-xs-13,12px sans-serif);line-height:1.5;color:var(--dsw-alias-label-caption,#6b7280);margin-top:3px;max-width:62ch;overflow-wrap:anywhere}
.dshmu_summary{font:var(--dsw-font-xs-13,12px sans-serif);color:var(--dsw-alias-label-caption,#6b7280);font-variant-numeric:tabular-nums;white-space:nowrap}
.dshmu_chev{flex:none;color:var(--dsw-alias-label-caption,#6b7280);transition:transform .16s ease}
.dshmu_head[aria-expanded="true"] .dshmu_chev{transform:rotate(90deg)}
.dshmu_body{padding:2px 0 10px}
.dshmu_statusLine{display:flex;align-items:center;gap:7px;font:var(--dsw-font-xs-13,12px sans-serif);line-height:1.5;color:var(--dsw-alias-label-caption,#6b7280);font-variant-numeric:tabular-nums;overflow-wrap:anywhere}
.dshmu_statusLine--error{color:var(--dsw-alias-state-danger,#b42318)}
.dshmu_metaLine{font:var(--dsw-font-xs-13,12px sans-serif);line-height:1.5;color:var(--dsw-alias-label-caption,#6b7280);padding-left:15px;margin-top:2px;overflow-wrap:anywhere;font-variant-numeric:tabular-nums}
.dshmu_dot{display:inline-block;width:8px;height:8px;border-radius:50%;flex:none}
.dshmu_dot--success{background:var(--dsw-alias-state-success,#217a4b)}
.dshmu_dot--danger{background:var(--dsw-alias-state-danger,#b42318)}
.dshmu_dot--warning{background:var(--dsw-alias-state-warning,#996c00)}
.dshmu_dot--neutral{background:var(--dsw-alias-fill-tertiary,#c3c9d4)}
.dshmu_mono{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:11.5px;color:var(--dsw-alias-label-primary,#1f2937)}
.dshmu_bodyActions{display:flex;flex-wrap:wrap;align-items:center;gap:8px;margin-top:9px;padding-left:15px}
.dshmu_textBtn{display:inline-flex;align-items:center;font:var(--dsw-font-xs-13,12px sans-serif);font-weight:600;color:var(--dsw-alias-label-primary,#334155);background:none;border:0;border-radius:6px;padding:4px 6px;cursor:pointer;transition:background-color .16s ease,color .16s ease}
.dshmu_textBtn:hover:not(:disabled){background:var(--dsw-alias-fill-secondary,rgba(127,145,180,.12))}
.dshmu_textBtn--accent{color:var(--dsw-static-deepseek-500,#4d6bfe)}
.dshmu_textBtn--danger{color:var(--dsw-alias-state-danger,#b42318)}
.dshmu_textBtn:disabled,.dshmu_button:disabled{opacity:.5;cursor:default}
.dshmu_button{display:inline-flex;align-items:center;justify-content:center;min-height:30px;border:1px solid var(--dsw-alias-border-l2,#d8dee8);border-radius:7px;padding:5px 10px;font:var(--dsw-font-xs-13,12px sans-serif);font-weight:600;color:var(--dsw-alias-label-primary,#334155);background:var(--dsw-alias-fill-primary,transparent);cursor:pointer;transition:background-color .16s ease,border-color .16s ease}
.dshmu_button:hover:not(:disabled){background:var(--dsw-alias-fill-secondary,rgba(127,145,180,.12))}
.dshmu_button--danger-solid{color:#fff;border-color:var(--dsw-alias-state-danger,#c53b37);background:var(--dsw-alias-state-danger,#c53b37)}
.dshmu_button--danger-solid:hover:not(:disabled){background:var(--dsw-alias-state-danger-strong,#a52f2b)}
.dshmu_confirmCluster{display:inline-flex;flex-wrap:wrap;align-items:center;gap:4px 8px}
.dshmu_confirmText{font:var(--dsw-font-xs-13,12px sans-serif);font-weight:600;color:var(--dsw-alias-state-danger,#b42318)}
.dshmu_previewLine{display:flex;flex-wrap:wrap;align-items:center;gap:6px 10px;padding:7px 0 7px 15px;border-top:1px dashed var(--dsw-alias-border-l2,#eceef2)}
.dshmu_previewLine:first-of-type{border-top:none;padding-top:4px}
.dshmu_previewPaths{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font:var(--dsw-font-xs-13,12px sans-serif);color:var(--dsw-alias-label-caption,#6b7280)}
.dshmu_previewActions{display:flex;flex:none;gap:2px;margin-left:auto}
.dshmu_input{display:block;width:100%;max-width:340px;box-sizing:border-box;padding:8px 10px;border:1px solid var(--dsw-alias-border-l2,#d8dee8);border-radius:7px;font:var(--dsw-font-xs-13,12px sans-serif);color:var(--dsw-alias-label-primary,#1f2937);background:var(--dsw-alias-fill-primary,transparent)}
.dshmu_note{display:block;font:var(--dsw-font-xs-13,12px sans-serif);line-height:1.5;margin-top:8px;overflow-wrap:anywhere}
.dshmu_note--error{color:var(--dsw-alias-state-danger,#b42318)}
.dshmu_note--success{color:var(--dsw-alias-state-success,#217a4b)}
.dshmu_srOnly{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap;border:0}
.dshmu_switch{position:relative;flex:0 0 auto;width:40px;height:24px;margin-top:1px;border:0;border-radius:999px;cursor:pointer;background:var(--dsw-alias-fill-tertiary,#d9dee8);box-shadow:inset 0 0 0 1px rgba(31,41,55,.08);transition:background-color .16s ease,box-shadow .16s ease}
.dshmu_switch[aria-checked=true]{background:var(--dsw-static-deepseek-500,#4d6bfe);box-shadow:none}
.dshmu_switch:disabled{opacity:.5;cursor:default}
.dshmu_knob{position:absolute;top:3px;left:3px;width:18px;height:18px;border-radius:50%;background:#fff;box-shadow:0 1px 3px rgba(15,23,42,.18);transition:left .16s ease}
.dshmu_switch[aria-checked=true] .dshmu_knob{left:19px}
@media (max-width:480px){.dshmu_head{gap:12px}.dshmu_summary{max-width:38vw;overflow:hidden;text-overflow:ellipsis}.dshmu_previewLine,.dshmu_bodyActions,.dshmu_metaLine{padding-left:0}}
@media (prefers-reduced-motion:reduce){.dshmu_chev,.dshmu_switch,.dshmu_knob,.dshmu_textBtn,.dshmu_button{transition:none}}
`;
    const tagId = "dsh-memory-ui/style.css";
    if (typeof document !== "undefined" && document.querySelector("style[data-plugin-css=" + JSON.stringify(tagId) + "]") === null) { const tag = document.createElement("style"); tag.dataset.plugin = "dsh-memory-ui"; tag.dataset.pluginCss = tagId; tag.textContent = css; document.head.appendChild(tag); }
    // Last-run status vocabulary returned by the memory service journal.
    const RUN_STATUS = {
      applied: { label: "已应用", tone: "success" },
      no_change: { label: "无变更", tone: "neutral" },
      failed: { label: "同步失败", tone: "danger" },
      interrupted: { label: "已中断", tone: "danger" },
      rolled_back: { label: "已回滚", tone: "warning" },
      running: { label: "进行中", tone: "warning" },
      pending: { label: "待应用", tone: "warning" },
    };
    const runStatusMeta = (status) => RUN_STATUS[status] ?? { label: String(status ?? "未知"), tone: "neutral" };
    const chevron = () => jsx.jsx("svg", { className: "dshmu_chev", width: 12, height: 12, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 2.2, strokeLinecap: "round", strokeLinejoin: "round", "aria-hidden": "true", children: jsx.jsx("path", { d: "M9 6l6 6-6 6" }) });
    // Inline two-step confirm: click arms the cluster, Escape / 取消 / 3s timer
    // disarm it. The cluster lives inside an aria-live region owned by the
    // caller so screen readers announce both the prompt and the countdown note.
    function ConfirmButton({ variant, tone, label, busyLabel, confirmText, confirmLabel, ariaLabel, busy, disabled, onConfirm, onComplete }) {
      const [confirming, setConfirming] = react.useState(false);
      const triggerRef = react.useRef(null);
      const confirmRef = react.useRef(null);
      react.useEffect(() => {
        if (!confirming) return undefined;
        // Arming swaps the trigger for the cluster; move focus into it so
        // keyboard users (and Escape) keep operating inside the row instead of
        // falling back to the page body, where Escape would close the modal.
        confirmRef.current?.focus();
        const timer = setTimeout(() => {
          setConfirming(false);
          requestAnimationFrame(() => triggerRef.current?.focus());
        }, 3000);
        return () => clearTimeout(timer);
      }, [confirming]);
      const disarm = (refocus) => {
        setConfirming(false);
        if (refocus) requestAnimationFrame(() => triggerRef.current?.focus());
      };
      const execute = async () => {
        setConfirming(false);
        try { await onConfirm(); }
        finally { onComplete?.(); }
      };
      if (confirming && !busy) {
        return jsx.jsxs("span", { className: "dshmu_confirmCluster", role: "group", "aria-label": confirmText, onKeyDown: (event) => { if (event.key === "Escape") { event.stopPropagation(); disarm(true); } }, children: [
          jsx.jsx("span", { className: "dshmu_confirmText", children: confirmText }),
          jsx.jsx("span", { className: "dshmu_srOnly", children: "3 秒后自动取消" }),
          jsx.jsx("button", { type: "button", ref: confirmRef, className: "dshmu_textBtn dshmu_textBtn--danger", onClick: () => { void execute(); }, children: confirmLabel }),
          jsx.jsx("button", { type: "button", className: "dshmu_textBtn", onClick: () => disarm(true), children: "取消" }),
        ] });
      }
      const className = variant === "plain" ? "dshmu_button" : tone === "accent" ? "dshmu_textBtn dshmu_textBtn--accent" : tone === "danger" ? "dshmu_textBtn dshmu_textBtn--danger" : "dshmu_textBtn";
      return jsx.jsx("button", { type: "button", ref: triggerRef, className, "aria-label": ariaLabel, disabled: disabled || busy, onClick: () => setConfirming(true), children: busy ? busyLabel : label });
    }
    const entry = {
      name: "dsh-memory-ui",
      inject: ["slots", "remote"],
      async apply(ctx) {
        const disposeRemote = await ctx.remote.$mount(remote);
        ctx.effect(() => disposeRemote, "dsh-memory-ui: remote cleanup");
        ctx.inject(["remote.memory"], (memoryCtx) => {
          const memory = memoryCtx.remote.memory;
          const listeners = new Set();
          let snapshot = Object.freeze({ status: "loading", writable: false });
          const publish = (next) => {
            snapshot = Object.freeze(next);
            for (const listener of [...listeners]) listener();
          };
          const scope = {
            subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
            getSnapshot() { return snapshot; },
            dispose() { listeners.clear(); },
            set(name, value) {
              if (name !== "enabled" || typeof value !== "boolean") return;
              publish({ status: "saving", writable: false, value: snapshot.value });
              void (async () => {
                try {
                  const answer = operationResult(await memory.setEnabled({ enabled: value }));
                  publish(answer.ok ? { status: "ready", writable: true, value: answer.value } : { status: "error", writable: false, error: answer.error.code });
                } catch {
                  publish({ status: "error", writable: false, error: "settings-write-failed" });
                }
              })();
            },
          };
          void (async () => {
            try {
              const answer = operationResult(await memory.getSettings());
              publish(answer.ok ? { status: "ready", writable: true, value: answer.value } : { status: "error", writable: false, error: answer.error.code });
            } catch {
              publish({ status: "error", writable: false, error: "settings-unavailable" });
            }
          })();
          const subscribe = scope.subscribe.bind(scope);
          const getSnapshot = scope.getSnapshot.bind(scope);
          memoryCtx.effect(() => () => { scope.dispose(); }, "dsh-memory-ui: cleanup");
          function MemoryRow() {
            const snapshot = react.useSyncExternalStore(subscribe, getSnapshot);
            const enabled = typeof snapshot.value?.enabled === "boolean" ? snapshot.value.enabled : false;
            const available = snapshot.status === "ready" && snapshot.writable === true;
            const saving = snapshot.status === "saving";
            const [openRow, setOpenRow] = react.useState(null);
            const [phrase, setPhrase] = react.useState("");
            const [state, setState] = react.useState(null);
            const [busy, setBusy] = react.useState(false);
            const [repository, setRepository] = react.useState(null);
            const [repositoryRevision, setRepositoryRevision] = react.useState(0);
            const [rollbackState, setRollbackState] = react.useState(null);
            const [rollbackBusy, setRollbackBusy] = react.useState(false);
            const baseId = react.useId().replace(/[^a-zA-Z0-9_-]/g, "");
            react.useEffect(() => {
              let disposed = false;
              const load = async () => {
                try {
                  const answer = operationResult(await memory.status());
                  if (!disposed) setRepository(answer.ok ? { value: answer.value } : { error: answer.error.code });
                } catch {
                  if (!disposed) setRepository({ error: "repo-unavailable" });
                }
              };
              void load();
              return () => { disposed = true; };
            }, [repositoryRevision]);
            const toggleRow = (id) => setOpenRow((current) => (current === id ? null : id));
            const focusRow = (...ids) => {
              let attempts = 0;
              const focus = () => {
                for (const id of ids) {
                  const target = document.getElementById(`${baseId}-${id}-head`);
                  if (target && !target.hidden && !target.closest("[hidden]") && (id === ids[0] || attempts >= 30)) { target.focus(); return; }
                }
                if (attempts++ < 30) requestAnimationFrame(focus);
              };
              requestAnimationFrame(focus);
            };
            const rowKeyDown = (id) => (event) => {
              if (event.key !== "Escape") return;
              event.stopPropagation();
              if (id === "delete") { setPhrase(""); setState(null); }
              setOpenRow(null);
              // Collapsing hides the body; if focus was inside it, return it to
              // the row header so keyboard users are not dropped to the page body.
              if (event.target instanceof HTMLElement && event.target.closest(`#${baseId}-${id}-body`) !== null) {
                requestAnimationFrame(() => document.getElementById(`${baseId}-${id}-head`)?.focus());
              }
            };
            const rollback = async () => {
              const runId = repository?.value?.lastRun?.runId;
              if (!runId) return;
              setRollbackBusy(true); setRollbackState(null);
              try {
                const answer = operationResult(await memory.rollback({ runId, confirmation: "ROLLBACK_MEMORY" }));
                if (!answer.ok) return setRollbackState({ error: answer.error.code });
                setRollbackState({ success: "已回滚本次同步" });
                setRepositoryRevision((revision) => revision + 1);
              } catch {
                setRollbackState({ error: "rollback-failed" });
              } finally {
                setRollbackBusy(false);
              }
            };
            const [previewList, setPreviewList] = react.useState(null);
            const [previewBusy, setPreviewBusy] = react.useState(false);
            const [previewAction, setPreviewAction] = react.useState(null);
            react.useEffect(() => {
              let disposed = false;
              const load = async () => {
                try {
                  const answer = operationResult(await memory.previews());
                  if (!disposed) setPreviewList(answer.ok ? answer.value.previews : null);
                } catch {
                  if (!disposed) setPreviewList(null);
                }
              };
              void load();
              return () => { disposed = true; };
            }, [repositoryRevision]);
            const applyPreview = async (previewId) => {
              setPreviewBusy(true); setPreviewAction(null);
              try {
                const answer = operationResult(await memory.applyPreview({ previewId }));
                if (!answer.ok) return setPreviewAction({ error: answer.error.code });
                setPreviewAction({ success: `已应用预览 ${previewId}` });
                setRepositoryRevision((revision) => revision + 1);
              } catch {
                setPreviewAction({ error: "preview-apply-failed" });
              } finally {
                setPreviewBusy(false);
              }
            };
            const discardPreview = async (previewId) => {
              setPreviewBusy(true); setPreviewAction(null);
              try {
                const answer = operationResult(await memory.discardPreview({ previewId }));
                if (!answer.ok) return setPreviewAction({ error: answer.error.code });
                setPreviewAction({ success: `已丢弃预览 ${previewId}` });
                setRepositoryRevision((revision) => revision + 1);
              } catch {
                setPreviewAction({ error: "preview-discard-failed" });
              } finally {
                setPreviewBusy(false);
              }
            };
            const clear = async () => {
              if (phrase !== "删除记忆") return;
              setBusy(true); setState(null);
              try {
                const answer = operationResult(await memory.clear({ confirmation: "DELETE_MEMORY" }));
                if (!answer.ok) return setState({ error: answer.error.code });
                setPhrase(""); setRepositoryRevision((revision) => revision + 1);
                const checkpoints = [answer.value.recoveryCommit && "恢复提交", answer.value.clearCommit && "清空提交"].filter(Boolean).join("和");
                setState({ success: answer.value.alreadyEmpty ? "记忆已为空" : `已清空 ${answer.value.clearedFileCount} 个记忆文件${checkpoints ? `，已创建${checkpoints}` : ""}；长期记忆仍保持开启` });
              } catch {
                setState({ error: "clear-failed" });
              } finally {
                setBusy(false);
              }
            };
            const unavailable = snapshot.status === "error" ? `长期记忆服务未就绪，暂不能修改（${snapshot.error ?? "settings-unavailable"}）` : snapshot.status === "loading" ? "正在读取长期记忆设置…" : "长期记忆设置不可写";
            // Metadata anomalies are a data-quality warning surfaced separately
            // from the repository health line; they never merge into recovery
            // states on the host side either.
            const metadataAnomaly = repository?.value && repository.value.metadataValid === false
              ? {
                  count: repository.value.invalidMetadataCount ?? 0,
                  paths: (repository.value.invalidMetadata ?? []).slice(0, 5).map((entry) => entry.path),
                }
              : null;
            const repositoryStatus = repository?.error
              ? { tone: "danger", text: `记忆库不可用：${repository.error}`, error: true }
              : repository?.value
                ? {
                    tone: repository.value.targetDirty ? "warning" : repository.value.empty ? "neutral" : "success",
                    text: `${repository.value.empty ? "为空" : `${repository.value.dataFileCount} 个数据文件`} · ${repository.value.targetDirty ? "目标路径有未提交内容，将先创建恢复提交" : repository.value.recoverable ? "可从 Git 历史恢复" : "不可恢复"}`,
                  }
                : null;
            const lastRun = repository?.value?.lastRun ?? null;
            const lastRunMeta = lastRun ? runStatusMeta(lastRun.status) : null;
            const renderRowHead = (id, title, options = {}) => {
              const open = openRow === id;
              return jsx.jsxs("button", { type: "button", className: "dshmu_head", id: `${baseId}-${id}-head`, "aria-expanded": open, "aria-controls": `${baseId}-${id}-body`, onClick: () => toggleRow(id), children: [
                jsx.jsx("div", { className: "dshmu_headMain", children: jsx.jsx("div", { className: options.danger ? "dshmu_title dshmu_title--danger" : "dshmu_title", children: title }) }),
                jsx.jsxs("div", { className: "dshmu_side", children: [
                  options.summary ? jsx.jsx("span", { className: "dshmu_summary", children: options.summary }) : null,
                  chevron(),
                ] }),
              ] });
            };
            const renderRowBody = (id, children) => jsx.jsx("div", { className: "dshmu_body", id: `${baseId}-${id}-body`, role: "region", "aria-labelledby": `${baseId}-${id}-head`, hidden: openRow !== id, children });
            return jsx.jsxs("div", { className: "dshmu_memory", children: [
              jsx.jsx("div", { className: "dshmu_groupLabel", children: "记忆" }),
              jsx.jsx("section", { className: "dshmu_row", "aria-label": "长期记忆", children: jsx.jsxs("div", { className: "dshmu_head dshmu_head--static", children: [
                jsx.jsxs("div", { className: "dshmu_headMain", children: [
                  jsx.jsx("div", { className: "dshmu_title", children: "长期记忆" }),
                  jsx.jsx("span", { className: "dshmu_desc", children: available ? "开启后自动回忆历史经验，并在任务收尾时自动提炼整合（本地 Git 记忆库）" : unavailable }),
                ] }),
                jsx.jsxs("div", { className: "dshmu_side", children: [
                  saving && jsx.jsx("span", { className: "dshmu_summary", children: "保存中…" }),
                  jsx.jsx("button", { type: "button", role: "switch", "aria-label": "长期记忆", "aria-checked": enabled, className: "dshmu_switch", disabled: !available, onClick: () => scope.set("enabled", !enabled), children: jsx.jsx("span", { className: "dshmu_knob" }) }),
                ] }),
              ] }) }),
              jsx.jsx("section", { className: "dshmu_row", "aria-label": "记忆库", children: jsx.jsx("div", { className: "dshmu_head dshmu_head--static", children: jsx.jsxs("div", { className: "dshmu_headMain", children: [
                jsx.jsx("div", { className: "dshmu_title", children: "记忆库" }),
                repositoryStatus === null
                  ? jsx.jsx("span", { className: "dshmu_desc", children: "正在读取记忆库状态…" })
                  : jsx.jsxs("div", { className: repositoryStatus.error ? "dshmu_statusLine dshmu_statusLine--error" : "dshmu_statusLine", children: [
                      jsx.jsx("span", { className: `dshmu_dot dshmu_dot--${repositoryStatus.tone}`, "aria-hidden": "true" }),
                      jsx.jsx("span", { children: repositoryStatus.text }),
                    ] }),
              ] }) }) }),
              metadataAnomaly !== null && jsx.jsx("section", { className: "dshmu_row", "aria-label": "记忆数据格式异常", children: jsx.jsx("div", { className: "dshmu_head dshmu_head--static", children: jsx.jsxs("div", { className: "dshmu_headMain", children: [
                jsx.jsx("div", { className: "dshmu_title", children: "记忆数据格式异常" }),
                jsx.jsxs("div", { className: "dshmu_statusLine dshmu_statusLine--error", children: [
                  jsx.jsx("span", { className: "dshmu_dot dshmu_dot--warning", "aria-hidden": "true" }),
                  jsx.jsx("span", { children: `${metadataAnomaly.count} 条记录的元数据无效；这些记录已从检索中排除，不影响其余记忆的使用与同步` }),
                ] }),
                metadataAnomaly.paths.length > 0 && jsx.jsx("span", { className: "dshmu_desc", children: metadataAnomaly.paths.join("、") }),
              ] }) }) }),
              repository !== null && jsx.jsxs("section", { className: "dshmu_row", "aria-label": "最近同步", onKeyDown: rowKeyDown("sync"), children: [
                lastRun === null
                  ? jsx.jsx("div", { className: "dshmu_head dshmu_head--static", children: jsx.jsxs("div", { className: "dshmu_headMain", children: [
                      jsx.jsx("div", { className: "dshmu_title", children: "最近同步" }),
                      jsx.jsx("span", { className: "dshmu_desc", children: "尚无同步记录" }),
                    ] }) })
                  : jsx.jsxs(jsx.Fragment, { children: [
                      renderRowHead("sync", "最近同步", { summary: lastRunMeta.label }),
                      renderRowBody("sync", jsx.jsxs(jsx.Fragment, { children: [
                        jsx.jsxs("div", { className: "dshmu_statusLine", children: [
                          jsx.jsx("span", { className: `dshmu_dot dshmu_dot--${lastRunMeta.tone}`, "aria-hidden": "true" }),
                          jsx.jsx("span", { children: `${lastRunMeta.label} · 变更 ${lastRun.changedFileCount ?? 0} 个文件` }),
                        ] }),
                        jsx.jsx("div", { className: "dshmu_metaLine", children: [
                          lastRun.applyCommit ? "apply 提交 " : null,
                          lastRun.applyCommit ? jsx.jsx("span", { className: "dshmu_mono", children: lastRun.applyCommit.slice(0, 8) }) : null,
                          lastRun.applyCommit && lastRun.runId ? " · " : null,
                          lastRun.runId ? "运行 " : null,
                          lastRun.runId ? jsx.jsx("span", { className: "dshmu_mono", children: lastRun.runId }) : null,
                        ] }),
                        lastRun.status === "applied" && lastRun.runId && jsx.jsx("div", { className: "dshmu_bodyActions", "aria-live": "polite", children: jsx.jsx(ConfirmButton, { variant: "plain", label: "回滚本次同步", busyLabel: "正在回滚…", confirmText: "确认回滚本次同步？", confirmLabel: "确认回滚", busy: rollbackBusy, disabled: !available, onConfirm: rollback, onComplete: () => focusRow("sync") }) }),
                        rollbackState && jsx.jsx("span", { className: rollbackState.error ? "dshmu_note dshmu_note--error" : "dshmu_note dshmu_note--success", role: "status", children: rollbackState.error ? `回滚失败：${rollbackState.error}` : rollbackState.success }),
                      ] })),
                    ] }),
              ] }),
              (previewList === null || previewList.length > 0) && jsx.jsxs("section", { className: "dshmu_row", "aria-label": "待应用预览", onKeyDown: rowKeyDown("previews"), children: [
                previewList === null
                  ? jsx.jsx("div", { className: "dshmu_head dshmu_head--static", children: jsx.jsxs("div", { className: "dshmu_headMain", children: [
                      jsx.jsx("div", { className: "dshmu_title", children: "待应用预览" }),
                      jsx.jsx("span", { className: "dshmu_desc", children: "正在读取预览…" }),
                    ] }) })
                  : jsx.jsxs(jsx.Fragment, { children: [
                      renderRowHead("previews", "待应用预览", { summary: `${previewList.length} 个` }),
                      renderRowBody("previews", jsx.jsxs(jsx.Fragment, { children: [
                        previewList.map((preview) => {
                          const pathsText = (preview.changed_paths ?? []).join(", ");
                          return jsx.jsxs("div", { className: "dshmu_previewLine", children: [
                            jsx.jsx("span", { className: "dshmu_mono", children: preview.preview_id }),
                            jsx.jsx("span", { className: "dshmu_previewPaths", title: pathsText, children: pathsText || "无变更" }),
                            jsx.jsxs("span", { className: "dshmu_previewActions", "aria-live": "polite", children: [
                              jsx.jsx(ConfirmButton, { tone: "accent", label: "应用", ariaLabel: `应用预览 ${preview.preview_id}`, busyLabel: "处理中…", confirmText: `应用预览 ${preview.preview_id}？`, confirmLabel: "确认应用", busy: previewBusy, disabled: !available, onConfirm: () => applyPreview(preview.preview_id), onComplete: () => focusRow("sync", "delete") }),
                              jsx.jsx(ConfirmButton, { tone: "default", label: "丢弃", ariaLabel: `丢弃预览 ${preview.preview_id}`, busyLabel: "处理中…", confirmText: `丢弃预览 ${preview.preview_id}？`, confirmLabel: "确认丢弃", busy: previewBusy, disabled: !available, onConfirm: () => discardPreview(preview.preview_id), onComplete: () => focusRow("sync", "delete") }),
                            ] }),
                          ] }, preview.preview_id);
                        }),
                        previewAction && jsx.jsx("span", { className: previewAction.error ? "dshmu_note dshmu_note--error" : "dshmu_note dshmu_note--success", role: "status", children: previewAction.error ? `预览操作失败：${previewAction.error}` : previewAction.success }),
                      ] })),
                    ] }),
              ] }),
              jsx.jsxs("section", { className: "dshmu_row", "aria-label": "删除记忆", onKeyDown: rowKeyDown("delete"), children: [
                renderRowHead("delete", "删除记忆", { danger: true }),
                renderRowBody("delete", jsx.jsxs(jsx.Fragment, { children: [
                  jsx.jsx("span", { className: "dshmu_desc", children: "将清空 summary.md、handbook、rollouts 和 archive 中的数据。清空后可从 Git 历史恢复，不会关闭长期记忆。" }),
                  jsx.jsx("input", { className: "dshmu_input", "aria-label": "删除记忆确认", value: phrase, disabled: !available || busy, onChange: (event) => setPhrase(event.target.value), placeholder: "输入「删除记忆」以确认" }),
                  jsx.jsxs("div", { className: "dshmu_bodyActions", style: { paddingLeft: 0 }, children: [
                    jsx.jsx("button", { type: "button", className: "dshmu_button dshmu_button--danger-solid", disabled: !available || busy || phrase !== "删除记忆", onClick: clear, children: busy ? "正在清空…" : "最终确认删除" }),
                    jsx.jsx("button", { type: "button", className: "dshmu_button", disabled: busy, onClick: () => { setPhrase(""); setState(null); setOpenRow(null); requestAnimationFrame(() => document.getElementById(`${baseId}-delete-head`)?.focus()); }, children: "取消" }),
                  ] }),
                  state && jsx.jsx("span", { className: state.error ? "dshmu_note dshmu_note--error" : "dshmu_note dshmu_note--success", role: "status", children: state.error ? `清空失败：${state.error}` : state.success }),
                ] })),
              ] }),
            ] });
          }
          memoryCtx.slots.inject("settings.general.item", () => memoryCtx.slots.register({ name: "settings.general.item", id: "memory", order: 30 }, MemoryRow));
        });
      },
    };
    module.exports = entry;
    return module.exports;
  },
});
