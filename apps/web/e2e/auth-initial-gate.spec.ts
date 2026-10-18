import { expect, test, type Page } from "@playwright/test";
import { api, capture, login, record } from "./helpers";

function gate() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => (release = resolve));
  return { promise, release };
}

async function observeFirstPaint(page: Page) {
  await page.addInitScript(() => {
    const audit = { loginSeen: false, shellBeforeLogin: false, loginPaints: 0 };
    (window as any).__initialAuthAudit = audit;
    const sample = () => {
      if (document.querySelector(".login-page")) {
        audit.loginSeen = true;
        audit.loginPaints++;
      }
      if (!audit.loginSeen && document.querySelector(".app-shell"))
        audit.shellBeforeLogin = true;
    };
    new MutationObserver(sample).observe(document, {
      childList: true,
      subtree: true,
    });
    const frame = () => {
      sample();
      requestAnimationFrame(frame);
    };
    requestAnimationFrame(frame);
  });
}

test("an unknown signed-out session never paints console chrome before Sign in", async ({
  page,
}, info) => {
  test.skip(
    info.project.name !== "desktop",
    "Desktop authentication regression.",
  );
  await api(page.request, "/auth/logout", "POST", {});
  await observeFirstPaint(page);
  const held = gate();
  let summaries = 0;
  page.on("request", (request) => {
    if (request.url().includes("/api/workspaces/workspace-main/summary"))
      summaries++;
  });
  await page.route("**/api/me", async (route) => {
    await held.promise;
    const response = await route.fetch();
    expect(response.status()).toBe(401);
    await route.fulfill({ response });
  });
  try {
    await page.goto("/");
    await expect(page.getByTestId("session-check")).toBeVisible();
    await expect(page.locator(".app-shell")).toHaveCount(0);
    expect(summaries).toBe(0);
    held.release();
    await expect(
      page.getByRole("heading", { name: "Sign in", exact: true }),
    ).toBeVisible();
    await expect(page.locator(".app-shell")).toHaveCount(0);
    expect(summaries).toBe(0);
    const proof = await page.evaluate(() => (window as any).__initialAuthAudit);
    expect(proof.loginSeen).toBe(true);
    expect(proof.shellBeforeLogin).toBe(false);
    await capture(page, "auth-no-console-flash", info);
    record("auth-no-console-flash", {
      ...proof,
      protected_summary_requests: summaries,
    });
  } finally {
    held.release();
  }
});

test("an existing session waits for authentication without flashing the sign-in form", async ({
  page,
}, info) => {
  test.skip(
    info.project.name !== "desktop",
    "Desktop authentication regression.",
  );
  await login(page);
  await observeFirstPaint(page);
  const held = gate();
  await page.route("**/api/me", async (route) => {
    await held.promise;
    const response = await route.fetch();
    expect(response.status()).toBe(200);
    await route.fulfill({ response });
  });
  try {
    await page.goto("/");
    await expect(page.getByTestId("session-check")).toBeVisible();
    await expect(page.locator(".app-shell,.login-page")).toHaveCount(0);
    held.release();
    await expect(page.locator(".app-shell")).toBeVisible();
    await expect(page.locator(".login-page")).toHaveCount(0);
    expect(
      (await page.evaluate(() => (window as any).__initialAuthAudit))
        .loginPaints,
    ).toBe(0);
    await expect(page.getByTestId("brand-transition")).toHaveCount(0);
    record("auth-existing-session-gate", {
      no_login_form_painted: true,
      no_brand_transition: true,
    });
  } finally {
    held.release();
  }
});

test("an unavailable session check offers recovery without exposing the console", async ({
  page,
}, info) => {
  test.skip(
    info.project.name !== "desktop",
    "Desktop authentication regression.",
  );
  await api(page.request, "/auth/logout", "POST", {});
  let checks = 0;
  await page.route("**/api/me", async (route) => {
    checks++;
    if (checks === 1) {
      await route.fulfill({
        status: 503,
        json: { error: { message: "Session service unavailable" } },
      });
    } else {
      const response = await route.fetch();
      expect(response.status()).toBe(401);
      await route.fulfill({ response });
    }
  });
  await page.goto("/");
  await expect(page.getByRole("alert")).toContainText(
    "We couldn’t check your session",
  );
  expect(checks).toBe(1);
  await expect(page.locator(".app-shell,.login-page")).toHaveCount(0);
  await page.getByRole("button", { name: "Try again", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Sign in", exact: true }),
  ).toBeVisible();
  expect(checks).toBe(2);
  await expect(page.locator(".app-shell")).toHaveCount(0);
  record("auth-session-check-recovery", {
    attempts: checks,
    console_hidden_until_authenticated: true,
  });
});
