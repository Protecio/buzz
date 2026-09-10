import { createHash } from "node:crypto";
import { expect, test } from "@playwright/test";

test("home page loads with Buzz branding", async ({ page }) => {
  await page.goto("/");
  await expect(
    page.getByRole("main").getByRole("img", { name: "Buzz" }),
  ).toBeVisible();
});

test("home page shows repositories section", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByText("Repositories")).toBeVisible();
});

test("invite requires age and legal consent before opening Buzz", async ({
  page,
}) => {
  await page.route("**/api/join-policy", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        policy: {
          terms_markdown: "# Terms",
          privacy_markdown: "# Privacy",
          age_attestation_required: true,
          version: "policy-v1",
        },
      }),
    });
  });
  await page.route("https://api.github.com/**", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      headers: { "Access-Control-Allow-Origin": "*" },
      body: JSON.stringify([
        { draft: false, prerelease: false, assets: [] },
        {
          draft: false,
          prerelease: false,
          assets: [
            {
              name: "Buzz_0.4.9_aarch64.dmg",
              browser_download_url:
                "https://github.com/block/buzz/releases/download/v0.4.9/Buzz_0.4.9_aarch64.dmg",
            },
            {
              name: "Buzz_0.4.9_x64.dmg",
              browser_download_url:
                "https://github.com/block/buzz/releases/download/v0.4.9/Buzz_0.4.9_x64.dmg",
            },
            {
              name: "Buzz_0.4.9_amd64.AppImage",
              browser_download_url:
                "https://github.com/block/buzz/releases/download/v0.4.9/Buzz_0.4.9_amd64.AppImage",
            },
            {
              name: "Buzz_0.4.9_x64-setup_alpha-unsigned.exe",
              browser_download_url:
                "https://github.com/block/buzz/releases/download/v0.4.9/Buzz_0.4.9_x64-setup_alpha-unsigned.exe",
            },
          ],
        },
      ]),
    });
  });
  await page.goto("/invite/demo-code");

  await expect(
    page.getByText("Your protected browser identity stays on this device."),
  ).toBeVisible();
  await expect(page.getByRole("link", { name: "Download it now" })).toHaveCount(
    0,
  );

  const ageConfirmation = page.getByLabel("I am 18 years of age or older.");
  const agreementConfirmation = page.getByLabel(
    "I agree to the Buzz Terms of Service and Privacy Policy.",
  );
  const acceptInvite = page.getByRole("button", {
    name: "Accept invite in Buzz",
  });

  await expect(ageConfirmation).toBeVisible();
  await expect(agreementConfirmation).toBeVisible();
  await expect(acceptInvite).toBeDisabled();

  const termsLink = page.getByRole("button", { name: "Terms of Service" });
  const privacyLink = page.getByRole("button", { name: "Privacy Policy" });
  await expect(termsLink).toHaveCSS("text-decoration-line", "none");
  await expect(privacyLink).toHaveCSS("text-decoration-line", "none");
  await termsLink.hover();
  await expect(termsLink).toHaveCSS("text-decoration-line", "underline");
  await page.mouse.move(0, 0);
  await privacyLink.hover();
  await expect(privacyLink).toHaveCSS("text-decoration-line", "underline");

  await page
    .locator("label")
    .filter({ hasText: "I am 18 years of age or older." })
    .click();
  await expect(ageConfirmation).toBeChecked();
  await expect(acceptInvite).toBeDisabled();
  await page
    .locator("label")
    .filter({
      hasText: "I agree to the Buzz Terms of Service and Privacy Policy.",
    })
    .click({ position: { x: 8, y: 8 } });
  await expect(agreementConfirmation).toBeChecked();
  await expect(acceptInvite).toBeEnabled();

  const consentBox = await page
    .getByTestId("invite-join-policy-notice")
    .boundingBox();
  const acceptButtonBox = await acceptInvite.boundingBox();
  expect(consentBox?.y).toBeLessThan(acceptButtonBox?.y ?? 0);
  expect(consentBox?.width).toBe(acceptButtonBox?.width);
});

