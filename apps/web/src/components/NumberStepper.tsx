import { useRef } from "react";
import {
  ActionIcon,
  NumberInput,
  type NumberInputHandlers,
  type NumberInputProps,
} from "@mantine/core";
import { Minus, Plus } from "lucide-react";
import "./numberStepper.css";

type Props = Omit<
  NumberInputProps,
  "handlersRef" | "hideControls" | "leftSection" | "rightSection"
>;

/** Keep Mantine's editing, clamping and arrow keys with clearer step controls. */
export default function NumberStepper(props: Props) {
  const handlers = useRef<NumberInputHandlers>(null);
  const label =
    props["aria-label"] ||
    (typeof props.label === "string" ? props.label : "value");
  const value =
    props.value === "" || props.value === undefined ? NaN : Number(props.value);
  const locked = props.disabled || props.readOnly;
  return (
    <NumberInput
      {...props}
      className={["number-stepper", props.className].filter(Boolean).join(" ")}
      handlersRef={handlers}
      hideControls
      leftSectionWidth={32}
      rightSectionWidth={32}
      leftSectionPointerEvents="auto"
      rightSectionPointerEvents="auto"
      leftSection={
        <ActionIcon
          type="button"
          variant="subtle"
          className="number-stepper-button"
          size={26}
          tabIndex={-1}
          aria-label={`Decrease ${label}`}
          disabled={locked || (props.min !== undefined && value <= props.min)}
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => handlers.current?.decrement()}
        >
          <Minus size={14} strokeWidth={1.8} />
        </ActionIcon>
      }
      rightSection={
        <ActionIcon
          type="button"
          variant="subtle"
          className="number-stepper-button"
          size={26}
          tabIndex={-1}
          aria-label={`Increase ${label}`}
          disabled={locked || (props.max !== undefined && value >= props.max)}
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => handlers.current?.increment()}
        >
          <Plus size={14} strokeWidth={1.8} />
        </ActionIcon>
      }
    />
  );
}
