import { useRef, useState } from "react";
import { PasswordInput, TextInput } from "@mantine/core";
import { post } from "../api";
import { Button, ErrorBox } from "./ui";
import AegisLogo from "./AegisLogo";
import "./login.css";

export interface LogoOrigin {
  left: number;
  top: number;
  width: number;
  height: number;
}

export default function Login({
  onLogin,
  blocked = false,
}: {
  onLogin: (origin: LogoOrigin) => Promise<void>;
  blocked?: boolean;
}) {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);
  const submitting = useRef(false);
  const logo = useRef<SVGSVGElement>(null);
  return (
    <main className="login-page aegis-login-page" inert={blocked}>
      <section
        className="login-card aegis-login-card"
        aria-labelledby="sign-in-title"
      >
        <AegisLogo ref={logo} className="aegis-login-logo" />
        <h1 id="sign-in-title">Sign in</h1>
        <form
          aria-busy={pending}
          onSubmit={async (event) => {
            event.preventDefault();
            if (submitting.current) return;
            submitting.current = true;
            setPending(true);
            setError("");
            try {
              await post("/auth/login", {
                email: username,
                username,
                password,
              });
              const bounds = logo.current!.getBoundingClientRect();
              await onLogin({
                left: bounds.left,
                top: bounds.top,
                width: bounds.width,
                height: bounds.height,
              });
            } catch (failure) {
              setError(
                failure instanceof Error ? failure.message : String(failure),
              );
            } finally {
              submitting.current = false;
              setPending(false);
            }
          }}
        >
          <label>
            Email or username
            <TextInput
              aria-label="Email or username"
              autoComplete="username"
              value={username}
              onChange={(event) => setUsername(event.target.value)}
              required
              disabled={pending}
            />
          </label>
          <label>
            Password
            <PasswordInput
              aria-label="Password"
              autoComplete="current-password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              required
              disabled={pending}
            />
          </label>
          {error ? <ErrorBox error={error} /> : null}
          <Button primary type="submit" disabled={pending}>
            {pending ? "Signing in…" : "Sign in"}
          </Button>
        </form>
      </section>
    </main>
  );
}
