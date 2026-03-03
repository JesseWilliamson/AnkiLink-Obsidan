import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RequestUrlResponse } from "obsidian";

const { requestUrlMock } = vi.hoisted(() => ({
    requestUrlMock: vi.fn(),
}));

vi.mock("obsidian", () => ({
    requestUrl: requestUrlMock,
}));

import { AnkiConnectClient } from "./client";

describe("AnkiConnectClient", () => {
    beforeEach(() => {
        requestUrlMock.mockReset();
    });

    it("sends the expected createDeck request payload", async () => {
        const response = {
            json: { error: null, result: 42 },
        } as RequestUrlResponse;
        requestUrlMock.mockResolvedValue(response);

        const client = new AnkiConnectClient({ url: "http://anki.test", version: 99 });
        const result = await client.createDeck("Deck A");

        expect(result).toEqual({ error: null, result: 42 });
        expect(requestUrlMock).toHaveBeenCalledTimes(1);
        expect(requestUrlMock).toHaveBeenCalledWith({
            url: "http://anki.test",
            method: "POST",
            body: JSON.stringify({
                action: "createDeck",
                version: 99,
                params: { deck: "Deck A" },
            }),
        });
    });

    it("rethrows errors from requestUrl", async () => {
        requestUrlMock.mockRejectedValue(new Error("Network down"));
        const client = new AnkiConnectClient();

        await expect(client.deckNames()).rejects.toThrow("Network down");
    });
});