test("invite can enroll a durable local identity for browser access", async ({
  page,
}) => {
  await page.addInitScript(() => {
    Object.defineProperty(window, "PublicKeyCredential", {
      configurable: true,
      value: undefined,
    });
  });
  await page.route("**/api/join-policy", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ policy: null }),
    });
  });

  const claimedPubkeys: string[] = [];
  await page.route("**/api/invites/claim", async (route) => {
    const request = route.request();
    const body = request.postData() ?? "";
    expect(JSON.parse(body).code).toMatch(/^browser-code/);

    const authorization = request.headers().authorization;
    expect(authorization).toMatch(/^Nostr /);
    const event = JSON.parse(
      Buffer.from(authorization.slice("Nostr ".length), "base64").toString(
        "utf8",
      ),
    ) as {
      pubkey: string;
      tags: string[][];
    };
    expect(event.pubkey).toMatch(/^[0-9a-f]{64}$/);
    claimedPubkeys.push(event.pubkey);
    expect(event.tags).toContainEqual(["u", request.url()]);
    expect(event.tags).toContainEqual(["method", "POST"]);
    expect(event.tags).toContainEqual([
      "payload",
      createHash("sha256").update(body).digest("hex"),
    ]);

    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        status: "joined",
        community_id: "community-id",
        host: "127.0.0.1",
        role: "member",
      }),
    });
  });

  await page.goto("/invite/browser-code");
  await page.getByRole("button", { name: "Join in browser" }).click();
  await expect(page).toHaveURL("/");
  await page.goto("/invite/browser-code-after-reload");
  await page.getByRole("button", { name: "Join in browser" }).click();
  await expect(page).toHaveURL("/");
  expect(claimedPubkeys).toHaveLength(2);
  expect(claimedPubkeys[1]).toBe(claimedPubkeys[0]);
});

test("invite derives a recoverable identity from a passkey without storing its secret", async ({
  page,
}) => {
  await page.addInitScript(() => {
    const credentialId = new Uint8Array([80, 82, 79, 84, 69, 67, 73, 79]);
    const prfResult = new Uint8Array(32).fill(17);
    const MockPublicKeyCredential = function MockPublicKeyCredential() {};
    Object.defineProperty(MockPublicKeyCredential, "getClientCapabilities", {
      value: async () => ({ "extension:prf": true }),
    });
    const credential = () => ({
      rawId: credentialId.slice().buffer,
      getClientExtensionResults: () => ({
        prf: {
          enabled: true,
          results: { first: prfResult.slice().buffer },
        },
      }),
    });
    Object.defineProperty(window, "PublicKeyCredential", {
      configurable: true,
      value: MockPublicKeyCredential,
    });
    Object.defineProperty(navigator, "credentials", {
      configurable: true,
      value: {
        create: async () => credential(),
        get: async () => credential(),
      },
    });
  });
  await page.route("**/api/join-policy", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ policy: null }),
    });
  });

  const claimedPubkeys: string[] = [];
  await page.route("**/api/invites/claim", async (route) => {
    const authorization = route.request().headers().authorization;
    expect(authorization).toMatch(/^Nostr /);
    const event = JSON.parse(
      Buffer.from(authorization.slice("Nostr ".length), "base64").toString(
        "utf8",
      ),
    ) as { pubkey: string };
    claimedPubkeys.push(event.pubkey);
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        status: "joined",
        community_id: "community-id",
        host: "127.0.0.1",
        role: "member",
      }),
    });
  });

  await page.goto("/invite/passkey-code");
  await page.getByRole("button", { name: "Join in browser" }).click();
  await expect(page).toHaveURL("/");
  await page.goto("/invite/passkey-code-after-reload");
  await expect(
    page.getByText(
      "Your passkey protects this browser identity across your synced devices.",
    ),
  ).toBeVisible();
  await page.getByRole("button", { name: "Join in browser" }).click();
  await expect(page).toHaveURL("/");

  await page.evaluate(
    () =>
      new Promise<void>((resolve, reject) => {
        const request = indexedDB.deleteDatabase("buzz-browser-identity-v1");
        request.onsuccess = () => resolve();
        request.onerror = () => reject(request.error);
      }),
  );
  await page.goto("/invite/passkey-code-on-new-device");
  await page.getByRole("button", { name: "Use an existing passkey" }).click();
  await expect(
    page.getByText(
      "Your passkey protects this browser identity across your synced devices.",
    ),
  ).toBeVisible();
  await page.getByRole("button", { name: "Join in browser" }).click();
  await expect(page).toHaveURL("/");

  expect(claimedPubkeys).toHaveLength(3);
  expect(claimedPubkeys[1]).toBe(claimedPubkeys[0]);
  expect(claimedPubkeys[2]).toBe(claimedPubkeys[0]);
  const storedRecordIds = await page.evaluate(
    () =>
      new Promise<string[]>((resolve, reject) => {
        const request = indexedDB.open("buzz-browser-identity-v1", 2);
        request.onsuccess = () => {
          const database = request.result;
          const transaction = database.transaction("identity", "readonly");
          const records = transaction.objectStore("identity").getAll();
          records.onsuccess = () => {
            database.close();
            resolve(
              (records.result as Array<{ id: string }>).map(
                (record) => record.id,
              ),
            );
          };
          records.onerror = () => reject(records.error);
        };
        request.onerror = () => reject(request.error);
      }),
  );
  expect(storedRecordIds).toEqual(["identity-metadata-v2"]);
});

