import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { ActionIcon, NativeSelect, Textarea, Tooltip } from "@mantine/core";
import {
  ArrowRight,
  ArrowUp,
  ArrowUpRight,
  Check,
  ChevronDown,
  Flame,
  LoaderCircle,
  MessageSquare,
  PanelRightClose,
  PanelRightOpen,
  Plus,
  RotateCcw,
  Square,
  X,
} from "lucide-react";
import { localDate } from "../api";
import type { PlanningContext } from "../types";
import {
  canonicalDraft,
  type PlanningDraftBridge,
  type PlanningDraftSnapshot,
} from "../planningDraft";
import { Button } from "./ui";
import {
  changeValue,
  pendingSunfireTurn,
  sunfireError,
  usableEvidenceLink,
} from "./sunfireModel";
import { useSunfireChat, type SunfireChatOptions } from "./useSunfireChat";
import SunfireRunCard from "./SunfireRunCard";
import type {
  SunfireAction,
  SunfireEvidence,
  SunfireExecution,
  SunfireLink,
  SunfireMode,
} from "./sunfireTypes";
import "./sunfireAssistant.css";

const noSubscription = () => () => {};
const zeroVersion = () => 0;

export function ActionCard({
  action,
  execution,
  canWrite,
  onApply,
  onUndo,
  timezone,
}: {
  action: SunfireAction;
  execution?: SunfireExecution;
  canWrite: boolean;
  onApply: () => void;
  onUndo: () => void;
  timezone: string;
}) {
  const applied =
    action.status === "APPLIED" || execution?.status === "applied";
  const undone = action.status === "UNDONE";
  const busy =
    execution?.status === "applying" || execution?.status === "confirming";
  const confirming = !!execution?.body && !applied;
  const stale = execution?.status === "stale";
  const rows = action.before_after || [];
  const draftChanged =
    action.normalized_before_sha256 && action.normalized_after_sha256
      ? action.normalized_before_sha256 !== action.normalized_after_sha256
      : rows.some(
          (row) => canonicalDraft(row.before) !== canonicalDraft(row.after),
        );
  const actionLabels = {
    edit: "Apply changes",
    save: "Save draft",
    run: "Run simulation",
    cancel_run: "Cancel simulation",
    undo: "Undo changes",
  };
  const heading = undone
    ? "Changes undone"
    : applied
      ? action.kind === "cancel_run"
        ? "Cancellation requested"
        : action.kind === "run"
          ? "Simulation submitted"
          : action.kind === "save"
            ? "Draft saved"
            : action.kind === "undo"
              ? "Changes undone"
              : "Changes applied"
      : confirming
        ? "Draft updated · confirmation pending"
        : action.mode === "proposal"
          ? "Suggested changes"
          : "Requested changes";
  const windowText = (start?: string, end?: string) =>
    start && Number.isFinite(Date.parse(start))
      ? `${localDate(start, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZone: timezone })}${end && Number.isFinite(Date.parse(end)) ? ` – ${localDate(end, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZone: timezone })}` : ""}`
      : null;
  return (
    <section
      className="sunfire-action-card"
      data-testid="sunfire-action"
      data-action-id={action.id}
      data-status={
        undone
          ? "UNDONE"
          : applied
            ? "APPLIED"
            : execution?.status || action.status
      }
    >
      <header>
        {busy ? (
          <LoaderCircle size={14} className="spin" />
        ) : applied || undone ? (
          <Check size={14} />
        ) : (
          <MessageSquare size={14} />
        )}
        <strong>{heading}</strong>
      </header>
      {rows.length ? (
        <div
          className="sunfire-change-table"
          role="table"
          aria-label="Configuration changes before and after"
        >
          <div className="sunfire-change-head" role="row">
            <span role="columnheader">Parameter</span>
            <span role="columnheader">Before</span>
            <span aria-hidden="true" />
            <span role="columnheader">After</span>
          </div>
          {rows.map((row, index) => (
            <div
              className="sunfire-change-row"
              role="row"
              key={`${row.field}-${index}`}
            >
              <span role="cell">
                {row.label || "Configuration"}
                {windowText(row.start_at, row.end_at) ? (
                  <small>{windowText(row.start_at, row.end_at)}</small>
                ) : null}
              </span>
              <span role="cell">{changeValue(row.before, row.unit)}</span>
              <ArrowRight size={11} aria-hidden="true" />
              <strong role="cell">{changeValue(row.after, row.unit)}</strong>
            </div>
          ))}
        </div>
      ) : null}
      {execution?.error && !applied ? (
        <p className="sunfire-inline-error" role="alert">
          {execution.error}
        </p>
      ) : null}
      {execution?.contextPreserved ? (
        <p>
          Your newer workspace selection and edits were kept. This action
          remains saved in the conversation.
        </p>
      ) : null}
      {action.explanation || action.warnings?.length ? (
        <details className="sunfire-action-details">
          <summary>
            Details <ChevronDown size={11} />
          </summary>
          {action.explanation ? <p>{action.explanation}</p> : null}
          {(action.warnings || []).map((warning, index) => (
            <p key={index}>{warning}</p>
          ))}
        </details>
      ) : null}
      {!undone ? (
        <footer>
          {!applied ? (
            <Button
              small
              primary
              disabled={!canWrite || busy || stale}
              onClick={onApply}
            >
              {busy ? <LoaderCircle size={12} className="spin" /> : null}
              {confirming ? "Retry confirmation" : actionLabels[action.kind]}
            </Button>
          ) : draftChanged && ["edit", "save", "run"].includes(action.kind) ? (
            <button
              className="sunfire-text-action"
              disabled={!canWrite}
              onClick={onUndo}
            >
              <RotateCcw size={12} /> Undo changes
            </button>
          ) : null}
          {applied && action.kind === "edit" ? (
            <small>Updated in Configuration</small>
          ) : null}
        </footer>
      ) : null}
    </section>
  );
}

