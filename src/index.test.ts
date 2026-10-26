import { describe, expect, it } from "vitest";
import { Saci, SaciError, SaciTimeoutError, type Email } from "./index";

const ADDRESS = "a1b2c3d4e5f60718@saci.cc";

function email(id: string, fields: Partial<Email> = {}): Email {
  return {
    messageId: id,
    from: "GitHub <noreply@github.com>",
    subject: "Your code",
    receivedAt: "2026-10-20T15:30:00.000Z",
    html: null,
    text: null,
    verificationCode: null,
    links: [],
    attachments: [],
    ...fields,
  };
}

// A fake API. Each list request returns the next batch from `arrivals` (or the last one),
// as if those emails had arrived while the request was waiting.
function fakeApi(arrivals: Email[][], responses: Response[] = []) {
  const requests: { method: string; url: URL }[] = [];
  let listCalls = 0;
  const fetch = async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    requests.push({ method, url });
    const queued = responses.shift();
    if (queued) return queued;

    const path = url.pathname.replace("/api", "");
    if (method === "POST" && path === "/addresses") {
      const name = url.searchParams.get("name");
      return Response.json({ address: name ? `${name}@saci.cc` : ADDRESS }, { status: 201 });
    }
    const inbox = arrivals[Math.min(listCalls, arrivals.length - 1)] ?? [];
    const one = path.match(/\/emails\/(.+)$/);
    if (one) {
      const found = arrivals.flat().find((e) => e.messageId === decodeURIComponent(one[1]));
      return found ? Response.json(found) : Response.json({ error: "Email not found" }, { status: 404 });
    }
    listCalls++;
    return Response.json({ emails: inbox.map(({ messageId, from, subject, receivedAt }) => ({ messageId, from, subject, receivedAt })) });
  };
  return { saci: new Saci({ baseUrl: "https://saci.cc/api", fetch: fetch as typeof globalThis.fetch }), requests };
}

describe("createInbox", () => {
  it("creates a random inbox", async () => {
    const { saci, requests } = fakeApi([]);
    const inbox = await saci.createInbox();
    expect(inbox.address).toBe(ADDRESS);
    expect(String(inbox)).toBe(ADDRESS);
    expect(requests[0].method).toBe("POST");
  });

  it("passes a picked name", async () => {
    const { saci, requests } = fakeApi([]);
    const inbox = await saci.createInbox({ name: "signup-test" });
    expect(inbox.address).toBe("signup-test@saci.cc");
    expect(requests[0].url.searchParams.get("name")).toBe("signup-test");
  });
});

describe("waitForCode", () => {
  it("long-polls until an email with a code arrives", async () => {
    const welcome = email("m1", { subject: "Welcome", receivedAt: "2026-10-20T15:30:00.000Z" });
    const code = email("m2", { verificationCode: "482913", receivedAt: "2026-10-20T15:31:00.000Z" });
    const { saci, requests } = fakeApi([[], [welcome], [code, welcome]]);

    expect(await saci.inbox(ADDRESS).waitForCode()).toBe("482913");

    const lists = requests.filter((r) => r.url.pathname.endsWith("/emails"));
    expect(lists).toHaveLength(3);
    expect(lists[0].url.searchParams.get("wait")).toBe("25");
    expect(lists[0].url.searchParams.has("after")).toBe(false);
    // After seeing the welcome email it only waits for newer ones
    expect(lists[2].url.searchParams.get("after")).toBe("2026-10-20T15:30:00.000Z");
    // Each email is opened once
    expect(requests.filter((r) => r.url.pathname.endsWith("/emails/m1"))).toHaveLength(1);
  });

  it("ignores emails received before `after`", async () => {
    const old = email("m1", { verificationCode: "111111", receivedAt: "2026-10-20T15:00:00.000Z" });
    const fresh = email("m2", { verificationCode: "222222", receivedAt: "2026-10-20T16:00:00.000Z" });
    const { saci, requests } = fakeApi([[old], [fresh, old]]);

    const code = await saci.inbox(ADDRESS).waitForCode({ after: new Date("2026-10-20T15:30:00.000Z") });
    expect(code).toBe("222222");
    expect(requests[0].url.searchParams.get("after")).toBe("2026-10-20T15:30:00.000Z");
    expect(requests.some((r) => r.url.pathname.endsWith("/emails/m1"))).toBe(false);
  });

  it("times out", async () => {
    const { saci } = fakeApi([[]]);
    await expect(saci.inbox(ADDRESS).waitForCode({ timeout: 50 })).rejects.toThrow(SaciTimeoutError);
  });
});

describe("waitForEmail", () => {
  it("filters by sender and subject", async () => {
    const promo = email("m1", { from: "Store <promo@store.com>", subject: "Sale" });
    const reset = email("m2", { from: "App <no-reply@app.com>", subject: "Reset your password" });
    const { saci, requests } = fakeApi([[reset, promo]]);

    const found = await saci.inbox(ADDRESS).waitForEmail({ from: "APP.com", subject: /reset/i });
    expect(found.messageId).toBe("m2");
    expect(requests.some((r) => r.url.pathname.endsWith("/emails/m1"))).toBe(false);
  });
});

describe("waitForLink", () => {
  it("returns the first link that matches", async () => {
    const links = ["https://app.com/logo.png", "https://app.com/confirm?token=abc", "https://app.com/unsubscribe"];
    const { saci } = fakeApi([[email("m1", { links })]]);
    const inbox = saci.inbox(ADDRESS);
    expect(await inbox.waitForLink({ match: "/confirm" })).toBe("https://app.com/confirm?token=abc");
    expect(await inbox.waitForLink()).toBe("https://app.com/logo.png");
  });
});

describe("errors", () => {
  it("retries after a 429", async () => {
    const limited = new Response(JSON.stringify({ error: "Too many requests" }), { status: 429, headers: { "Retry-After": "0" } });
    const { saci, requests } = fakeApi([[email("m1", { verificationCode: "4321" })]], [limited]);
    expect(await saci.inbox(ADDRESS).waitForCode()).toBe("4321");
    expect(requests[0].url.pathname).toBe(requests[1].url.pathname);
  });

  it("throws the API error with its status", async () => {
    const { saci } = fakeApi([[]]);
    const error = await saci
      .inbox(ADDRESS)
      .get("missing")
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(SaciError);
    expect(error).toMatchObject({ status: 404, message: expect.stringContaining("Email not found") });
  });
});
