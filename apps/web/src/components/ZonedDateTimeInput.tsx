import { NativeSelect } from "@mantine/core";
import { useId, useState } from "react";
import {
  occurrenceLabel,
  utcMinute,
  utcToWall,
  wallTimeCandidates,
} from "../zonedTime";
import "./zonedDateTimeInput.css";

export function ZonedDateTimeInput({
  value,
  onChange,
  timeZone,
  label,
  disabled = false,
  required = false,
}: {
  value: string;
  onChange: (utcMinute: string) => void;
  timeZone: string;
  label: string;
  disabled?: boolean;
  required?: boolean;
}) {
  const id = useId();
  const [draft, setDraft] = useState({
    source: value,
    zone: timeZone,
    wall: utcToWall(value, timeZone),
  });
  const wall =
    draft.source === value && draft.zone === timeZone
      ? draft.wall
      : utcToWall(value, timeZone);
  const candidates = wallTimeCandidates(wall, timeZone);
  const invalid = Boolean(wall && !candidates.length);
  const selected = candidates.includes(utcMinute(value))
    ? utcMinute(value)
    : candidates[0] || "";
  return (
    <div className="zoned-date-time">
      <label htmlFor={id}>
        {label} <span>({timeZone})</span>
      </label>
      <input
        id={id}
        type="datetime-local"
        value={wall}
        disabled={disabled}
        required={required}
        aria-invalid={invalid || undefined}
        aria-describedby={invalid ? id + "-error" : undefined}
        onChange={(event) => {
          const nextWall = event.target.value;
          const choices = wallTimeCandidates(nextWall, timeZone);
          const next = choices.includes(utcMinute(value))
            ? utcMinute(value)
            : choices[0] || "";
          setDraft({ source: next, zone: timeZone, wall: nextWall });
          onChange(next);
        }}
      />
      {invalid && (
        <small id={id + "-error"} role="alert">
          This local time does not exist in {timeZone}. Choose a time outside
          the daylight saving clock change.
        </small>
      )}
      {candidates.length > 1 && (
        <label className="zoned-occurrence">
          Repeated hour
          <NativeSelect aria-label="Repeated hour"
            value={selected}
            disabled={disabled}
            onChange={(event) => {
              setDraft({ source: event.target.value, zone: timeZone, wall });
              onChange(event.target.value);
            }}
          >
            {candidates.map((candidate, index) => (
              <option key={candidate} value={candidate}>
                {index === 0 ? "First" : "Second"} occurrence ·{" "}
                {occurrenceLabel(candidate, timeZone)}
              </option>
            ))}
          </NativeSelect>
        </label>
      )}
    </div>
  );
}