test("invite does not silently downgrade when passkey verification is cancelled", async ({
  page,
}) => {
  await page.addInitScript(() => {
    const MockPublicKeyCredential = function MockPublicKeyCredential() {};
    Object.defineProperty(MockPublicKeyCredential, "getClientCapabilities", {
      value: async () => ({ "extension:prf": true }),
    });
    Object.defineProperty(window, "PublicKeyCredential", {
      configurable: true,
      value: MockPublicKeyCredential,
    });
    Object.defineProperty(navigator, "credentials", {
      configurable: true,
      value: {
        create: async () => {
          throw new DOMException("Cancelled", "NotAllowedError");
        },
        get: async () => {
          throw new DOMException("Cancelled", "NotAllowedError");
        },
      },
    });
  });
  await page.route("**/api/join-policy", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ policy: null }),
    });
  });

  await page.goto("/invite/passkey-cancelled");
  await page.getByRole("button", { name: "Join in browser" }).click();
  await expect(
    page.getByRole("alert").getByText("Passkey verification was cancelled."),
  ).toBeVisible();
  const databaseNames = await page.evaluate(async () =>
    (await indexedDB.databases()).map((database) => database.name),
  );
  expect(databaseNames).toContain("buzz-browser-identity-v1");
  const storedRecords = await page.evaluate(
    () =>
      new Promise<number>((resolve, reject) => {
        const request = indexedDB.open("buzz-browser-identity-v1", 2);
        request.onsuccess = () => {
          const database = request.result;
          const count = database
            .transaction("identity", "readonly")
            .objectStore("identity")
            .count();
          count.onsuccess = () => {
            database.close();
            resolve(count.result);
          };
          count.onerror = () => reject(count.error);
        };
        request.onerror = () => reject(request.error);
      }),
  );
  expect(storedRecords).toBe(0);
});

test("invite stays browser-first on Safari-compatible devices", async ({
  browser,
}) => {
  const context = await browser.newContext({
    userAgent:
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Version/26.5 Safari/605.1.15",
  });
  await context.addInitScript(() => {
    Object.defineProperties(navigator, {
      platform: { configurable: true, value: "MacIntel" },
      maxTouchPoints: { configurable: true, value: 0 },
      userAgentData: { configurable: true, value: undefined },
    });
  });
  const page = await context.newPage();
  await page.route("**/api/join-policy", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ policy: null }),
    });
  });
  await page.goto("/invite/demo-code");
  await expect(
    page.getByRole("button", { name: "Join in browser" }),
  ).toBeVisible();
  await expect(
    page.getByText("Your protected browser identity stays on this device."),
  ).toBeVisible();
  await expect(page.getByRole("link", { name: "Download it now" })).toHaveCount(
    0,
  );
  await context.close();
});

test("invite stays browser-first on mobile and ChromeOS", async ({
  browser,
}) => {
  const unsupportedDevices = [
    {
      name: "iPhone Safari",
      platform: "iPhone",
      userAgent:
        "Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15",
      maxTouchPoints: 5,
    },
    {
      name: "iPadOS desktop mode",
      platform: "MacIntel",
      userAgent:
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15) AppleWebKit/605.1.15",
      maxTouchPoints: 5,
    },
    {
      name: "Android phone",
      platform: "Linux armv8l",
      userAgent:
        "Mozilla/5.0 (Linux; Android 15; Pixel 9 Pro) AppleWebKit/537.36 Mobile",
      maxTouchPoints: 5,
    },
    {
      name: "ChromeOS",
      platform: "Linux x86_64",
      userAgent: "Mozilla/5.0 (X11; CrOS x86_64 16093.68.0) AppleWebKit/537.36",
      maxTouchPoints: 0,
    },
  ];

  for (const device of unsupportedDevices) {
    const context = await browser.newContext({ userAgent: device.userAgent });
    await context.addInitScript(({ platform, maxTouchPoints }) => {
      Object.defineProperties(navigator, {
        platform: { configurable: true, value: platform },
        maxTouchPoints: { configurable: true, value: maxTouchPoints },
        userAgentData: {
          configurable: true,
          value: { platform, mobile: maxTouchPoints > 0 },
        },
      });
    }, device);
    const page = await context.newPage();
    await page.route("**/api/join-policy", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ policy: null }),
      });
    });
    await page.goto("/invite/demo-code");
    await expect(
      page.getByRole("button", { name: "Join in browser" }),
      device.name,
    ).toBeVisible();
    await expect(
      page.getByRole("link", { name: "Download it now" }),
      device.name,
    ).toHaveCount(0);
    await context.close();
  }
});
