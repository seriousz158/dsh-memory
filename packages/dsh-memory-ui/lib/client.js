window.__ModuleLoader__.load({
  id: "dsh-memory-ui",
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
    const css = ".dshmu_row{display:flex;align-items:flex-start;justify-content:space-between;gap:12px;padding:10px 0;border-bottom:1px solid var(--dsw-alias-border-l2,#eee)}.dshmu_text,.dshmu_clear{min-width:0;display:flex;flex-direction:column;gap:4px}.dshmu_title{font:var(--dsw-font-s-strong-14,14px sans-serif);font-weight:600}.dshmu_desc,.dshmu_status{font:var(--dsw-font-xs-13,12px sans-serif);color:var(--dsw-alias-label-caption,#888)}.dshmu_error{color:var(--dsw-alias-state-danger,#c53b37)}.dshmu_switch{width:38px;height:22px;border-radius:999px;border:0;cursor:pointer;position:relative;background:#ddd}.dshmu_switch[aria-checked=true]{background:var(--dsw-static-deepseek-500,#4d6bfe)}.dshmu_switch:disabled,.dshmu_button:disabled{opacity:.5;cursor:default}.dshmu_knob{position:absolute;top:2px;left:2px;width:18px;height:18px;border-radius:50%;background:#fff}.dshmu_switch[aria-checked=true] .dshmu_knob{left:18px}.dshmu_button{align-self:flex-start;border:0;border-radius:6px;padding:6px 10px;color:#fff;background:var(--dsw-alias-state-danger,#c53b37);cursor:pointer}.dshmu_input{padding:6px;border:1px solid var(--dsw-alias-border-l2,#ddd);border-radius:6px}";
    const tagId = "dsh-memory-ui/style.css";
    if (typeof document !== "undefined" && document.querySelector("style[data-plugin-css=" + JSON.stringify(tagId) + "]") === null) { const tag = document.createElement("style"); tag.dataset.plugin = "dsh-memory-ui"; tag.dataset.pluginCss = tagId; tag.textContent = css; document.head.appendChild(tag); }
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
            const [stage, setStage] = react.useState(0);
            const [phrase, setPhrase] = react.useState("");
            const [state, setState] = react.useState(null);
            const [busy, setBusy] = react.useState(false);
            const [repository, setRepository] = react.useState(null);
            const [repositoryRevision, setRepositoryRevision] = react.useState(0);
            const [rollbackState, setRollbackState] = react.useState(null);
            const [rollbackBusy, setRollbackBusy] = react.useState(false);
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
            const rollback = async () => {
              const runId = repository?.value?.lastRun?.runId;
              if (!runId) return;
              if (!window.confirm(`回滚本次同步（${runId}）？变更文件：${(repository.value.lastRun.changedFileCount ?? 0)} 个。此操作会恢复同步前的记忆内容。`)) return;
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
              if (!window.confirm(`应用预览 ${previewId}？其暂存内容将写入记忆库。`)) return;
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
              if (!window.confirm(`丢弃预览 ${previewId}？其暂存内容将被删除。`)) return;
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
              if (stage < 2) return setStage(stage + 1);
              setBusy(true); setState(null);
              try {
                const answer = operationResult(await memory.clear({ confirmation: "DELETE_MEMORY" }));
                if (!answer.ok) return setState({ error: answer.error.code });
                setStage(0); setPhrase(""); setRepositoryRevision((revision) => revision + 1);
                const checkpoints = [answer.value.recoveryCommit && "恢复提交", answer.value.clearCommit && "清空提交"].filter(Boolean).join("和");
                setState({ success: answer.value.alreadyEmpty ? "记忆已为空" : `已清空 ${answer.value.clearedFileCount} 个记忆文件${checkpoints ? `，已创建${checkpoints}` : ""}；长期记忆仍保持开启` });
              } catch {
                setState({ error: "clear-failed" });
              } finally {
                setBusy(false);
              }
            };
            const unavailable = snapshot.status === "error" ? `长期记忆服务未就绪，暂不能修改（${snapshot.error ?? "settings-unavailable"}）` : snapshot.status === "loading" ? "正在读取长期记忆设置…" : "长期记忆设置不可写";
            const repositoryDescription = repository?.error ? `记忆库不可用：${repository.error}` : repository?.value ? `记忆库：${repository.value.empty ? "为空" : `${repository.value.dataFileCount} 个数据文件`}；${repository.value.targetDirty ? "目标路径有未提交内容，将先创建恢复提交" : repository.value.recoverable ? "可从 Git 历史恢复" : "不可恢复"}` : "正在读取记忆库状态…";
            return jsx.jsxs("div", { children: [
              jsx.jsxs("div", { className: "dshmu_row", children: [
                jsx.jsxs("div", { className: "dshmu_text", children: [jsx.jsx("span", { className: "dshmu_title", children: "长期记忆" }), jsx.jsx("span", { className: "dshmu_desc", children: available ? "开启后自动回忆历史经验并在任务收尾时自动提炼整合（默认目录：~/.dsh/storages/memory）" : unavailable })] }),
                jsx.jsx("button", { type: "button", role: "switch", "aria-label": "长期记忆", "aria-checked": enabled, className: "dshmu_switch", disabled: !available, onClick: () => scope.set("enabled", !enabled), children: jsx.jsx("span", { className: "dshmu_knob" }) }),
              ] }),
              jsx.jsxs("div", { className: "dshmu_clear", children: [
                jsx.jsx("span", { className: "dshmu_title", children: "记忆管理" }),
                jsx.jsx("span", { className: "dshmu_desc", children: "清空数据可从 Git 历史恢复；不会关闭长期记忆。" }),
                jsx.jsx("span", { className: repository?.error ? "dshmu_status dshmu_error" : "dshmu_status", children: repositoryDescription }),
                stage === 1 && jsx.jsx("span", { className: "dshmu_status dshmu_error", children: "将清空 summary.md、handbook、rollouts 和 archive 中的数据。" }),
                stage === 2 && jsx.jsxs(jsx.Fragment, { children: [jsx.jsx("input", { className: "dshmu_input", "aria-label": "删除记忆确认", value: phrase, onChange: (event) => setPhrase(event.target.value), placeholder: "输入 删除记忆 以确认" }), jsx.jsx("span", { className: "dshmu_status dshmu_error", children: "请输入“删除记忆”后进行最终确认。" })] }),
                jsx.jsx("button", { type: "button", className: "dshmu_button", disabled: !available || busy || (stage === 2 && phrase !== "删除记忆"), onClick: clear, children: busy ? "正在清空…" : stage === 0 ? "删除记忆" : stage === 1 ? "继续" : "最终确认删除" }),
                state && jsx.jsx("span", { className: state.error ? "dshmu_status dshmu_error" : "dshmu_status", children: state.error ? `清空失败：${state.error}` : state.success }),
              ] }),
              jsx.jsxs("div", { className: "dshmu_clear", children: [
                jsx.jsx("span", { className: "dshmu_title", children: "最近同步" }),
                jsx.jsx("span", { className: "dshmu_status", children: repository?.value?.lastRun ? `状态：${repository.value.lastRun.status}；变更 ${repository.value.lastRun.changedFileCount ?? 0} 个文件；apply ${repository.value.lastRun.applyCommit ? repository.value.lastRun.applyCommit.slice(0, 8) : "-"}` : "尚无同步记录" }),
                (repository?.value?.lastRun && repository.value.lastRun.status === "applied") && jsx.jsx("button", { type: "button", className: "dshmu_button", disabled: !available || rollbackBusy, onClick: rollback, children: rollbackBusy ? "正在回滚…" : "回滚本次同步" }),
                rollbackState && jsx.jsx("span", { className: rollbackState.error ? "dshmu_status dshmu_error" : "dshmu_status", children: rollbackState.error ? `回滚失败：${rollbackState.error}` : rollbackState.success }),
              ] }),
              jsx.jsxs("div", { className: "dshmu_clear", children: [
                jsx.jsx("span", { className: "dshmu_title", children: "待应用预览" }),
                jsx.jsx("span", { className: "dshmu_status", children: previewList === null ? "正在读取预览…" : previewList.length === 0 ? "暂无待应用预览" : `共 ${previewList.length} 个待应用预览` }),
                previewList && previewList.map((preview) => jsx.jsxs("div", { className: "dshmu_clear", children: [
                  jsx.jsx("span", { className: "dshmu_status", children: `${preview.preview_id}：${(preview.changed_paths ?? []).join(", ") || "无变更"}` }),
                  jsx.jsx("div", { className: "dshmu_clear", children: [
                    jsx.jsx("button", { type: "button", className: "dshmu_button", disabled: !available || previewBusy, onClick: () => applyPreview(preview.preview_id), children: previewBusy ? "处理中…" : "应用" }),
                    jsx.jsx("button", { type: "button", className: "dshmu_button", disabled: !available || previewBusy, onClick: () => discardPreview(preview.preview_id), children: previewBusy ? "处理中…" : "丢弃" }),
                  ] }),
                ] }, preview.preview_id)),
                previewAction && jsx.jsx("span", { className: previewAction.error ? "dshmu_status dshmu_error" : "dshmu_status", children: previewAction.error ? `预览操作失败：${previewAction.error}` : previewAction.success }),
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
