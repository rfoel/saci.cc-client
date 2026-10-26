# saci.cc

Temporary email inboxes for end-to-end tests. Create an address on [saci.cc](https://saci.cc), use it to sign up in your app, and wait for the verification code or confirmation link.

Free, no account, no API key. No dependencies; works in Node 18+, Bun, Deno and browsers.

```bash
npm install --save-dev saci.cc
```

```ts
import { createInbox } from "saci.cc";

const inbox = await createInbox();
console.log(inbox.address); // a1b2c3d4e5f60718@saci.cc

// ...sign up with inbox.address...

const code = await inbox.waitForCode(); // "482913"
```

## Playwright

```ts
import { test, expect } from "@playwright/test";
import { createInbox } from "saci.cc";

test("sign up with a verification code", async ({ page }) => {
  test.setTimeout(90_000); // waiting for an email can take longer than the default 30 s

  const inbox = await createInbox();
  await page.goto("https://your-app.com/signup");
  await page.getByLabel("Email").fill(inbox.address);
  await page.getByLabel("Password").fill("correct horse battery staple");
  await page.getByRole("button", { name: "Sign up" }).click();

  const code = await inbox.waitForCode({ from: "your-app.com" });
  await page.getByLabel("Verification code").fill(code);
  await page.getByRole("button", { name: "Verify" }).click();
  await expect(page.getByText("Welcome")).toBeVisible();
});

test("reset a password", async ({ page }) => {
  test.setTimeout(90_000);

  const inbox = await createInbox();
  // ...create an account with inbox.address...

  const requestedAt = new Date();
  await page.goto("https://your-app.com/forgot-password");
  await page.getByLabel("Email").fill(inbox.address);
  await page.getByRole("button", { name: "Send link" }).click();

  // `after` skips the emails that were already in the inbox
  const link = await inbox.waitForLink({ match: "/reset-password", after: requestedAt });
  await page.goto(link);
  await page.getByLabel("New password").fill("another horse battery staple");
  await page.getByRole("button", { name: "Save" }).click();
});
```

## Cypress

Cypress tests run in the browser, so call saci from Node with tasks in `cypress.config.ts`:

```ts
import { defineConfig } from "cypress";
import { Saci } from "saci.cc";

const saci = new Saci();

export default defineConfig({
  e2e: {
    setupNodeEvents(on) {
      on("task", {
        createInbox: async () => (await saci.createInbox()).address,
        waitForCode: (address: string) => saci.inbox(address).waitForCode(),
        waitForLink: ({ address, match }: { address: string; match: string }) =>
          saci.inbox(address).waitForLink({ match }),
      });
    },
  },
});
```

```ts
it("signs up with a verification code", () => {
  cy.task<string>("createInbox").then((address) => {
    cy.visit("/signup");
    cy.get("input[name=email]").type(address);
    cy.get("input[name=password]").type("correct horse battery staple");
    cy.contains("button", "Sign up").click();

    // cy.task gives up after 60 s by default; give the email time to arrive
    cy.task<string>("waitForCode", address, { timeout: 90_000 }).then((code) => {
      cy.get("input[name=code]").type(code);
      cy.contains("button", "Verify").click();
      cy.contains("Welcome");
    });
  });
});
```

## API

### `createInbox(options?)`

Creates an inbox and returns an `Inbox`. Without `name` the address is random (16 hex characters), so nobody else can guess it. With `name: "signup-test"` you get `signup-test@saci.cc`, which anyone can read.

### `inbox.waitForCode(options?)`, `inbox.waitForLink(options?)`, `inbox.waitForEmail(options?)`

Wait for an email and return its verification code, a link in it, or the whole email. They keep waiting until something matches or the timeout runs out, then throw `SaciTimeoutError`.

| Option    | Description                                                                     |
| --------- | ------------------------------------------------------------------------------- |
| `from`    | Only emails whose sender contains this text (case-insensitive) or matches a RegExp |
| `subject` | Only emails whose subject contains this text (case-insensitive) or matches a RegExp |
| `after`   | Only emails received after this `Date` or ISO string                            |
| `timeout` | Milliseconds to wait. Default `60000`                                           |
| `match`   | `waitForLink` only: the link must contain this text or match a RegExp. Without it, the first link |

An email looks like this:

```ts
{
  messageId: "0100019a2b3c4d5e-...",
  from: "GitHub <noreply@github.com>",
  subject: "[GitHub] Please verify your email address",
  receivedAt: "2026-10-20T15:30:00.000Z",
  html: "<p>Your code is <b>482913</b></p>",
  text: "Your code is 482913",
  verificationCode: "482913", // or null
  links: ["https://github.com/settings/emails"],
  attachments: [{ index: 0, filename: "invoice.pdf", contentType: "application/pdf", size: 48213, inline: false, url: "https://..." }],
}
```

### Other methods

- `inbox.address`: the email address (`String(inbox)` gives the same).
- `inbox.list()`: summaries of the emails in the inbox, newest first.
- `inbox.get(messageId)`: one email in full.
- `inbox.delete(messageId)` and `inbox.clear()`: delete one email or all of them.
- `new Saci().inbox(address)`: an `Inbox` for an address created earlier.
- `new Saci({ baseUrl, fetch })`: point at another deployment or pass your own `fetch`.

Failed requests throw `SaciError`, which has the HTTP `status`.

## Limits

- 120 requests per minute per IP. The client waits and retries when it gets a 429.
- Emails are deleted about a day after they arrive.
- There are no passwords: anyone who knows an address can read its inbox. Don't use it for anything sensitive.
- Addresses only receive email.

The full HTTP API is documented at [saci.cc/en/docs](https://saci.cc/en/docs/). There's also an [MCP server](https://saci.cc/en/mcp/) for AI agents.

## Development

```bash
npm install
npm test
npm run build
```

Every push to `main` is released by [semantic-release](https://github.com/semantic-release/semantic-release): the version comes from the commit messages ([Conventional Commits](https://www.conventionalcommits.org/): `fix:` → patch, `feat:` → minor, `BREAKING CHANGE:` → major), and the package is published to npm with a GitHub release and a `CHANGELOG.md` entry.
