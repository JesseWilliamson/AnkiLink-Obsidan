import { RequestUrlParam } from "obsidian";
import { defaultAnkiConnectClient } from "./anki-connect/client";
import {
    AnkiActionResponse,
    AnkiMultiAction,
    Note,
    NoteFields,
    NoteInfo,
} from "./anki-connect/types";

export type { AnkiMultiAction, Note, NoteFields, NoteInfo } from "./anki-connect/types";

export enum DeckTypes {
    BASIC = "basic",
}

export const TARGET_DECK = "Obsidian 4";
export const ANKI_LINK_MODEL_NAME = "AnkiLink Basic";
const ANKI_LINK_CARD_NAME = "Card 1";
const ANKI_LINK_MODEL_FRONT_TEMPLATE = '<div class="anki-link">{{Front}}</div>';
const ANKI_LINK_MODEL_BACK_TEMPLATE =
    '<div class="anki-link">{{FrontSide}}<hr id="answer">{{Back}}</div>';
export const DEFAULT_DECK_TYPE = ANKI_LINK_MODEL_NAME;
export const ANKI_LINK_TAG = "ankiLink";

interface ConnResult {
    error: string | null;
}

export interface DeckNamesResult extends ConnResult {
    result: string[];
}

export interface CreateDeckResult extends ConnResult {
    result: number;
}

export interface ModelNamesResult extends ConnResult {
    result: string[];
}

export interface CreateModelResult extends ConnResult {
    result: null;
}

export interface UpdateModelTemplatesResult extends ConnResult {
    result: null;
}

export interface UpdateModelStylingResult extends ConnResult {
    result: null;
}

export interface AddNoteResult extends ConnResult {
    result: number;
}

export interface AddNotesResult extends ConnResult {
    result: (number | null)[];
}

export interface AddTagsResult extends ConnResult {
    result: null;
}

export interface FindNotesResult extends ConnResult {
    result: number[];
}

export interface DeleteNotesResult extends ConnResult {
    result: null;
}

export interface ChangeDeckResult extends ConnResult {
    result: null;
}

export interface NotesInfoResult extends ConnResult {
    result: unknown[];
}

export interface UpdateNoteFieldsResult extends ConnResult {
    result: null;
}

export interface MultiResult extends ConnResult {
    result: AnkiActionResponse<unknown>[];
}

/**
 * Check if a value from notesInfo is a valid note (and not an empty object
 * returned when the note was deleted in Anki).
 */
function isValidNoteInfo(obj: unknown): obj is NoteInfo {
    if (obj == null || typeof obj !== "object" || Array.isArray(obj)) {
        return false;
    }
    const o = obj as Record<string, unknown>;
    const fields = o.fields as Record<string, { value?: string }> | undefined;
    return (
        typeof o.noteId === "number" &&
        fields != null &&
        typeof fields === "object" &&
        typeof fields.Front?.value === "string" &&
        typeof fields.Back?.value === "string"
    );
}

function getFirstValidNoteInfo(result: NotesInfoResult): NoteInfo | null {
    const first = result.result[0];
    return isValidNoteInfo(first) ? first : null;
}

function assertNoError(response: ConnResult): void {
    if (response.error) {
        throw new Error(`AnkiConnect ${response.error}`);
    }
}

export async function getNoteById(noteId: number): Promise<NoteInfo | undefined> {
    const infoRes = await sendNotesInfoRequest([noteId]);
    assertNoError(infoRes);
    const note = getFirstValidNoteInfo(infoRes);
    return note ?? undefined;
}

export async function updateNoteById(noteId: number, fields: NoteFields): Promise<void> {
    const updateRes = await sendUpdateNoteFieldsRequest(noteId, fields);
    assertNoError(updateRes);
}

export function noteHasTag(note: NoteInfo, tag = ANKI_LINK_TAG): boolean {
    const normalizedTag = tag.toLowerCase();
    return note.tags.some((currentTag) => currentTag.toLowerCase() === normalizedTag);
}

export async function addTagToNotes(noteIds: number[], tag = ANKI_LINK_TAG): Promise<void> {
    if (noteIds.length === 0) return;
    const addTagsRes = await toResult(defaultAnkiConnectClient.addTags(noteIds, tag));
    assertNoError(addTagsRes);
}

async function findNotesByQuery(query: string): Promise<number[]> {
    const findNotesRes = await toResult(defaultAnkiConnectClient.findNotes(query));
    assertNoError(findNotesRes);
    return findNotesRes.result;
}

export async function findNoteIdsByTag(tag = ANKI_LINK_TAG): Promise<number[]> {
    return findNotesByQuery(`tag:${tag}`);
}

export async function findNoteIdsByTagInDeck(
    deckName: string,
    tag = ANKI_LINK_TAG,
): Promise<number[]> {
    return findNotesByQuery(`tag:${tag} deck:"${escapeQueryValue(deckName)}"`);
}

export async function noteIsInDeck(noteId: number, deckName: string): Promise<boolean> {
    const noteIds = await findNotesByQuery(`nid:${noteId} deck:"${escapeQueryValue(deckName)}"`);
    return noteIds.includes(noteId);
}

