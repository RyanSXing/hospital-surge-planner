import { expect, test, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { api, capture, record } from "./helpers";

function credentials() {
  const env = readFileSync(
    process.env.E2E_AUTH_ENV_FILE || resolve(process.cwd(), "../../.env"),
    "utf8",
  );
  const value = (name: string) =>
    env
      .match(new RegExp(`^${name}=(.*)$`, "m"))?.[1]
      ?.trim()
      .replace(/^(["'])(.*)\1$/, "$2");
  const password = value("ADMIN_PASSWORD");
  if (!password)
    throw new Error(
      "A local ADMIN_PASSWORD is required for real form-login verification.",
    );
  return { username: value("ADMIN_USERNAME") || "admin", password };
}

function gate() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

/** Read actual painted geometry; do not replace or advance application animation. */
async function observeTransition(page: Page) {
  await page.addInitScript(() => {
    const proof = {
      phases: [] as string[],
      starts: 0,
      frames: [] as Array<{
        phase: string;
        x: number;
        y: number;
        width: number;
        height: number;
        at: number;
      }>,
    };
    (window as any).__aegisTransitionProof = proof;
    let previous: Element | null = null;
    const sample = () => {
      const overlay = document.querySelector(
        '[data-testid="brand-transition"]',
      );
      if (overlay && overlay !== previous) proof.starts++;
      previous = overlay;
      if (overlay) {
        const phase = overlay.getAttribute("data-phase") || "";
        if (proof.phases.at(-1) !== phase) proof.phases.push(phase);
        const logo = overlay.querySelector(
          '[data-testid="brand-transition-logo"]',
        );
        if (logo) {
          const bounds = logo.getBoundingClientRect();
          if (proof.frames.length < 1200)
            proof.frames.push({
              phase,
              x: bounds.x,
              y: bounds.y,
              width: bounds.width,
              height: bounds.height,
              at: performance.now(),
            });
        }
      }
    };
    new MutationObserver(sample).observe(document, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["data-phase"],
    });
    const frame = () => {
      sample();
      requestAnimationFrame(frame);
    };
    requestAnimationFrame(frame);
  });
}

async function realLoginNetwork(
  page: Page,
  options: { holdLogin?: boolean; holdWorkspace?: boolean } = {},
) {
  let authenticated = false;
  const loginGate = gate(),
    workspaceGate = gate();
  const control = {
    posts: 0,
    workspaceHeld: 0,
    statuses: [] as number[],
    releaseLogin: loginGate.release,
    releaseWorkspace: workspaceGate.release,
  };
  if (!options.holdLogin) loginGate.release();
  if (!options.holdWorkspace) workspaceGate.release();
  await page.route("**/api/auth/login", async (route) => {
    control.posts++;
    await loginGate.promise;
    // The real endpoint checks the actual credentials and creates its session.
    // Forward the original response, including its Set-Cookie headers.
    const response = await route.fetch();
    control.statuses.push(response.status());
    if (response.ok()) authenticated = true;
    await route.fulfill({ response });
  });
  await page.route(
    "**/api/workspaces/workspace-main/summary**",
    async (route) => {
      if (authenticated && options.holdWorkspace) {
        control.workspaceHeld++;
        await workspaceGate.promise;
      }
      await route.continue();
    },
  );
  return control;
}

async function signInScreen(page: Page) {
  await api(page.request, "/auth/logout", "POST", {});
  await page.goto("/");
  const login = page.locator(".login-page");
  await expect(
    login.getByRole("heading", { name: "Sign in", exact: true }),
  ).toBeVisible();
  await expect(
    login.getByRole("img", { name: "AEGIS", exact: true }),
  ).toBeVisible();
  await expect(
    login.getByLabel("Email or username", { exact: true }),
  ).toBeVisible();
  await expect(login.getByLabel("Password", { exact: true })).toBeVisible();
  await expect(login).not.toContainText(
    /Hospital Surge Planner|Sign in to hospital planning|Review capacity, forecast demand/i,
  );
  return login;
}

async function fillCredentials(page: Page) {
  const account = credentials();
  await page
    .getByLabel("Email or username", { exact: true })
    .fill(account.username);
  await page.getByLabel("Password", { exact: true }).fill(account.password);
}

async function proof(page: Page) {
  return page.evaluate(
    () =>
      (window as any).__aegisTransitionProof as {
        starts: number;
        phases: string[];
        frames: Array<{
          phase: string;
          x: number;
          y: number;
          width: number;
          height: number;
          at: number;
        }>;
      },
  );
}

test("AEGIS sign-in stays quiet on invalid credentials and transitions only after a successful retry", async ({
  page,
}, info) => {
  test.skip(
    info.project.name !== "desktop",
    "AEGIS sign-in is verified on desktop.",
  );
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await observeTransition(page);
  const network = await realLoginNetwork(page);
  const login = await signInScreen(page);
  await capture(page, "aegis-login", info);
  await page
    .getByLabel("Email or username", { exact: true })
    .fill(credentials().username);
  await page
    .getByLabel("Password", { exact: true })
    .fill("intentionally-invalid-aegis-test-password");
  await login.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(login.getByRole("alert")).toContainText(
    "Invalid sign-in credentials",
  );
  await expect(
    login.getByRole("button", { name: "Sign in", exact: true }),
  ).toBeEnabled();
  await expect(page.getByTestId("brand-transition")).toHaveCount(0);
  expect((await proof(page)).starts).toBe(0);
  await fillCredentials(page);
  await login.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page.getByTestId("brand-transition")).toBeVisible();
  await expect(page.getByTestId("brand-transition")).toHaveCount(0, {
    timeout: 20_000,
  });
  const header = page.getByRole("button", { name: "AEGIS home", exact: true });
  await expect(
    header.getByRole("img", { name: "AEGIS", exact: true }),
  ).toBeVisible();
  await expect(page.locator(".app-shell")).toBeVisible();
  await expect(page.locator(".login-page")).toHaveCount(0);
  const observed = await proof(page);
  expect(observed.starts).toBe(1);
  expect(observed.phases).toEqual(
    expect.arrayContaining(["growing", "holding", "settling"]),
  );
  expect(network.statuses).toEqual([401, 200]);
  await capture(page, "aegis-header", info);
  record("aegis-login-desktop", {
    real_login_statuses: network.statuses,
    invalid_credentials_did_not_animate: true,
    transition_starts: observed.starts,
    phases: observed.phases,
    header_logo_visible: true,
  });
});

test("AEGIS expansion holds for the real workspace response and duplicate submits do not restart it", async ({
  page,
}, info) => {
  test.skip(
    info.project.name !== "desktop",
    "AEGIS sign-in is verified on desktop.",
  );
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await observeTransition(page);
  const network = await realLoginNetwork(page, {
    holdLogin: true,
    holdWorkspace: true,
  });
  const login = await signInScreen(page);
  const original = await login
    .getByRole("img", { name: "AEGIS", exact: true })
    .boundingBox();
  expect(original).toBeTruthy();
  await fillCredentials(page);
  await login.getByRole("button", { name: "Sign in", exact: true }).click();
  try {
    await expect.poll(() => network.posts).toBe(1);
    await expect(
      login.getByRole("button", { name: "Signing in…", exact: true }),
    ).toBeDisabled();
    await expect(page.getByTestId("brand-transition")).toHaveCount(0);
    // A second native form submission also exercises the synchronous guard,
    // independently of the disabled submit button's protection.
    await login
      .locator("form")
      .evaluate((node) => (node as HTMLFormElement).requestSubmit());
    expect(network.posts).toBe(1);
    network.releaseLogin();
    await expect.poll(() => network.workspaceHeld).toBeGreaterThan(0);
    const overlay = page.getByTestId("brand-transition");
    await expect(overlay).toHaveAttribute("data-phase", "holding");
    const expanded = await overlay
      .getByTestId("brand-transition-logo")
      .boundingBox();
    expect(expanded).toBeTruthy();
    expect(expanded!.width).toBeGreaterThan(original!.width * 1.2);
    const viewport = page.viewportSize()!;
    expect(
      Math.abs(expanded!.x + expanded!.width / 2 - viewport.width / 2),
    ).toBeLessThan(12);
    // The wordmark sits below the large symbol; their combined artwork is centered.
    expect(expanded!.y + expanded!.height / 2).toBeGreaterThan(
      viewport.height * 0.4,
    );
    expect(expanded!.y + expanded!.height / 2).toBeLessThan(
      viewport.height * 0.75,
    );
    await capture(page, "aegis-expanded-holding", info);
    await expect(overlay).toHaveAttribute("data-phase", "holding");
    expect(network.posts).toBe(1);
    network.releaseWorkspace();
    await expect(overlay).toHaveCount(0, { timeout: 20_000 });
    const headerLogo = page
      .getByRole("button", { name: "AEGIS home", exact: true })
      .getByRole("img", { name: "AEGIS", exact: true });
    await expect(headerLogo).toBeVisible();
    const destination = (await headerLogo.boundingBox())!,
      observed = await proof(page);
    const settling = observed.frames.filter(
      (frame) => frame.phase === "settling",
    );
    expect(settling.length).toBeGreaterThan(2);
    const last = settling.at(-1)!;
    expect(
      Math.abs(last.x + last.width / 2 - destination.x - destination.width / 2),
    ).toBeLessThan(24);
    expect(
      Math.abs(
        last.y + last.height / 2 - destination.y - destination.height / 2,
      ),
    ).toBeLessThan(24);
    expect(Math.abs(last.width - destination.width)).toBeLessThan(24);
    expect(observed.starts).toBe(1);
    expect(network.statuses).toEqual([200]);
    record("aegis-transition-desktop", {
      real_login_posts: network.posts,
      delayed_workspace_reads: network.workspaceHeld,
      original_logo: original,
      expanded_logo: expanded,
      header_logo: destination,
      phases: observed.phases,
      last_settling_frame: last,
      one_transition_for_successful_authentication: true,
    });
  } finally {
    network.releaseLogin();
    network.releaseWorkspace();
  }
});

test("reduced-motion sign-in avoids zoom and existing-session reloads or navigation do not animate", async ({
  page,
}, info) => {
  test.skip(
    info.project.name !== "desktop",
    "AEGIS sign-in is verified on desktop.",
  );
  await page.emulateMedia({ reducedMotion: "reduce" });
  await observeTransition(page);
  const network = await realLoginNetwork(page);
  const login = await signInScreen(page);
  const original = (await login
    .getByRole("img", { name: "AEGIS", exact: true })
    .boundingBox())!;
  await fillCredentials(page);
  await login.getByRole("button", { name: "Sign in", exact: true }).click();
  const header = page.getByRole("button", { name: "AEGIS home", exact: true });
  await expect(
    header.getByRole("img", { name: "AEGIS", exact: true }),
  ).toBeVisible();
  await expect(page.getByTestId("brand-transition")).toHaveCount(0);
  const reduced = await proof(page);
  expect(
    Math.max(original.width, ...reduced.frames.map((frame) => frame.width)),
  ).toBeLessThanOrEqual(original.width * 1.15);
  await page.reload();
  await expect(page.locator(".app-shell")).toBeVisible();
  await expect(
    header.getByRole("img", { name: "AEGIS", exact: true }),
  ).toBeVisible();
  await expect(page.getByTestId("brand-transition")).toHaveCount(0);
  expect((await proof(page)).starts).toBe(0);
  await header.click();
  await expect(page.getByTestId("brand-transition")).toHaveCount(0);
  expect((await proof(page)).starts).toBe(0);
  expect(network.statuses).toEqual([200]);
  record("aegis-reduced-motion-desktop", {
    real_login_posts: network.posts,
    prefers_reduced_motion: true,
    maximum_logo_width: Math.max(
      original.width,
      ...reduced.frames.map((frame) => frame.width),
    ),
    login_logo_width: original.width,
    reload_and_navigation_transition_starts: (await proof(page)).starts,
  });
});