export function EvidenceCard({
  evidence,
  onNavigate,
}: {
  evidence: SunfireEvidence;
  onNavigate: (link: SunfireLink) => void;
}) {
  const links = (evidence.links || []).filter(usableEvidenceLink);
  const values = Array.isArray(evidence.values) ? evidence.values : [];
  const mismatch = evidence.context?.matches_current_draft === false;
  return (
    <section className="sunfire-evidence-card">
      {mismatch ? (
        <p className="sunfire-historical-note">
          These recorded results use a different configuration from your current
          draft.
        </p>
      ) : null}
      <details>
        <summary>
          {evidence.title || "Supporting evidence"}
          <span>
            {evidence.scope === "ensemble"
              ? "Across simulations"
              : evidence.scope === "example_run" || evidence.scope === "example"
                ? "Example run"
                : ""}
          </span>
          <ChevronDown size={11} />
        </summary>
        {evidence.summary ? <p>{evidence.summary}</p> : null}
        {values.length ? (
          <dl className="sunfire-result-measures">
            {values
              .slice(0, 8)
              .map(
                (
                  row: { label: string; value: unknown; unit?: string },
                  index: number,
                ) => (
                  <div key={index}>
                    <dt>{row.label}</dt>
                    <dd>
                      {row.value === null || row.value === undefined
                        ? "Unavailable"
                        : changeValue(row.value, row.unit)}
                    </dd>
                  </div>
                ),
              )}
          </dl>
        ) : null}
        {evidence.context?.start_at && evidence.context?.end_at ? (
          <p className="sunfire-evidence-scope">
            Saved forecast · {localDate(evidence.context.start_at)} –{" "}
            {localDate(evidence.context.end_at)}
          </p>
        ) : null}
      </details>
      {links.length ? (
        <div className="sunfire-card-actions">
          {links.map((link, index) => (
            <button key={index} onClick={() => onNavigate(link)}>
              {link.label}
              <ArrowUpRight size={12} />
            </button>
          ))}
        </div>
      ) : null}
    </section>
  );
}