export async function moveNoteToDeck(noteId: number, deckName: string): Promise<void> {
    const note = await getNoteById(noteId);
    if (!note || !Array.isArray(note.cards) || note.cards.length === 0) {
        throw new Error(`AnkiConnect could not move note ${noteId} to deck "${deckName}"`);
    }
    const changeDeckRes = await toResult(defaultAnkiConnectClient.changeDeck(note.cards, deckName));
    assertNoError(changeDeckRes);
}

export async function deleteNotesById(noteIds: number[]): Promise<void> {
    if (noteIds.length === 0) return;
    const deleteNotesRes = await toResult(defaultAnkiConnectClient.deleteNotes(noteIds));
    assertNoError(deleteNotesRes);
}

export function buildNote(Front: string, Back: string, deckName = TARGET_DECK): Note {
    return {
        deckName,
        modelName: DEFAULT_DECK_TYPE,
        fields: { Front, Back },
        tags: [ANKI_LINK_TAG],
        options: {
            allowDuplicate: true,
        },
    };
}

export async function sendCreateDeckRequest(deck: string): Promise<CreateDeckResult> {
    return toResult(defaultAnkiConnectClient.createDeck(deck));
}

export async function sendModelNamesRequest(): Promise<ModelNamesResult> {
    return toResult(defaultAnkiConnectClient.modelNames());
}

export async function sendCreateModelRequest(
    modelName = ANKI_LINK_MODEL_NAME,
): Promise<CreateModelResult> {
    return toResult(
        defaultAnkiConnectClient.createModel({
            modelName,
            inOrderFields: ["Front", "Back"],
            css: ANKI_LINK_MODEL_CSS,
            cardTemplates: [
                {
                    Name: ANKI_LINK_CARD_NAME,
                    Front: ANKI_LINK_MODEL_FRONT_TEMPLATE,
                    Back: ANKI_LINK_MODEL_BACK_TEMPLATE,
                },
            ],
            isCloze: false,
        }),
    );
}

export async function sendUpdateModelTemplatesRequest(
    modelName = ANKI_LINK_MODEL_NAME,
): Promise<UpdateModelTemplatesResult> {
    const templates = {
        [ANKI_LINK_CARD_NAME]: {
            Front: ANKI_LINK_MODEL_FRONT_TEMPLATE,
            Back: ANKI_LINK_MODEL_BACK_TEMPLATE,
        },
    };
    return toResult(defaultAnkiConnectClient.updateModelTemplates(modelName, templates));
}

export async function sendUpdateModelStylingRequest(
    modelName = ANKI_LINK_MODEL_NAME,
): Promise<UpdateModelStylingResult> {
    return toResult(defaultAnkiConnectClient.updateModelStyling(modelName, ANKI_LINK_MODEL_CSS));
}

export async function sendAddNoteRequest(note: Note): Promise<AddNoteResult> {
    return toResult(defaultAnkiConnectClient.addNote(note));
}

export async function sendAddNotesRequest(notes: Note[]): Promise<AddNotesResult> {
    return toResult(defaultAnkiConnectClient.addNotes(notes));
}

export async function sendNotesInfoRequest(notes: number[]): Promise<NotesInfoResult> {
    return toResult(defaultAnkiConnectClient.notesInfo(notes));
}

export async function sendUpdateNoteFieldsRequest(
    id: number,
    fields: NoteFields,
): Promise<UpdateNoteFieldsResult> {
    return toResult(defaultAnkiConnectClient.updateNoteFields(id, fields));
}

export async function sendMultiRequest(actions: AnkiMultiAction[]): Promise<MultiResult> {
    return toResult(defaultAnkiConnectClient.multi(actions));
}

export async function sendDeckNamesRequest(): Promise<DeckNamesResult> {
    return toResult(defaultAnkiConnectClient.deckNames());
}

export function buildDeckNamesRequest(): RequestUrlParam {
    return {
        url: "http://localhost:8765",
        method: "POST",
        body: JSON.stringify({ action: "deckNames", version: 6 }),
    };
}

async function toResult<T>(
    promise: Promise<AnkiActionResponse<T>>,
): Promise<AnkiActionResponse<T>> {
    return promise;
}

function escapeQueryValue(value: string): string {
    return value.split('"').join(String.raw`\"`);
}

const ANKI_LINK_MODEL_CSS = `
.anki-link {
  max-width: min(72ch, 100%);
  margin: 0 auto;
  text-align: left;
}

.anki-link pre {
  background: #1e1e1e;
  color: #d4d4d4;
  padding: 0.75em 1em;
  border-radius: 8px;
  overflow-x: auto;
  white-space: pre;
  line-height: 1.4;
}

.anki-link code {
  font-family: "JetBrains Mono", "Fira Code", "Menlo", monospace;
  font-size: 0.9em;
}

.anki-link :not(pre) > code {
  background: #1e1e1e;
  color: #d4d4d4;
  padding: 0.1em 0.3em;
  border-radius: 4px;
}

.nightMode .anki-link :not(pre) > code {
  background: #121212;
  color: #f5f5f5;
}
`.trim();
