import { afterEach, describe, expect, it, vi } from "vitest";
import {
  assertHttpOk,
  HttpParseError,
  HttpResponseError,
  httpClient,
} from "../../src/utils/httpClient.js";

function createFetchResponse(status, body, headers = {}) {
  return {
    status,
    headers: {
      forEach(callback) {
        for (const [name, value] of Object.entries(headers)) {
          callback(value, name);
        }
      },
    },
    text: async () => body,
  };
}

describe("httpClient", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("serializes JSON bodies and adds default headers", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(createFetchResponse(200, '{"ok":true}'));

    const response = await httpClient.post(
      "http://localhost:11434/api/chat",
      { message: "hello" },
      { headers: { Authorization: "Bearer token" }, mode: "local" },
    );

    expect(fetchMock).toHaveBeenCalledWith(
      "http://localhost:11434/api/chat",
      expect.objectContaining({
        method: "POST",
        body: '{"message":"hello"}',
        headers: expect.objectContaining({
          Accept: "application/json",
          "Content-Type": "application/json",
          Authorization: "Bearer token",
        }),
      }),
    );
    await expect(response.json()).resolves.toEqual({ ok: true });
  });

  it("throws a parse error for invalid JSON response bodies", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      createFetchResponse(200, "not-json"),
    );

    const response = await httpClient.get("http://localhost:11434/api/tags", {
      mode: "local",
    });

    await expect(response.json()).rejects.toBeInstanceOf(HttpParseError);
  });

  it("keeps API error details in assertHttpOk", async () => {
    const response = {
      status: 401,
      ok: false,
      headers: {},
      json: async () => ({ error: { message: "invalid api key" } }),
      text: async () => "invalid api key",
    };

    await expect(assertHttpOk("https://api.test", response)).rejects.toThrow(
      "invalid api key",
    );
    await expect(
      assertHttpOk("https://api.test", response),
    ).rejects.toBeInstanceOf(HttpResponseError);
  });

  it("returns false from ping when the request fails", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("offline"));

    await expect(
      httpClient.ping("http://localhost:11434", 10, { mode: "local" }),
    ).resolves.toBe(false);
  });
});
