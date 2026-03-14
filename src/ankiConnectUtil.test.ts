import { afterEach, describe, expect, it, vi } from "vitest";
import { defaultAnkiConnectClient } from "./anki-connect/client";
import { addTagToNotes, findNoteIdsByTagInDeck, getNoteById, noteHasTag } from "./ankiConnectUtil";
import type { NoteInfo } from "./anki-connect/types";

const { requestUrlMock } = vi.hoisted(() => ({
    requestUrlMock: vi.fn(),
}));

vi.mock("obsidian", () => ({
    requestUrl: requestUrlMock,
}));

describe("ankiConnectUtil", () => {
    afterEach(() => {
        vi.restoreAllMocks();
    });

    it("noteHasTag compares tags case-insensitively", () => {
        const note = {
            noteId: 1,
            modelName: "AnkiLink Basic",
            tags: ["AnKiLiNk"],
            cards: [101],
            fields: {
                Front: { value: "A", order: 0 },
                Back: { value: "B", order: 1 },
            },
        } satisfies NoteInfo;

        expect(noteHasTag(note)).toBe(true);
        expect(noteHasTag(note, "ANKILINK")).toBe(true);
        expect(noteHasTag(note, "different-tag")).toBe(false);
    });

    it("addTagToNotes is a no-op for empty note lists", async () => {
        const addTagsSpy = vi.spyOn(defaultAnkiConnectClient, "addTags");

        await addTagToNotes([]);

        expect(addTagsSpy).not.toHaveBeenCalled();
    });

    it("findNoteIdsByTagInDeck escapes quotes in deck names", async () => {
        const findNotesSpy = vi
            .spyOn(defaultAnkiConnectClient, "findNotes")
            .mockResolvedValue({ error: null, result: [1, 2, 3] });

        const result = await findNoteIdsByTagInDeck('Deck "A"');

        expect(result).toEqual([1, 2, 3]);
        expect(findNotesSpy).toHaveBeenCalledWith(String.raw`tag:ankiLink deck:"Deck \"A\""`);
    });

    it("getNoteById returns undefined for deleted-note placeholders", async () => {
        vi.spyOn(defaultAnkiConnectClient, "notesInfo").mockResolvedValue({
            error: null,
            result: [{}],
        });

        await expect(getNoteById(999)).resolves.toBeUndefined();
    });

    it("getNoteById throws when AnkiConnect returns an error", async () => {
        vi.spyOn(defaultAnkiConnectClient, "notesInfo").mockResolvedValue({
            error: "boom",
            result: [],
        });

        await expect(getNoteById(123)).rejects.toThrow("AnkiConnect boom");
    });
});