export default function SunfireAssistant({
  ownerId,
  mode,
  onModeChange,
  ctx,
  bridge,
  onReceipt,
  onNavigate,
}: {
  ownerId: string;
  mode: SunfireMode;
  onModeChange: (mode: SunfireMode) => void;
  ctx: PlanningContext;
  bridge: PlanningDraftBridge | null;
  onReceipt: SunfireChatOptions["onReceipt"];
  onNavigate: (link: SunfireLink) => void;
}) {
  const launcher = useRef<HTMLButtonElement>(null);
  const composer = useRef<HTMLTextAreaElement>(null);
  const scroll = useRef<HTMLDivElement>(null);
  const followMessages = useRef(true);
  const [input, setInput] = useState("");
  const [draft, setDraft] = useState<PlanningDraftSnapshot | null>(null);
  const [openingError, setOpeningError] = useState("");
  const open = mode !== "closed";
  const version = useSyncExternalStore(
    bridge?.subscribe || noSubscription,
    bridge?.getVersion || zeroVersion,
    zeroVersion,
  );
  const chat = useSunfireChat({
    ownerId,
    open,
    ctx,
    bridge,
    onReceipt,
    onActionStart: () => onModeChange("expanded"),
  });
  const previousOpen = useRef(false);
  useEffect(() => {
    if (open && !previousOpen.current)
      requestAnimationFrame(() =>
        composer.current?.focus({ preventScroll: true }),
      );
    if (!open && previousOpen.current)
      launcher.current?.focus({ preventScroll: true });
    previousOpen.current = open;
  }, [open]);
  useEffect(() => {
    if (!open || !bridge) return;
    let ignore = false;
    const timer = setTimeout(() => {
      bridge
        .capture()
        .then((value) => {
          if (!ignore) {
            setDraft(value);
            setOpeningError("");
          }
        })
        .catch((error) => {
          if (!ignore) {
            setDraft(null);
            setOpeningError(sunfireError(error));
          }
        });
    }, 100);
    return () => {
      ignore = true;
      clearTimeout(timer);
    };
  }, [
    open,
    bridge,
    version,
    ctx.scenario?.id,
    ctx.scenario?.revision,
    ctx.canWrite,
  ]);
  const messages = chat.chat.data?.messages || [];
  const turnById = new Map(chat.turns.map((turn) => [turn.id, turn]));
  const completedAssistantTurns = new Set(
    messages
      .filter((message) => message.role === "assistant")
      .map((message) => message.turn_id),
  );
  const pendingTurns = chat.turns.filter(
    (turn) =>
      pendingSunfireTurn(turn.status) ||
      (!completedAssistantTurns.has(turn.id) &&
        ["FAILED", "CANCELLED"].includes(turn.status)),
  );
  useLayoutEffect(() => {
    if (open && followMessages.current && scroll.current)
      scroll.current.scrollTop = scroll.current.scrollHeight;
  }, [open, messages.length, chat.turns, chat.executions]);
  useLayoutEffect(() => {
    const viewport = scroll.current;
    const log = viewport?.querySelector('[role="log"]');
    if (!open || !viewport || !log) return;
    const observer = new ResizeObserver(() => {
      if (followMessages.current) viewport.scrollTop = viewport.scrollHeight;
    });
    observer.observe(log);
    return () => observer.disconnect();
  }, [open, chat.chatId]);
  const canSend = Boolean(
    ctx.scenario &&
    bridge &&
    chat.status.data?.available &&
    !chat.pending &&
    !chat.creating &&
    !chat.sending,
  );
  const send = async (text = input, runId?: string) => {
    if (!text.trim()) return;
    followMessages.current = true;
    if (await chat.send(text, runId)) {
      if (text === input) setInput("");
      composer.current?.focus({ preventScroll: true });
    }
  };
  const timezone =
    ctx.scenario?.timezone || ctx.dataset?.timezone || "America/Chicago";
  const currentDraft =
    draft && draft.scenario_id === ctx.scenario?.id ? draft : null;
  const renderTurnDetails = (turnId: string) => {
    const turn = turnById.get(turnId);
    if (!turn) return null;
    return (
      <>
        {(turn.actions || []).map((action) => {
          const receipt = chat.executions[action.id]?.receipt;
          const runId =
            receipt?.run_group?.id ||
            chat.receiptRuns[action.id] ||
            action.run_group_id;
          return (
            <div key={action.id} className="sunfire-action-group">
              <ActionCard
                action={action}
                execution={chat.executions[action.id]}
                canWrite={ctx.canWrite !== false}
                onApply={() => void chat.execute(action, turn.id)}
                onUndo={() => void chat.undo(action)}
                timezone={timezone}
              />
              {runId && (action.kind === "run" || receipt?.run_group) ? (
                <SunfireRunCard
                  active={open}
                  runId={runId}
                  ctx={ctx}
                  onNavigate={onNavigate}
                  onRequest={(message, id) => void send(message, id)}
                  disabled={chat.pending || ctx.canWrite === false}
                />
              ) : null}
            </div>
          );
        })}
        {(turn.evidence || []).map((evidence, index) => (
          <EvidenceCard
            key={evidence.id || index}
            evidence={evidence}
            onNavigate={onNavigate}
          />
        ))}
      </>
    );
  };
  return (
    <>
      <button
        ref={launcher}
        className="sunfire-launcher"
        hidden={open}
        aria-label="Open Sunfire planning assistant"
        aria-expanded={open}
        aria-controls="sunfire-assistant"
        onClick={() => onModeChange("compact")}
      >
        <Flame size={18} />
        <span>
          Sunfire <small>Planning assistant</small>
        </span>
      </button>
      <aside
        id="sunfire-assistant"
        className={`sunfire-assistant sunfire-assistant--${mode}`}
        hidden={!open}
        aria-label="Sunfire planning assistant"
        data-mode={mode}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.stopPropagation();
            onModeChange("closed");
          }
        }}
      >
        <header className="sunfire-header">
          <div className="sunfire-title">
            <span className="sunfire-symbol">
              <Flame size={18} />
            </span>
            <div>
              <h2>Sunfire</h2>
              <p>Planning assistant</p>
            </div>
          </div>
          <div className="sunfire-header-actions">
            <Tooltip label="New conversation">
              <ActionIcon
                variant="subtle"
                color="gray"
                aria-label="New Sunfire conversation"
                disabled={!ctx.scenario || chat.creating || chat.sending}
                onClick={() =>
                  void chat
                    .createChat()
                    .catch((error) => chat.setError(sunfireError(error)))
                }
              >
                <Plus size={16} />
              </ActionIcon>
            </Tooltip>
            <Tooltip
              label={
                mode === "expanded" ? "Collapse assistant" : "Expand assistant"
              }
            >
              <ActionIcon
                variant="subtle"
                color="gray"
                aria-label={
                  mode === "expanded"
                    ? "Collapse planning assistant"
                    : "Expand planning assistant"
                }
                onClick={() =>
                  onModeChange(mode === "expanded" ? "compact" : "expanded")
                }
              >
                {mode === "expanded" ? (
                  <PanelRightClose size={16} />
                ) : (
                  <PanelRightOpen size={16} />
                )}
              </ActionIcon>
            </Tooltip>
            <Tooltip label="Close assistant">
              <ActionIcon
                variant="subtle"
                color="gray"
                aria-label="Close planning assistant"
                onClick={() => onModeChange("closed")}
              >
                <X size={17} />
              </ActionIcon>
            </Tooltip>
          </div>
        </header>
        <div className="sunfire-context">
          <i aria-hidden="true" />
          <span>
            Using{" "}
            <strong>
              {currentDraft?.scenario_name ||
                ctx.scenario?.name ||
                "current workspace"}
            </strong>
            {currentDraft?.dirty ? " · unsaved changes" : ""}
          </span>
          {ctx.canWrite === false ? <small>Read only</small> : null}
        </div>
        {chat.chats.data?.items?.length ? (
          <NativeSelect
            className="sunfire-conversation-picker"
            aria-label="Sunfire conversation"
            value={chat.chatId}
            onChange={(event) => chat.selectChat(event.currentTarget.value)}
            data={chat.chats.data.items.map((item) => ({
              value: item.id,
              label: item.title || "Hospital planning conversation",
            }))}
          />
        ) : null}
        <div
          ref={scroll}
          className="sunfire-transcript"
          onScroll={() => {
            if (scroll.current)
              followMessages.current =
                scroll.current.scrollHeight -
                  scroll.current.scrollTop -
                  scroll.current.clientHeight <
                90;
          }}
        >
          {!messages.length && !chat.chat.isFetching ? (
            <div className="sunfire-welcome">
              <span className="sunfire-welcome-icon">
                <Flame size={22} />
              </span>
              <h3>What would you like to plan?</h3>
              <p>
                Describe a change or ask about your simulation. I use the same
                configuration you edit here.
              </p>
              <div>
                {[
                  "Explain this configuration.",
                  "Where is the main bottleneck?",
                  "What should I compare?",
                ].map((prompt) => (
                  <button
                    key={prompt}
                    disabled={!canSend}
                    onClick={() => void send(prompt)}
                  >
                    {prompt}
                    <ArrowRight size={12} />
                  </button>
                ))}
              </div>
            </div>
          ) : null}
          <div
            role="log"
            aria-label="Sunfire conversation messages"
            aria-live="polite"
            aria-relevant="additions text"
          >
            {messages.map((message) => (
              <article
                key={message.id}
                className={`sunfire-message sunfire-message--${message.role}`}
                data-turn-id={message.turn_id}
              >
                <div className="sunfire-message-heading">
                  {message.role === "assistant" ? <Flame size={13} /> : null}
                  <span>
                    {message.role === "assistant" ? "Sunfire" : "You"}
                  </span>
                </div>
                <div className="sunfire-message-content">{message.content}</div>
                {message.role === "assistant"
                  ? renderTurnDetails(message.turn_id)
                  : null}
              </article>
            ))}
          </div>
          {pendingTurns.map((turn) => (
            <div
              key={turn.id}
              className="sunfire-turn-state"
              data-turn-id={turn.id}
              data-status={turn.status}
            >
              {pendingSunfireTurn(turn.status) ? (
                <>
                  <LoaderCircle size={14} className="spin" />
                  <span>
                    {turn.status === "CANCEL_REQUESTED"
                      ? "Stopping response…"
                      : "Reviewing your configuration…"}
                  </span>
                  <button
                    aria-label="Stop Sunfire response"
                    disabled={turn.status === "CANCEL_REQUESTED"}
                    onClick={() => void chat.cancelTurn(turn)}
                  >
                    <Square size={11} /> Stop
                  </button>
                </>
              ) : (
                <>
                  <p>
                    {turn.status === "CANCELLED"
                      ? "Response stopped. Existing configuration and simulations are preserved."
                      : sunfireError(turn.error)}
                  </p>
                  <button onClick={() => void chat.retryTurn(turn)}>
                    <RotateCcw size={12} /> Retry response
                  </button>
                </>
              )}
            </div>
          ))}
          {chat.historyError ? (
            <div className="sunfire-history-error" role="alert">
              <p>Conversation history could not be loaded.</p>
              <button
                onClick={() => {
                  void chat.chat.refetch();
                  void chat.chats.refetch();
                }}
              >
                Retry history
              </button>
            </div>
          ) : null}
        </div>
        <form
          className="sunfire-composer"
          onSubmit={(event) => {
            event.preventDefault();
            if (canSend) void send();
          }}
        >
          <div className="sunfire-connection" role="status" aria-live="polite">
            {chat.status.isFetching && !chat.status.data ? (
              <>
                <LoaderCircle size={12} className="spin" /> Connecting to
                Sunfire…
              </>
            ) : chat.status.error ? (
              <>
                <span>Assistant connection unavailable.</span>
                <button
                  type="button"
                  onClick={() => void chat.status.refetch()}
                >
                  Retry
                </button>
              </>
            ) : chat.status.data?.available === false ? (
              <>
                <span>
                  {chat.status.data.reason ||
                    "Sunfire is not available. Configuration and simulations still work."}
                </span>
                <button
                  type="button"
                  onClick={() => void chat.status.refetch()}
                >
                  Check again
                </button>
              </>
            ) : openingError ? (
              openingError
            ) : chat.sending ? (
              "Sending your request…"
            ) : chat.pending ? (
              "Working on your request"
            ) : (
              "Uses the current draft and recorded results"
            )}
          </div>
          {chat.error ? (
            <p className="sunfire-inline-error" role="alert">
              {chat.error}
            </p>
          ) : null}
          <div className="sunfire-compose-input">
            <Textarea
              ref={composer}
              autosize
              minRows={2}
              maxRows={4}
              aria-label="Message Sunfire"
              placeholder="Ask about this hospital or describe a change…"
              value={input}
              maxLength={8000}
              onChange={(event) => setInput(event.currentTarget.value)}
              onKeyDown={(event) => {
                if (
                  event.key === "Enter" &&
                  !event.shiftKey &&
                  !event.nativeEvent.isComposing
                ) {
                  event.preventDefault();
                  if (canSend) void send();
                }
              }}
            />
            <Tooltip label="Send message">
              <ActionIcon
                type="submit"
                size={32}
                variant="filled"
                aria-label="Send Sunfire message"
                disabled={!canSend || !input.trim()}
              >
                {chat.sending ? (
                  <LoaderCircle size={15} className="spin" />
                ) : (
                  <ArrowUp size={16} />
                )}
              </ActionIcon>
            </Tooltip>
          </div>
          <div className="sunfire-composer-help">
            <span>Enter to send · Shift + Enter for a new line</span>
            <span>
              {ctx.canWrite === false
                ? "Editing unavailable"
                : "Draft changes can be undone"}
            </span>
          </div>
        </form>
      </aside>
    </>
  );
}
