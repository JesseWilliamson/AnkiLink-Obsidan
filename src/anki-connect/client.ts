import { requestUrl, RequestUrlParam, RequestUrlResponse } from "obsidian";
import { AnkiActionResponse, AnkiMultiAction, CreateModelInput, Note, NoteFields } from "./types";

const DEFAULT_ANKI_CONNECT_URL = "http://localhost:8765";
const DEFAULT_ANKI_CONNECT_VERSION = 6;
const REQUEST_LOG_PREFIX = "[anki-link][network]";

type AnkiAction =
    | "createDeck"
    | "createModel"
    | "addNote"
    | "addNotes"
    | "addTags"
    | "changeDeck"
    | "deckNames"
    | "modelNames"
    | "updateModelTemplates"
    | "updateModelStyling"
    | "findNotes"
    | "deleteNotes"
    | "notesInfo"
    | "updateNoteFields"
    | "multi";

interface AnkiConnectClientOptions {
    url?: string;
    version?: number;
}

export class AnkiConnectClient {
    private readonly url: string;
    private readonly version: number;

    constructor(options: AnkiConnectClientOptions = {}) {
        this.url = options.url ?? DEFAULT_ANKI_CONNECT_URL;
        this.version = options.version ?? DEFAULT_ANKI_CONNECT_VERSION;
    }

    private buildRequest(action: AnkiAction, params?: unknown): RequestUrlParam {
        return {
            url: this.url,
            method: "POST",
            body: JSON.stringify({ action, version: this.version, params }),
        };
    }

    private async send<T>(action: AnkiAction, params?: unknown): Promise<AnkiActionResponse<T>> {
        const request = this.buildRequest(action, params);
        const startedAt = Date.now();
        console.debug(`${REQUEST_LOG_PREFIX} -> ${request.method} ${request.url} action=${action}`);
        try {
            const response: RequestUrlResponse = await requestUrl(request);
            const elapsedMs = Date.now() - startedAt;
            const result = response.json as AnkiActionResponse<T>;
            const status = result.error ? "error" : "ok";
            console.debug(
                `${REQUEST_LOG_PREFIX} <- action=${action} status=${status} elapsedMs=${elapsedMs}`,
            );
            if (result.error) {
                console.debug(`${REQUEST_LOG_PREFIX} !! action=${action} error="${result.error}"`);
            }
            return result;
        } catch (error) {
            const elapsedMs = Date.now() - startedAt;
            console.debug(`${REQUEST_LOG_PREFIX} xx action=${action} threw elapsedMs=${elapsedMs}`);
            throw error;
        }
    }

    async deckNames(): Promise<AnkiActionResponse<string[]>> {
        return this.send<string[]>("deckNames");
    }

    async createDeck(deck: string): Promise<AnkiActionResponse<number>> {
        return this.send<number>("createDeck", { deck });
    }

    async modelNames(): Promise<AnkiActionResponse<string[]>> {
        return this.send<string[]>("modelNames");
    }

    async createModel(model: CreateModelInput): Promise<AnkiActionResponse<null>> {
        return this.send<null>("createModel", model);
    }

    async updateModelTemplates(
        modelName: string,
        templates: Record<string, { Front: string; Back: string }>,
    ): Promise<AnkiActionResponse<null>> {
        return this.send<null>("updateModelTemplates", {
            model: { name: modelName, templates },
        });
    }

    async updateModelStyling(modelName: string, css: string): Promise<AnkiActionResponse<null>> {
        return this.send<null>("updateModelStyling", {
            model: { name: modelName, css },
        });
    }

    async addNote(note: Note): Promise<AnkiActionResponse<number>> {
        return this.send<number>("addNote", { note });
    }

    async addNotes(notes: Note[]): Promise<AnkiActionResponse<(number | null)[]>> {
        return this.send<(number | null)[]>("addNotes", { notes });
    }

    async addTags(notes: number[], tags: string): Promise<AnkiActionResponse<null>> {
        return this.send<null>("addTags", { notes, tags });
    }

    async findNotes(query: string): Promise<AnkiActionResponse<number[]>> {
        return this.send<number[]>("findNotes", { query });
    }

    async deleteNotes(notes: number[]): Promise<AnkiActionResponse<null>> {
        return this.send<null>("deleteNotes", { notes });
    }

    async notesInfo(notes: number[]): Promise<AnkiActionResponse<unknown[]>> {
        return this.send<unknown[]>("notesInfo", { notes });
    }

    async updateNoteFields(id: number, fields: NoteFields): Promise<AnkiActionResponse<null>> {
        return this.send<null>("updateNoteFields", { note: { id, fields } });
    }

    async changeDeck(cards: number[], deck: string): Promise<AnkiActionResponse<null>> {
        return this.send<null>("changeDeck", { cards, deck });
    }

    async multi(
        actions: AnkiMultiAction[],
    ): Promise<AnkiActionResponse<AnkiActionResponse<unknown>[]>> {
        return this.send<AnkiActionResponse<unknown>[]>("multi", { actions });
    }
}

export const defaultAnkiConnectClient = new AnkiConnectClient();
