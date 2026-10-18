import AegisLogo from "./AegisLogo";
import { Button } from "./ui";
import "./sessionGate.css";

/** Keep workspace chrome out of the first paint until authentication is known. */
export default function SessionGate({
  failed = false,
  retry,
}: {
  failed?: boolean;
  retry: () => void;
}) {
  return (
    <main
      className="aegis-session-page"
      data-testid="session-check"
      aria-busy={!failed}
    >
      <section className="aegis-session-check">
        <AegisLogo className="aegis-session-logo" />
        {failed ? (
          <>
            <p role="alert">
              We couldn’t check your session. Please try again.
            </p>
            <Button onClick={retry}>Try again</Button>
          </>
        ) : (
          <p role="status">Opening AEGIS…</p>
        )}
      </section>
    </main>
  );
}
