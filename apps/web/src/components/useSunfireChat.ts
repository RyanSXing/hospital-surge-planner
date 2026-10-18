import { useCallback, useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../api";
import {
  PlanningDraftConflict,
  type PlanningDraftBridge,
  type PlanningDraftSnapshot,
} from "../planningDraft";
import type { PlanningContext } from "../types";
import {
  directActionEligible,
  draftToken,
  pendingSunfireTurn,
  settledSunfireTurnCache,
  sunfireContext,
  sunfireError,
} from "./sunfireModel";
import type {
  SunfireAction,
  SunfireApplyBody,
  SunfireChat,
  SunfireContext,
  SunfireExecution,
  SunfireReceipt,
  SunfireStatus,
  SunfireTurn,
} from "./sunfireTypes";

const command = <T>(path: string, body: unknown, key?: string) =>
  api<T>(path, {
    method: "POST",
    body: JSON.stringify(body),
    ...(key ? { headers: { "Idempotency-Key": key } } : {}),
  });

export interface SunfireChatOptions {
  ownerId: string;
  open: boolean;
  ctx: PlanningContext;
  bridge: PlanningDraftBridge | null;
  onReceipt: (
    receipt: SunfireReceipt,
    after: PlanningDraftSnapshot,
    context: SunfireContext | null,
    ownerId: string,
  ) => Promise<boolean> | boolean;
  onActionStart?: () => void;
}

export function useSunfireChat(options: SunfireChatOptions) {
  const { open, ctx, bridge, ownerId } = options;
  const client = useQueryClient();
  const [selectedChats, setSelectedChats] = useState<Record<string, string>>(
    {},
  );
  const [creating, setCreating] = useState(false);
  const [sending, setSending] = useState(false);
  const sendingLock = useRef(false);
  const undoLocks = useRef(new Set<string>());
  const [error, setError] = useState("");
  const [executions, setExecutions] = useState<
    Record<string, SunfireExecution>
  >({});
  const [receiptRuns, setReceiptRuns] = useState<Record<string, string>>({});
  const latest = useRef(options);
  latest.current = options;
  const executionRef = useRef(executions);
  executionRef.current = executions;
  const allowedAutoTurns = useRef(new Set<string>());
  const attemptedActions = useRef(new Set<string>());
  const runningActions = useRef(new Set<string>());
  const turnContexts = useRef(new Map<string, SunfireContext>());
  const explicitRunTargets = useRef(new Map<string, string>());
  const uncertainSend = useRef<{
    chatId: string;
    message: string;
    context: SunfireContext;
    key: string;
  } | null>(null);
  const scenarioId = ctx.scenario?.id || "";
  const chatId = selectedChats[scenarioId] || "";
  const liveSelection = useRef({ scenarioId, chatId });
  liveSelection.current = { scenarioId, chatId };

  const status = useQuery({
    queryKey: ["sunfire-status", ownerId],
    queryFn: () => api<SunfireStatus>("/sunfire/status"),
    enabled: open,
    retry: false,
    staleTime: 30_000,
  });
  const chats = useQuery({
    queryKey: ["sunfire-chats", ownerId, scenarioId],
    queryFn: () =>
      api<{ items: SunfireChat[]; total: number }>(
        `/sunfire/chats?scenario_id=${encodeURIComponent(scenarioId)}&limit=30`,
      ),
    enabled: open && !!scenarioId,
    retry: false,
  });
  useEffect(() => {
    if (!chatId && chats.data?.items?.[0]?.id)
      setSelectedChats((previous) => ({
        ...previous,
        [scenarioId]: chats.data!.items[0].id,
      }));
  }, [chatId, scenarioId, chats.data]);
  const chat = useQuery({
    queryKey: ["sunfire-chat", ownerId, chatId],
    queryFn: () =>
      api<SunfireChat>(`/sunfire/chats/${encodeURIComponent(chatId)}`),
    enabled: !!chatId,
    retry: false,
    refetchInterval: (query) =>
      query.state.data?.turns.some((turn) => pendingSunfireTurn(turn.status))
        ? 1200
        : false,
  });
  const history = chat.data?.turns.slice(-30) || [];
  const historyKey = history
    .map((turn) => `${turn.id}:${turn.status}`)
    .join("|");
  const turns = useQuery({
    queryKey: ["sunfire-turn-history", ownerId, chatId, historyKey],
    queryFn: async () =>
      Promise.all(
        history.map((turn) => {
          const cached = client.getQueryData<SunfireTurn>([
            "sunfire-turn",
            ownerId,
            turn.id,
          ]);
          return client.fetchQuery({
            queryKey: ["sunfire-turn", ownerId, turn.id],
            queryFn: () =>
              api<SunfireTurn>(`/sunfire/turns/${encodeURIComponent(turn.id)}`),
            staleTime: settledSunfireTurnCache(turn.status, cached?.status)
              ? Infinity
              : 0,
          });
        }),
      ),
    enabled: !!chatId && !!history.length,
    retry: false,
    refetchInterval: (query) =>
      query.state.data?.some((turn) => pendingSunfireTurn(turn.status))
        ? 1200
        : false,
  });

  const updateExecution = useCallback(
    (id: string, execution: SunfireExecution) => {
      executionRef.current = { ...executionRef.current, [id]: execution };
      setExecutions(executionRef.current);
    },
    [],
  );
  const refreshChat = useCallback(
    async (id: string) => {
      await client.invalidateQueries({ queryKey: ["sunfire-turn", ownerId] });
      await Promise.all([
        client.invalidateQueries({ queryKey: ["sunfire-chat", ownerId, id] }),
        client.invalidateQueries({ queryKey: ["sunfire-chats", ownerId] }),
        client.invalidateQueries({
          queryKey: ["sunfire-turn-history", ownerId, id],
        }),
      ]);
    },
    [client, ownerId],
  );
  useEffect(() => {
    if (open && chatId) void refreshChat(chatId);
  }, [open, chatId, refreshChat]);

  const createChat = useCallback(async () => {
    const selected = latest.current.ctx.scenario?.id;
    if (!selected) throw new Error("Choose a saved scenario first.");
    setCreating(true);
    try {
      const created = await command<SunfireChat>(
        "/sunfire/chats",
        {
          scenario_id: selected,
        },
        crypto.randomUUID(),
      );
      client.setQueryData(["sunfire-chat", ownerId, created.id], created);
      if (latest.current.ctx.scenario?.id === selected)
        setSelectedChats((previous) => ({
          ...previous,
          [selected]: created.id,
        }));
      await client.invalidateQueries({
        queryKey: ["sunfire-chats", ownerId, selected],
      });
      setError("");
      return created;
    } finally {
      setCreating(false);
    }
  }, [client, ownerId]);

  const send = useCallback(
    async (message: string, selectedRunGroupId?: string) => {
      if (
        !message.trim() ||
        message.length > 8000 ||
        sendingLock.current ||
        creating
      )
        return false;
      const selected = latest.current.ctx.scenario?.id;
      if (!selected || !latest.current.bridge) {
        setError(
          "Open a saved hospital configuration before sending a message.",
        );
        return false;
      }
      sendingLock.current = true;
      setSending(true);
      setError("");
      try {
        const contextAtSend = latest.current.ctx;
        const capture = await latest.current.bridge.capture();
        if (capture.scenario_id !== selected) throw new PlanningDraftConflict();
        let selectedChat = liveSelection.current.chatId;
        if (!selectedChat) selectedChat = (await createChat()).id;
        if (latest.current.ctx.scenario?.id !== selected)
          throw new PlanningDraftConflict(
            "The selected scenario changed. Your message was not sent.",
          );
        const prior = uncertainSend.current;
        const context = sunfireContext(capture, contextAtSend);
        if (selectedRunGroupId) {
          context.selected_run_group_id = selectedRunGroupId;
          if (selectedRunGroupId !== latest.current.ctx.run?.id)
            context.selected_replication_id = null;
        }
        const request =
          prior?.chatId === selectedChat &&
          prior.message === message &&
          prior.context.selected_run_group_id === context.selected_run_group_id
            ? prior
            : {
                chatId: selectedChat,
                message,
                context,
                key: crypto.randomUUID(),
              };
        uncertainSend.current = request;
        const turn = await command<SunfireTurn>(
          `/sunfire/chats/${encodeURIComponent(request.chatId)}/turns`,
          { message: request.message, context: request.context },
          request.key,
        );
        uncertainSend.current = null;
        allowedAutoTurns.current.add(turn.id);
        turnContexts.current.set(turn.id, request.context);
        if (selectedRunGroupId)
          explicitRunTargets.current.set(turn.id, selectedRunGroupId);
        client.setQueryData(["sunfire-turn", ownerId, turn.id], turn);
        await refreshChat(request.chatId);
        return true;
      } catch (cause) {
        setError(sunfireError(cause));
        return false;
      } finally {
        sendingLock.current = false;
        setSending(false);
      }
    },
    [creating, createChat, client, refreshChat, ownerId],
  );

  const execute = useCallback(
    async (action: SunfireAction, turnId?: string, automatic = false) => {
      if (runningActions.current.has(action.id)) return;
      runningActions.current.add(action.id);
      try {
        const current = latest.current;
        if (
          current.ctx.canWrite === false ||
          !current.bridge ||
          current.ctx.scenario?.id !== action.expected.scenario_id
        )
          throw new PlanningDraftConflict(
            "Select the original scenario with editing access to apply this change.",
          );
        const checkCancelTarget = () => {
          if (
            automatic &&
            action.kind === "cancel_run" &&
            latest.current.ctx.run?.id !== action.run_group_id &&
            (!turnId ||
              explicitRunTargets.current.get(turnId) !== action.run_group_id)
          )
            throw new PlanningDraftConflict(
              "The selected simulation changed. Review the cancellation target before applying it.",
            );
        };
        checkCancelTarget();
        let state = executionRef.current[action.id];
        if (state?.status === "applied") return;
        let receipt: SunfireReceipt | undefined;
        if (state?.body && state.after) {
          // Read the outcome first after a lost response. Replaying a historical
          // receipt is safe even when the user has since edited their draft.
          const remote = await api<{
            action: SunfireAction;
            receipt?: SunfireReceipt;
          }>(`/sunfire/actions/${encodeURIComponent(action.id)}`);
          receipt = remote.receipt;
        }
        if (!state?.body || !state.after) {
          updateExecution(action.id, { status: "applying" });
          current.onActionStart?.();
          const after = await current.bridge.apply(
            action.expected,
            action.validated_draft,
          );
          const body: SunfireApplyBody = {
            expected: draftToken(action.expected),
            after: {
              draft_revision: after.draft_revision,
              draft_fingerprint: after.draft_fingerprint,
              draft: after.draft,
            },
          };
          state = { status: "confirming", after, body };
        } else state = { ...state, status: "confirming", error: undefined };
        updateExecution(action.id, state);
        if (
          !receipt &&
          ["save", "run", "cancel_run"].includes(action.kind) &&
          !(await latest.current.bridge?.isCurrent(state.after!))
        )
          throw new PlanningDraftConflict(
            "Configuration changed before this operation could start. Send the request again using the current draft.",
          );
        if (!receipt) checkCancelTarget();
        receipt ||= await command<SunfireReceipt>(
          `/sunfire/actions/${encodeURIComponent(action.id)}/${["edit", "undo"].includes(action.kind) ? "ack" : "apply"}`,
          state.body,
          action.id,
        );
        // A receipt describes an action that really executed, even if the user
        // has since navigated away. Never relabel that as an unexecuted failure.
        updateExecution(action.id, { ...state, status: "applied", receipt });
        if (receipt.run_group?.id)
          setReceiptRuns((previous) => ({
            ...previous,
            [action.id]: receipt.run_group!.id,
          }));
        const context = turnId
          ? turnContexts.current.get(turnId) || null
          : null;
        let adopted = false;
        try {
          adopted = await latest.current.onReceipt(
            receipt,
            state.after!,
            context,
            ownerId,
          );
        } catch {
          // The saved action/job remains durable and is linked in this chat.
        }
        updateExecution(action.id, {
          ...state,
          status: "applied",
          receipt,
          contextPreserved: !adopted,
        });
        const turnKey = turnId ? ["sunfire-turn", ownerId, turnId] : null;
        if (turnKey) await client.invalidateQueries({ queryKey: turnKey });
        await refreshChat(liveSelection.current.chatId);
      } catch (cause) {
        const state = executionRef.current[action.id];
        updateExecution(action.id, {
          ...state,
          status: cause instanceof PlanningDraftConflict ? "stale" : "error",
          error: sunfireError(cause),
        });
      } finally {
        runningActions.current.delete(action.id);
      }
    },
    [client, refreshChat, updateExecution, ownerId],
  );

  useEffect(() => {
    for (const turn of turns.data || []) {
      if (!allowedAutoTurns.current.has(turn.id)) continue;
      for (const action of turn.actions || []) {
        if (
          attemptedActions.current.has(action.id) ||
          !directActionEligible(
            action,
            turn.status,
            scenarioId,
            ctx.canWrite !== false,
          )
        )
          continue;
        attemptedActions.current.add(action.id);
        void execute(action, turn.id, true);
      }
    }
  }, [turns.data, scenarioId, ctx.canWrite, execute]);

  const cancelTurn = useCallback(
    async (turn: SunfireTurn) => {
      try {
        const cancelled = await command<SunfireTurn>(
          `/sunfire/turns/${encodeURIComponent(turn.id)}/cancel`,
          {},
        );
        client.setQueryData(["sunfire-turn", ownerId, turn.id], cancelled);
        await refreshChat(turn.chat_id);
      } catch (cause) {
        setError(sunfireError(cause));
      }
    },
    [client, refreshChat, ownerId],
  );
  const retryTurn = useCallback(
    async (turn: SunfireTurn) => {
      try {
        const captured = turnContexts.current.get(turn.id);
        if (captured && !(await latest.current.bridge?.isCurrent(captured)))
          throw new PlanningDraftConflict(
            "Configuration changed since this response. Send your request again to use the current draft.",
          );
        const retried = await command<SunfireTurn>(
          `/sunfire/turns/${encodeURIComponent(turn.id)}/retry`,
          {},
          `retry-${turn.id}`,
        );
        allowedAutoTurns.current.add(retried.id);
        if (captured) turnContexts.current.set(retried.id, captured);
        const explicitRun = explicitRunTargets.current.get(turn.id);
        if (explicitRun)
          explicitRunTargets.current.set(retried.id, explicitRun);
        client.setQueryData(["sunfire-turn", ownerId, retried.id], retried);
        await refreshChat(turn.chat_id);
      } catch (cause) {
        setError(sunfireError(cause));
      }
    },
    [client, refreshChat, ownerId],
  );
  const undo = useCallback(
    async (action: SunfireAction) => {
      if (undoLocks.current.has(action.id)) return;
      undoLocks.current.add(action.id);
      try {
        const current = latest.current;
        if (!current.bridge || current.ctx.canWrite === false)
          throw new PlanningDraftConflict(
            "Editing access is required to undo changes.",
          );
        const capture = await current.bridge.capture();
        const reversed = await command<SunfireAction>(
          `/sunfire/actions/${encodeURIComponent(action.id)}/undo`,
          { context: sunfireContext(capture, current.ctx) },
          `undo-${action.id}-${capture.draft_fingerprint}`,
        );
        await execute(reversed);
        await refreshChat(liveSelection.current.chatId);
      } catch (cause) {
        setError(sunfireError(cause));
      } finally {
        undoLocks.current.delete(action.id);
      }
    },
    [execute, refreshChat],
  );
  const selectChat = useCallback(
    (id: string) => {
      setError("");
      setSelectedChats((previous) => ({ ...previous, [scenarioId]: id }));
    },
    [scenarioId],
  );

  return {
    status,
    chats,
    chat,
    turns: turns.data || [],
    turnsLoading: turns.isFetching,
    historyError: chat.error || turns.error || chats.error,
    chatId,
    creating,
    sending,
    error,
    setError,
    executions,
    receiptRuns,
    createChat,
    selectChat,
    send,
    execute,
    undo,
    cancelTurn,
    retryTurn,
    pending:
      sending ||
      history.some((turn) => pendingSunfireTurn(turn.status)) ||
      (turns.data || []).some((turn) => pendingSunfireTurn(turn.status)),
  };
}
